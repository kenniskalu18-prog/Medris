import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { NotificationWriter } from "../../src/database/repositories/notification-writer.repository.js";
import { AccountService } from "../../src/modules/account/account.service.js";
import { NotificationsService } from "../../src/modules/notifications/notifications.service.js";
import { identityOf, seedOrder, seedPackage, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { bothRefused, comparable, runIsolated, runOriginal, runOriginalAsService, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** create_notification() and delete_my_account(); each case runs the original and the port on the same rows. */
describe("parity: notifications and account deletion", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let vendorOwner: string;
  let stranger: string;
  let shop: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    vendorOwner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, vendorOwner)).id;
    const product = await seedProduct(db, shop);
    const pkg = await seedPackage(db, shop);
    await db.query(`insert into public.package_items (package_id, product_id, quantity) values ($1, $2, 1)`, [pkg, product]);
    const order = await seedOrder(db, buyer, shop, { productIds: [product], status: "confirmed" });
    await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', 2500, 'transfer', 'paid')`, [order]);
    await db.query(`insert into public.disputes (order_id, raised_by, reason) values ($1, 'buyer', 'late')`, [order]);
    const [conversation] = await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [buyer, shop]);
    await db.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hi'), ($1, $3, 'hello')`, [conversation!.id, buyer, vendorOwner]);
    await db.query(`insert into public.cart_items (buyer_id, product_id, quantity) values ($1, $2, 1)`, [buyer, product]);
    await db.query(`insert into public.favorites (buyer_id, product_id) values ($1, $2)`, [buyer, product]);
    await db.query(`insert into public.chat_lists (user_id, name) values ($1, 'Mine')`, [buyer]);
    await db.query(`insert into public.commission_charges (vendor_id, order_id, amount) values ($1, $2, 75)`, [shop, order]);
    await db.query(`insert into public.suggestions (sender_id, target_type, message) values ($1, 'platform', 'More shops')`, [buyer]);
    const [ai] = await db.query<{ id: string }>(`insert into public.ai_conversations (user_id, title) values ($1, 'Chat') returning id`, [buyer]);
    await db.query(`insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'hello')`, [ai!.id]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string | null) => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }

  describe("create_notification", () => {
    const write = (ctx: DataContext, n: Parameters<NotificationWriter["create"]>[0]) => ctx.asService((tx) => new NotificationWriter(tx).create(n));
    const cases: [string, () => Parameters<NotificationWriter["create"]>[0]][] = [
      ["with an actor (name and picture copied)", () => ({ userId: buyer, type: "order_note", title: "Hi", body: "Body", targetView: "orderDetail", targetParams: { orderId: "x" }, actorId: admin })],
      ["no actor, no parameters", () => ({ userId: buyer, type: "system", title: "Hi", body: null, targetView: null, targetParams: null, actorId: null })],
      ["no recipient: nothing", () => ({ userId: null, type: "system", title: "Hi", body: null, targetView: null, targetParams: null, actorId: null })],
    ];
    for (const [label, n] of cases) {
      it(label, () =>
        same(
          runOriginalAsService(db, "create_notification", {
            p_user_id: n().userId,
            p_type: n().type,
            p_title: n().title,
            p_body: n().body,
            p_target_view: n().targetView,
            p_target_params: n().targetParams,
            p_actor_id: n().actorId,
          }),
          runIsolated(db, (ctx) => write(ctx, n())),
          { result: () => null },
        ),
      );
    }
    it("FIX S2: the app's call - anyone could notify anyone; the port only notifies the caller", async () => {
      const spoof = { p_user_id: buyer, p_type: "system", p_title: "Your account is locked", p_body: "Send your password to...", p_target_view: "home", p_target_params: {}, p_actor_id: null };
      const original = await runOriginal(db, me(stranger), "create_notification", spoof);
      expect(original.changes.notifications!.inserted).toMatchObject([{ user_id: buyer }]);
      const port = await runIsolated(db, (ctx) =>
        new NotificationsService(() => ctx).notifySelf(identityOf(stranger), { type: "system", title: "Your account is locked", body: "x", targetView: "home", targetParams: {} }),
      );
      expect(port.changes.notifications!.inserted).toMatchObject([{ user_id: stranger, actor_id: null }]);
    });
  });

  describe("delete_my_account", () => {
    const account = (ctx: DataContext) => new AccountService(() => ctx);
    const cases: [string, () => string, () => string | null][] = [
      ["a buyer deletes their account", () => buyer, () => null],
      ["a vendor deletes theirs (shop, listings, orders, commission)", () => vendorOwner, () => vendorOwner],
      ["an admin deletes someone's", () => admin, () => buyer],
      ["someone else is refused", () => stranger, () => buyer],
    ];
    for (const [label, who, target] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "delete_my_account", target() ? { p_user_id: target() } : {}),
          runIsolated(db, (ctx) => account(ctx).deleteAccountData(me(who()), target())),
        ),
      );
    }
    it("signed out: refused by both", async () => {
      const a = await runOriginal(db, null, "delete_my_account", { p_user_id: buyer });
      const b = await runIsolated(db, (ctx) => account(ctx).deleteAccountData(null, buyer));
      expect(bothRefused(a, b) || a.error?.message === b.error?.message).toBe(true);
    });
    it("an account without anything", async () => {
      const lonely = (await seedUser(db)).id;
      await same(runOriginal(db, me(lonely), "delete_my_account"), runIsolated(db, (ctx) => account(ctx).deleteAccountData(me(lonely), null)));
    });
    it("an unknown account id, as an admin", () => {
      const nobody = uuid();
      return same(runOriginal(db, me(admin), "delete_my_account", { p_user_id: nobody }), runIsolated(db, (ctx) => account(ctx).deleteAccountData(me(admin), nobody)));
    });
  });
});
