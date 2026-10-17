import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { AdminUsersService } from "../../src/modules/admin-users/admin-users.service.js";
import { identityOf, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** AdminUsersService replaces the admin account functions. */
describe("parity: admin accounts", () => {
  let db: TestDatabase;
  let admin: string;
  let superAdmin: string;
  let otherAdminEmail: string;
  let buyer: string;
  let suspended: string;
  let vendorOwner: string;
  let appeal: string;
  const reset = { pending: "", expired: "", noUser: "" };

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { role: "admin" })).id;
    superAdmin = (await seedUser(db, { role: "admin", email: "boss@test.dev" })).id;
    await db.query(`update public.users set is_super_admin = true where id = $1`, [superAdmin]);
    const other = await seedUser(db, { role: "admin", email: "helper@test.dev" });
    otherAdminEmail = other.email;
    buyer = (await seedUser(db, { email: "buyer@test.dev" })).id;
    suspended = (await seedUser(db)).id;
    vendorOwner = (await seedUser(db, { role: "vendor" })).id;
    await seedVendor(db, vendorOwner);
    await db.query(`update public.users set suspended_at = now(), suspended_reason = 'Spam' where id = $1`, [suspended]);
    const [a] = await db.query<{ id: string }>(`insert into public.account_appeals (user_id, suspension_reason, message) values ($1, 'Spam', 'Sorry') returning id`, [suspended]);
    appeal = a!.id;
    const request = async (expiresIn: string, userId: string | null) =>
      (
        await db.query<{ id: string }>(
          `insert into public.password_reset_requests (email, user_id, token_hash, expires_at) values ('buyer@test.dev', $1, 'x', now() + $2::interval) returning id`,
          [userId, expiresIn],
        )
      )[0]!.id;
    reset.pending = await request("30 minutes", buyer);
    reset.expired = await request("-1 minute", buyer);
    reset.noUser = await request("30 minutes", null);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  const port = <T>(work: (s: AdminUsersService) => Promise<T>) => runIsolated(db, (ctx) => work(new AdminUsersService(() => ctx)));
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options: Parameters<typeof comparable>[2] = {}) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  const voidResult = { result: () => null };
  const boolResult = { result: (r: unknown) => (r && typeof r === "object" && "ok" in r ? true : r) };

  describe("admin_get_pending_appeals", () => {
    it("an admin sees the same list", () => same(runOriginal(db, me(admin), "admin_get_pending_appeals"), port((s) => s.pendingAppeals(me(admin)))));
    it("FIX: anyone else is now refused (the original answered everyone)", async () => {
      for (const who of [me(buyer), null]) {
        const original = await runOriginal(db, who, "admin_get_pending_appeals");
        const ported = await port((s) => s.pendingAppeals(who));
        expect(original.result).toHaveLength(1); // the leak, as it is in production
        expect(ported.error?.message).toBe("not authorized");
      }
    });
  });

  describe("admin_deny_appeal", () => {
    for (const [label, who, id, response] of [
      ["denies with a reason (user notified)", () => admin, () => appeal, "Repeated spam"],
      ["no reason", () => admin, () => appeal, " "],
      ["unknown appeal", () => admin, () => "00000000-0000-4000-8000-000000000999", "x"],
      ["not an admin", () => buyer, () => appeal, "x"],
    ] as const) {
      it(label, () => same(runOriginal(db, me(who()), "admin_deny_appeal", { p_appeal_id: id(), p_response: response }), port((s) => s.denyAppeal(me(who()), id(), response)), voidResult));
    }
  });

  describe("admin_suspend_user / admin_unsuspend_user", () => {
    for (const [label, who, user, reason] of [
      ["suspends a vendor (shop hidden, logged, notified)", () => admin, () => vendorOwner, "Fake listings"],
      ["no reason", () => admin, () => buyer, ""],
      ["not an admin", () => buyer, () => vendorOwner, "x"],
    ] as const) {
      it(`suspend: ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_suspend_user", { p_user_id: user(), p_reason: reason }), port((s) => s.suspend(me(who()), user(), reason)), voidResult));
    }
    for (const [label, who] of [["reinstates and approves the appeal", () => admin], ["not an admin", () => buyer]] as const) {
      it(`unsuspend: ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_unsuspend_user", { p_user_id: suspended }), port((s) => s.unsuspend(me(who()), suspended)), voidResult));
    }
  });

  describe("admin_set_user_role", () => {
    for (const [label, who, email, role] of [
      ["the super admin promotes a buyer", () => superAdmin, "buyer@test.dev", "admin"],
      ["the super admin demotes an admin", () => superAdmin, () => otherAdminEmail, "buyer"],
      ["unknown email", () => superAdmin, "nobody@test.dev", "admin"],
      ["invalid role", () => superAdmin, "buyer@test.dev", "owner"],
      ["protected super admin cannot be demoted by another admin", () => admin, "boss@test.dev", "buyer"],
      ["a normal admin cannot change roles", () => admin, "buyer@test.dev", "admin"],
    ] as const) {
      it(label, () => {
        const target = typeof email === "function" ? email() : email;
        return same(runOriginal(db, me(who()), "admin_set_user_role", { target_email: target, new_role: role }), port((s) => s.setRole(me(who()), target, role)), voidResult);
      });
    }
  });

  describe("manual password reset (super admin)", () => {
    for (const [label, who] of [["super admin", () => superAdmin], ["normal admin", () => admin]] as const) {
      it(`list, ${label}`, () => same(runOriginal(db, me(who()), "admin_get_manual_password_reset_requests"), port((s) => s.resetRequests(me(who())))));
    }
    for (const [label, id] of [["pending", () => reset.pending], ["expired", () => reset.expired], ["no account", () => reset.noUser]] as const) {
      it(`approve: ${label}`, () =>
        same(runOriginal(db, me(superAdmin), "admin_approve_manual_password_reset", { p_request_id: id() }), port((s) => s.approveReset(me(superAdmin), id())), boolResult));
      it(`reject: ${label}`, () =>
        same(runOriginal(db, me(superAdmin), "admin_reject_manual_password_reset", { p_request_id: id() }), port((s) => s.rejectReset(me(superAdmin), id())), boolResult));
    }
    it("approve by a normal admin", () =>
      same(runOriginal(db, me(admin), "admin_approve_manual_password_reset", { p_request_id: reset.pending }), port((s) => s.approveReset(me(admin), reset.pending)), boolResult));
  });
});
