import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { UsersService } from "../../src/modules/users/users.service.js";
import { identityOf, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on public.users, against the endpoints that replace them. */
describe("parity: table queries - user profiles", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let suspended: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor", name: "Dayo" })).id;
    const shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    await seedProduct(db, shop);
    suspended = (await seedUser(db, { name: "Chi" })).id;
    await db.query(`update public.users set suspended_at = now(), suspended_reason = 'Fraud', suspended_by = $2 where id = $1`, [suspended, admin]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const users = (ctx: DataContext) => new UsersService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  it("one's own profile row", async () => {
    for (const who of [buyer, owner]) await same(runTableQuery(db, me(who), sql`select * from public.users where id = ${who}`).then(single), runIsolated(db, (ctx) => users(ctx).profile(me(who))));
  });

  it("change name, phone, city, address, photo (the shop's logo follows), consent and school", async () => {
    const cases: [string, ReturnType<typeof sql>, Parameters<UsersService["updateProfile"]>[1]][] = [
      [buyer, sql`update public.users set name = 'Bola A.' where id = ${buyer}`, { name: "Bola A." }],
      [buyer, sql`update public.users set name = 'Bola', phone = '08099990000', city = 'Ibadan', address = '1 Ring Road' where id = ${buyer}`, { name: "Bola", phone: "08099990000", city: "Ibadan", address: "1 Ring Road" }],
      [owner, sql`update public.users set avatar_url = 'https://cdn.test/me.jpg' where id = ${owner}`, { avatar_url: "https://cdn.test/me.jpg" }],
      [buyer, sql`update public.users set avatar_url = null where id = ${buyer}`, { avatar_url: null }],
      [buyer, sql`update public.users set ai_data_consent = true where id = ${buyer}`, { ai_data_consent: true }],
      [owner, sql`update public.users set campus_id = 'unilag' where id = ${owner}`, { campus_id: "unilag" }],
    ];
    for (const [who, q, changes] of cases) {
      await same(runTableQuery(db, me(who), q, false), runIsolated(db, (ctx) => users(ctx).updateProfile(me(who), changes).then(() => null)));
    }
  });

  it("someone else's phone number: refused by both", async () => {
    const [{ phone }] = (await db.query<{ phone: string }>(`select phone from public.users where id = $1`, [owner])) as [{ phone: string }];
    const o = await runTableQuery(db, me(buyer), sql`update public.users set phone = ${phone} where id = ${buyer}`, false);
    const p = await runIsolated(db, (ctx) => users(ctx).updateProfile(me(buyer), { phone }));
    expect(o.error).toBeDefined();
    expect(p.error?.message).toBe(o.error?.message);
  });

  it("the role screen: the account's real role, marked as chosen", async () => {
    for (const [who, role] of [
      [buyer, "buyer"],
      [owner, "vendor"],
    ] as const) {
      await same(
        runTableQuery(db, me(who), sql`update public.users set role = ${role}::public.user_role, role_selected = true where id = ${who}`, false),
        runIsolated(db, (ctx) => users(ctx).selectRole(me(who)).then(() => null)),
      );
    }
    const o = await runTableQuery(db, me(buyer), sql`update public.users set role = 'vendor', role_selected = true where id = ${buyer}`, false);
    expect(o.error?.message).toBe("Your account role is controlled by vendor verification status.");
  });

  it("FINDING S9: a suspended user can lift their own suspension (and an admin can make themselves super admin); the endpoint changes only profile fields", async () => {
    const lifted = await runTableQuery(db, me(suspended), sql`update public.users set suspended_at = null, suspended_reason = null where id = ${suspended} returning suspended_at`);
    expect(lifted.result).toEqual([{ suspended_at: null }]);
    const promoted = await runTableQuery(db, me(admin), sql`update public.users set is_super_admin = true where id = ${admin} returning is_super_admin`);
    expect(promoted.result).toEqual([{ is_super_admin: true }]);
    const port = await runIsolated(db, (ctx) => users(ctx).updateProfile(me(suspended), { suspended_at: null, is_super_admin: true } as never));
    expect(port.changes.users!.updated).toEqual([]);
  });

  describe("admin screens", () => {
    it("people counts, the directory, the admins, people by id (others see only themselves)", async () => {
      for (const who of [admin, buyer]) {
        await same(
          runTableQuery(
            db,
            me(who),
            sql`select (select count(*)::int from public.users) as total_users, (select count(*)::int from public.users where role = 'buyer') as buyers,
                       (select count(*)::int from public.users where role = 'vendor') as vendors, (select count(*)::int from public.products where status = 'active') as active_products`,
          ).then(single),
          runIsolated(db, (ctx) => users(ctx).counts(me(who))),
        );
        await same(
          runTableQuery(db, me(who), sql`select id, name, email, phone, role, city, created_at, suspended_at, suspended_reason from public.users order by created_at desc`),
          runIsolated(db, (ctx) => users(ctx).people(me(who))),
        );
        await same(runTableQuery(db, me(who), sql`select id, name, email from public.users where role = 'admin' order by name`), runIsolated(db, (ctx) => users(ctx).admins(me(who))));
        await same(
          runTableQuery(db, me(who), sql`select id, name, email, phone, role from public.users where id in (${buyer}, ${owner})`),
          runIsolated(db, (ctx) => users(ctx).byIds(me(who), [buyer, owner])),
        );
      }
    });
  });
});
