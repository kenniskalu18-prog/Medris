import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { AccountService } from "../../src/modules/account/account.service.js";
import { identityOf, seedUser, seedVendor } from "../support/fixtures.js";
import { bothRefused, comparable, runIsolated, runOriginal, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** AccountService replaces the account functions (terms, role, appeals, sign-in log, manual password reset). */
describe("parity: account", () => {
  let db: TestDatabase;
  let buyer: string;
  let suspended: string;
  let busy: string;
  let staleVendor: string;
  let admin: string;
  let superAdmin: string;
  const reset = { approved: "", pending: "", expiredPending: "", expiredApproved: "", noUser: "" };
  const TOKEN = "secret-token-123";
  const passwordCalls: [string, string][] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db, { email: "buyer@test.dev" })).id;
    suspended = (await seedUser(db)).id;
    busy = (await seedUser(db)).id;
    admin = (await seedUser(db, { role: "admin" })).id;
    superAdmin = (await seedUser(db, { role: "admin" })).id;
    await db.query(`update public.users set is_super_admin = true where id = $1`, [superAdmin]);
    // A "vendor" whose shop was deleted: sync_current_account_role turns them back into a buyer.
    staleVendor = (await seedUser(db, { role: "vendor" })).id;
    const shop = await seedVendor(db, staleVendor);
    await db.query(`update public.vendors set deleted_at = now() where id = $1`, [shop.id]);
    await db.query(`update public.users set role = 'vendor' where id = $1`, [staleVendor]).catch(() => undefined);
    for (const id of [suspended, busy]) await db.query(`update public.users set suspended_at = now(), suspended_reason = 'Spam' where id = $1`, [id]);
    await db.query(`insert into public.account_appeals (user_id, suspension_reason, message) values ($1, 'Spam', 'Sorry')`, [busy]);
    await db.query(`update public.users set legal_terms_version = '2025-01-01', legal_terms_accepted_at = now() where id = $1`, [buyer]);
    const request = async (status: string, expiresIn: string, userId: string | null) => {
      const [row] = await db.query<{ id: string }>(
        `insert into public.password_reset_requests (email, user_id, status, token_hash, expires_at)
         values ('buyer@test.dev', $1, $2, encode(extensions.digest($3, 'sha256'), 'hex'), now() + $4::interval) returning id`,
        [userId, status, TOKEN, expiresIn],
      );
      return row!.id;
    };
    reset.approved = await request("approved", "30 minutes", buyer);
    reset.pending = await request("pending", "30 minutes", buyer);
    reset.expiredPending = await request("pending", "-5 minutes", buyer);
    reset.expiredApproved = await request("approved", "-5 minutes", buyer);
    reset.noUser = await request("approved", "30 minutes", null);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  const service = (ctx: Parameters<Parameters<typeof runIsolated>[1]>[0]) =>
    new AccountService(() => ctx, async (userId, password) => {
      passwordCalls.push([userId, password]);
      return { ok: true };
    });
  const port = <T>(work: (s: AccountService) => Promise<T>) => runIsolated(db, (ctx) => work(service(ctx)));
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options: Parameters<typeof comparable>[2] = {}) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  const done = { result: () => null };

  for (const [label, who] of [["signed in", () => buyer], ["signed out", () => null]] as const) {
    it(`accept_legal_terms, ${label}`, () => same(runOriginal(db, me(who()), "accept_legal_terms"), port((s) => s.acceptLegalTerms(me(who())))));
    it(`get_legal_terms_consent, ${label}`, () => same(runOriginal(db, me(who()), "get_legal_terms_consent"), port((s) => s.legalTermsConsent(me(who())))));
  }

  for (const [label, who] of [["a vendor whose shop was deleted", () => staleVendor], ["an admin", () => admin], ["a buyer", () => buyer]] as const) {
    it(`sync_current_account_role: ${label}`, () =>
      same(runOriginal(db, me(who()), "sync_current_account_role"), port((s) => s.syncRole(me(who())).then((r) => r.role))));
  }
  it("sync_current_account_role: signed out is refused by both", async () => {
    expect(bothRefused(await runOriginal(db, null, "sync_current_account_role"), await port((s) => s.syncRole(null)))).toBe(true);
  });

  for (const [label, who] of [["with a pending appeal", () => busy], ["without", () => buyer], ["signed out", () => null]] as const) {
    it(`get_my_account_appeal ${label}`, () => same(runOriginal(db, me(who()), "get_my_account_appeal"), port((s) => s.myAppeal(me(who())))));
  }

  describe("submit_account_appeal", () => {
    for (const [label, who, message] of [
      ["a suspended user (admins notified)", () => suspended, "Please review"],
      ["already has a pending appeal", () => busy, "Again"],
      ["not suspended", () => buyer, "Hi"],
      ["empty message", () => suspended, "  "],
      ["signed out", () => null, "Hi"],
    ] as const) {
      it(label, () => same(runOriginal(db, me(who()), "submit_account_appeal", { p_message: message }), port((s) => s.submitAppeal(me(who()), message)), done));
    }
  });

  describe("record_auth_activity", () => {
    for (const [label, who, event] of [
      ["login", () => buyer, "login"],
      ["unknown event", () => buyer, "hack"],
      ["signed out", () => null, "login"],
    ] as const) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "record_auth_activity", { p_event_type: event, p_user_agent: "Mozilla/5.0 test" }),
          port((s) => s.recordAuthActivity(me(who()), event, "Mozilla/5.0 test")),
          done,
        ),
      );
    }
  });

  describe("get_manual_password_reset_status", () => {
    for (const [label, id, token] of [
      ["approved", () => reset.approved, TOKEN],
      ["pending, expired (marked expired)", () => reset.expiredPending, TOKEN],
      ["wrong token", () => reset.approved, "nope"],
      ["no token", () => reset.approved, null],
    ] as const) {
      it(label, () =>
        same(runOriginal(db, null, "get_manual_password_reset_status", { p_request_id: id(), p_token: token }), port((s) => s.resetStatus(id(), token))),
      );
    }
  });

  describe("complete_manual_password_reset (the password itself goes through the Auth admin API)", () => {
    for (const [label, id, token, password] of [
      ["approved request", () => reset.approved, TOKEN, "new-password-1"],
      ["not approved yet", () => reset.pending, TOKEN, "new-password-1"],
      ["expired", () => reset.expiredApproved, TOKEN, "new-password-1"],
      ["no account", () => reset.noUser, TOKEN, "new-password-1"],
      ["wrong token", () => reset.approved, "nope", "new-password-1"],
      ["too short", () => reset.approved, TOKEN, "short"],
    ] as const) {
      it(label, async () => {
        passwordCalls.length = 0;
        const a = await same(
          runOriginal(db, null, "complete_manual_password_reset", { p_request_id: id(), p_token: token, p_new_password: password }),
          port((s) => s.completeReset(id(), token, password).then(() => true)),
        );
        expect(passwordCalls).toEqual(a.error ? [] : [[buyer, password]]);
      });
    }
  });

  describe("request_manual_password_reset", () => {
    const opts = { result: (r: unknown) => (r && typeof r === "object" ? Object.keys(r).sort() : r), volatile: ["token_hash"] };
    for (const [label, email] of [
      ["known email (each admin notified)", " Buyer@Test.dev "],
      ["unknown email", "nobody@test.dev"],
      ["invalid email", "@x"],
    ] as const) {
      it(label, () => same(runOriginal(db, null, "request_manual_password_reset", { p_email: email }), port((s) => s.requestReset(email)), opts));
    }
  });
});
