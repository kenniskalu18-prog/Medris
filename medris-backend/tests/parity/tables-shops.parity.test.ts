import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import type { ShopListFilter } from "../../src/database/repositories/shop-rows.repository.js";
import { ShopsService } from "../../src/modules/shops/shops.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on vendors (shops), against the endpoints that replace them. */
describe("parity: table queries - shops", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let applicant: string;
  let shop: string;
  let hiddenWa: string;
  let pending: string;

  // Columns the public endpoints leave out (BASELINE_FINDINGS S12).
  const PRIVATE = [
    "verification_docs",
    "bank_code",
    "bank_name",
    "account_number",
    "account_name",
    "paystack_subaccount_code",
    "commission_pct",
    "transfer_recipient_code",
    "billing_model",
    "paystack_authorization_code",
    "paystack_customer_code",
    "monthly_billing_status",
    "next_monthly_charge_at",
    "commission_paused",
    "commission_pause_reason",
    "deleted_previous_verification_status",
    "deleted_previous_is_active",
    "admin_paused",
    "request_campus_scope",
  ];
  const publicView = (row: Record<string, unknown> | null) => {
    if (!row) return row;
    const out = Object.fromEntries(Object.entries(row).filter(([k]) => !PRIVATE.includes(k)));
    if (!out.whatsapp_visible) out.whatsapp_number = null;
    return out;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    applicant = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    hiddenWa = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Efe Rentals" })).id;
    pending = (await seedVendor(db, applicant, { name: "New Place", verified: false })).id;
    await db.query(`update public.vendors set whatsapp_visible = true, paystack_authorization_code = 'AUTH_secret', cac_number = 'RC123', student_verified = true where id = $1`, [shop]);
    await db.query(`update public.vendors set whatsapp_visible = false where id = $1`, [hiddenWa]);
    await seedOrder(db, buyer, shop, { productIds: [await seedProduct(db, shop)] });
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const shops = (ctx: DataContext) => new ShopsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  it("one's own shop (every column)", async () => {
    for (const who of [owner, applicant, buyer]) {
      await same(runTableQuery(db, me(who), sql`select v.* from public.vendors v where v.user_id = ${who} and v.deleted_at is null limit 1`).then(single), runIsolated(db, (ctx) => shops(ctx).mine(me(who))));
    }
  });

  describe("one shop", () => {
    const withSector = (id: string, extra = sql``) =>
      sql`select to_jsonb(v) || jsonb_build_object('sector', (select json_build_object('name', s.name, 'icon', s.icon) from public.sectors s where s.id = v.sector_id)) as shop
          from public.vendors v where v.id = ${id} ${extra}`;
    const shopOf = (o: RunOutcome) => ({ ...o, result: ((o.result as { shop: Record<string, unknown> }[] | undefined)?.[0]?.shop ?? null) as Record<string, unknown> | null });
    it("its owner and admins get every column", async () => {
      for (const [who, id] of [
        [owner, shop],
        [admin, shop],
        [applicant, pending],
      ] as const) {
        await same(runTableQuery(db, me(who), withSector(id)).then(shopOf), runIsolated(db, (ctx) => shops(ctx).shop(me(who), id, { verified: false, active: false })));
      }
    });
    it("FIX S12: everyone else gets the public columns only (the table gave anyone the bank account and Paystack card authorization)", async () => {
      for (const who of [buyer, null]) {
        for (const id of [shop, hiddenWa, pending]) {
          const original = shopOf(await runTableQuery(db, who ? me(who) : null, withSector(id)));
          const port = await runIsolated(db, (ctx) => shops(ctx).shop(who ? me(who) : null, id, { verified: false, active: false }));
          expect(port.result).toEqual(publicView(original.result));
          if (id === shop) expect(original.result).toMatchObject({ paystack_authorization_code: "AUTH_secret", account_number: "0123456789" });
        }
      }
    });
    it("verified (and active) only", async () => {
      for (const id of [shop, pending]) {
        const original = shopOf(await runTableQuery(db, me(applicant), withSector(id, sql`and v.verification_status = 'verified' and v.is_active = true`)));
        const port = await runIsolated(db, (ctx) => shops(ctx).shop(me(applicant), id, { verified: true, active: true }));
        expect(port.result).toEqual(id === pending ? null : publicView(original.result));
      }
    });
  });

  describe("shop lists", () => {
    const base: ShopListFilter = { ids: null, sectorId: null, q: null, studentVerified: false, anyStatus: false, orderBy: "none", limit: 1000, offset: 0 };
    const cases: [string, ShopListFilter, ReturnType<typeof sql>][] = [
      ["the shops page (by name)", { ...base, orderBy: "name" }, sql`v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null order by v.business_name`],
      ["search by name", { ...base, q: "dayo", limit: 8 }, sql`v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null and v.business_name ilike '%dayo%' limit 8`],
      ["student-verified", { ...base, studentVerified: true }, sql`v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null and v.student_verified = true`],
    ];
    for (const [label, filter, where] of cases) {
      it(label, async () => {
        const original = await runTableQuery(db, null, sql`select to_jsonb(v) as shop from public.vendors v where ${where}`);
        const port = await runIsolated(db, (ctx) => shops(ctx).shops(null, filter));
        expect(port.result).toEqual((original.result as { shop: Record<string, unknown> }[]).map((r) => publicView(r.shop)));
      });
    }
    it("by ids, any status the caller may see (a buyer sees the shop they ordered from)", async () => {
      const original = await runTableQuery(db, me(buyer), sql`select to_jsonb(v) as shop from public.vendors v where v.id in (${shop}, ${pending})`);
      const port = await runIsolated(db, (ctx) => shops(ctx).shops(me(buyer), { ...base, ids: [shop, pending], anyStatus: true }));
      expect(port.result).toEqual((original.result as { shop: Record<string, unknown> }[]).map((r) => publicView(r.shop)));
      expect(port.result).toHaveLength(1);
    });
    it("the admin's applications and recycle bin", async () => {
      for (const who of [admin, buyer]) {
        for (const [deleted, status] of [
          [false, "pending"],
          [false, null],
          [true, null],
        ] as const) {
          await same(
            runTableQuery(
              db,
              me(who),
              sql`select v.id, v.business_name, v.address, v.city, v.phone, v.whatsapp_number, v.cac_number, v.bio, v.verification_docs, v.verification_status, v.avg_rating, v.review_count,
                         v.created_at, v.deleted_at, v.deleted_previous_verification_status, v.deleted_previous_is_active,
                         (select json_build_object('name', u.name, 'email', u.email) from public.users u where u.id = v.user_id) as applicant
                  from public.vendors v where ${deleted ? sql`v.deleted_at is not null` : sql`v.deleted_at is null`} ${status ? sql`and v.verification_status::text = ${status}` : sql``}
                  order by ${deleted ? sql`v.deleted_at desc` : sql`v.created_at desc`}`,
            ),
            runIsolated(db, (ctx) => shops(ctx).adminShops(me(who), deleted, status)),
          );
        }
      }
    });
  });

  describe("the owner changes the shop", () => {
    it("profile, hours, logo, location, WhatsApp, campus settings (the renaming notice and phone checks run)", async () => {
      const cases: [ReturnType<typeof sql>, Parameters<ShopsService["updateMine"]>[1]][] = [
        [sql`business_name = 'Dayo Phones', bio = 'Best phones', city = 'Lagos', allow_after_hours_messages = false`, { business_name: "Dayo Phones", bio: "Best phones", city: "Lagos", allow_after_hours_messages: false }],
        [sql`logo_url = 'https://cdn.test/l.jpg', cover_url = null`, { logo_url: "https://cdn.test/l.jpg", cover_url: null }],
        [sql`lat = 6.45, lng = 3.39`, { lat: 6.45, lng: 3.39 }],
        [sql`whatsapp_visible = false`, { whatsapp_visible: false }],
        [sql`request_pref = 'sector', operating_scope = 'campus', operating_campuses = '{unilag,lasu}'::text[], campus_setup_done = true`, { request_pref: "sector", operating_scope: "campus", operating_campuses: ["unilag", "lasu"], campus_setup_done: true }],
        [sql`business_hours = '{"mon":{"open":"09:00","close":"17:00"}}'::jsonb, opening_hours = 'Mon 9-5'`, { business_hours: { mon: { open: "09:00", close: "17:00" } }, opening_hours: "Mon 9-5" }],
      ];
      for (const [set, changes] of cases) {
        await same(runTableQuery(db, me(owner), sql`update public.vendors set ${set} where id = ${shop}`, false), runIsolated(db, (ctx) => shops(ctx).updateMine(me(owner), changes).then(() => null)));
      }
    });
    it("payout account", () =>
      same(
        runTableQuery(db, me(owner), sql`update public.vendors set bank_code = '044', bank_name = 'Access', account_name = 'Dayo', account_number = '0011223344', paystack_subaccount_code = 'ACCT_1' where id = ${shop}`, false),
        runIsolated(db, (ctx) => shops(ctx).setPayout(me(owner), { bank_code: "044", bank_name: "Access", account_name: "Dayo", account_number: "0011223344", paystack_subaccount_code: "ACCT_1" }).then(() => null)),
      ));
    it("documents must be in one's own folder", async () => {
      const bad = await runIsolated(db, (ctx) => shops(ctx).updateMine(me(applicant), { verification_docs: [`${owner}/id.jpg`] }));
      expect(bad.error?.message).toBe("Documents must be files uploaded to your own folder.");
      await same(
        runTableQuery(db, me(applicant), sql`update public.vendors set verification_docs = ${`{${applicant}/id.jpg}`}::text[] where id = ${pending}`, false),
        runIsolated(db, (ctx) => shops(ctx).updateMine(me(applicant), { verification_docs: [`${applicant}/id.jpg`] }).then(() => null)),
      );
    });
    it("withdrawing an application removes nothing (the table does not allow it), as before", () =>
      same(runTableQuery(db, me(applicant), sql`delete from public.vendors where id = ${pending} and user_id = ${applicant}`, false), runIsolated(db, (ctx) => shops(ctx).removeApplication(me(applicant), pending).then(() => null))));
    it("FINDING S11: an applicant can verify their own shop through the table (and lift admin pauses, set ratings); the endpoint cannot", async () => {
      const selfVerified = await runTableQuery(
        db,
        me(applicant),
        sql`update public.vendors set verification_status = 'verified', bank_code = '044', bank_name = 'Access', account_number = '0011223344', avg_rating = 5, review_count = 999 where id = ${pending} returning verification_status, avg_rating`,
      );
      expect(selfVerified.result).toEqual([{ verification_status: "verified", avg_rating: 5 }]);
      const port = await runIsolated(db, (ctx) => shops(ctx).updateMine(me(applicant), { verification_status: "verified", avg_rating: 5 } as never));
      expect(port.result).toEqual({ updated: 0 });
      expect(port.changes.vendors!.updated).toEqual([]);
    });
  });
});
