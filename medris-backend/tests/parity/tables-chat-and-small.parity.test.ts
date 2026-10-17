import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { BlocksService } from "../../src/modules/blocks/blocks.service.js";
import { ConversationsService } from "../../src/modules/conversations/conversations.service.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { NotificationsService } from "../../src/modules/notifications/notifications.service.js";
import { OrderActionsService } from "../../src/modules/order-actions/order-actions.service.js";
import { PointsService } from "../../src/modules/points/points.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on blocked_users, message_pins, push_subscriptions, comment_reports,
 * order_notes and points_rules, against the endpoints that replace them. Each case runs the query the
 * browser sent (as the same user, through row-level security) and the port on the same rows.
 */
describe("parity: table queries - blocks, message pins, push, comment reports, order notes, points rules", () => {
  let db: TestDatabase;
  let buyer: string;
  let other: string;
  let owner: string;
  let stranger: string;
  let shop: string;
  let conversation: string;
  let otherConversation: string;
  const messages: string[] = [];
  let strangerMessage: string;
  let order: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db, { name: "Bola" })).id;
    other = (await seedUser(db, { name: "Chi" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    const product = await seedProduct(db, shop);
    order = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [product] });
    const conv = async (who: string) => (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [who, shop]))[0]!.id;
    conversation = await conv(buyer);
    otherConversation = await conv(stranger);
    for (let i = 0; i < 6; i += 1) {
      messages.push((await db.query<{ id: string }>(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, $3) returning id`, [conversation, buyer, `m${i}`]))[0]!.id);
    }
    strangerMessage = (await db.query<{ id: string }>(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'x') returning id`, [otherConversation, stranger]))[0]!.id;
    for (const [i, m] of messages.slice(0, 3).entries()) {
      await db.query(`insert into public.message_pins (user_id, conversation_id, message_id, pinned_at) values ($1, $2, $3, now() - $4::interval)`, [buyer, conversation, m, `${i} minutes`]);
    }
    await db.query(`insert into public.blocked_users (blocker_id, blocked_id) values ($1, $2)`, [buyer, stranger]);
    await db.query(`insert into public.order_notes (order_id, sender_id, body, created_at) values ($1, $2, 'Please call', now() - interval '1 hour'), ($1, $3, 'On my way', now())`, [order, buyer, owner]);
    await db.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key) values ($1, 'https://push.test/other', 'k', 'a')`, [other]);
    await db.query(`
      insert into public.points_rules (kind, label, description, points, sort_order, active) values
        ('order_completed', 'Order completed', 'A sale', 20, 2, true),
        ('product_listed', 'New listing', 'A listing', 5, 1, true),
        ('retired_rule', 'Old', 'Old', 1, 0, false)`);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  /** Both refused (the messages differ: PostgREST's vs the endpoint's), and nothing changed. */
  async function bothRefused(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const [o, p] = [await original, await port];
    expect(o.error).toBeDefined();
    expect(p.error?.message).toBe(o.error?.message);
    expect(comparable(o, p).port.changes).toEqual(comparable(o, p).original.changes);
  }

  describe("blocked_users", () => {
    const blocks = (ctx: DataContext) => new BlocksService(() => ctx);
    it("list: select blocked_id where blocker_id = me", async () => {
      for (const who of [buyer, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`select blocked_id from public.blocked_users where blocker_id = ${who}`),
          runIsolated(db, (ctx) => blocks(ctx).list(me(who)).then((r) => r.blockedIds.map((blocked_id) => ({ blocked_id })))),
        );
      }
    });
    it("state: maybeSingle (blocked, not blocked, and the other side cannot see it)", async () => {
      for (const [who, target] of [
        [buyer, stranger],
        [buyer, owner],
        [stranger, buyer],
      ] as const) {
        await same(
          runTableQuery(db, me(who), sql`select blocked_id from public.blocked_users where blocker_id = ${who} and blocked_id = ${target}`),
          runIsolated(db, (ctx) => blocks(ctx).state(me(who), target).then((r) => (r.blocked ? [{ blocked_id: target }] : []))),
        );
      }
    });
    it("block someone", () =>
      same(
        runTableQuery(db, me(buyer), sql`insert into public.blocked_users (blocker_id, blocked_id) values (${buyer}, ${owner})`, false),
        runIsolated(db, (ctx) => blocks(ctx).block(me(buyer), owner).then(() => null)),
      ));
    it("block oneself: refused by row-level security", () =>
      bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.blocked_users (blocker_id, blocked_id) values (${buyer}, ${buyer})`, false),
        runIsolated(db, (ctx) => blocks(ctx).block(me(buyer), buyer)),
      ));
    it("block someone already blocked: refused (primary key)", () =>
      bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.blocked_users (blocker_id, blocked_id) values (${buyer}, ${stranger})`, false),
        runIsolated(db, (ctx) => blocks(ctx).block(me(buyer), stranger)),
      ));
    it("unblock (and unblocking someone not blocked changes nothing)", async () => {
      for (const target of [stranger, owner]) {
        await same(
          runTableQuery(db, me(buyer), sql`delete from public.blocked_users where blocker_id = ${buyer} and blocked_id = ${target}`, false),
          runIsolated(db, (ctx) => blocks(ctx).unblock(me(buyer), target).then(() => null)),
        );
      }
    });
  });

  describe("message_pins", () => {
    const chat = (ctx: DataContext) => new ConversationsService(() => ctx);
    const listSql = (who: string, conv: string) =>
      sql`select id, conversation_id, message_id, pinned_at, expires_at from public.message_pins where conversation_id = ${conv} and user_id = ${who} order by pinned_at desc limit 4`;
    it("list (newest first; others see nothing)", async () => {
      for (const [who, conv] of [
        [buyer, conversation],
        [owner, conversation],
        [stranger, conversation],
      ] as const) {
        await same(runTableQuery(db, me(who), listSql(who, conv)), runIsolated(db, (ctx) => chat(ctx).messagePins(me(who), conv)));
      }
    });
    const insert = (who: string, conv: string, message: string) =>
      sql`insert into public.message_pins (user_id, conversation_id, message_id) values (${who}, ${conv}, ${message})`;
    it("pin a fourth message", () =>
      same(runTableQuery(db, me(buyer), insert(buyer, conversation, messages[3]!), false), runIsolated(db, (ctx) => chat(ctx).pinMessage(me(buyer), conversation, messages[3]!).then(() => null))));
    it("the shop's owner pins in the same chat", () =>
      same(runTableQuery(db, me(owner), insert(owner, conversation, messages[0]!), false), runIsolated(db, (ctx) => chat(ctx).pinMessage(me(owner), conversation, messages[0]!).then(() => null))));
    it("a fifth pin: refused by the database's limit", () =>
      bothRefused(
        // two requests from the browser: two transactions, the first one kept
        runIsolated(db, async (ctx) => {
          await ctx.asCaller(me(buyer), (tx) => tx.execute(insert(buyer, conversation, messages[3]!)));
          return ctx.asCaller(me(buyer), (tx) => tx.execute(insert(buyer, conversation, messages[4]!)));
        }),
        runIsolated(db, async (ctx) => (await chat(ctx).pinMessage(me(buyer), conversation, messages[3]!), chat(ctx).pinMessage(me(buyer), conversation, messages[4]!))),
      ));
    it("a message of someone else's chat: refused by row-level security", () =>
      bothRefused(
        runTableQuery(db, me(buyer), insert(buyer, otherConversation, strangerMessage), false),
        runIsolated(db, (ctx) => chat(ctx).pinMessage(me(buyer), otherConversation, strangerMessage)),
      ));
    it("unpin", () =>
      same(
        runTableQuery(db, me(buyer), sql`delete from public.message_pins where user_id = ${buyer} and conversation_id = ${conversation} and message_id = ${messages[0]!}`, false),
        runIsolated(db, (ctx) => chat(ctx).unpinMessage(me(buyer), conversation, messages[0]!).then(() => null)),
      ));
  });

  describe("push_subscriptions", () => {
    const upsert = (who: string, endpoint: string, key: string) =>
      sql`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key) values (${who}, ${endpoint}, ${key}, 'auth')
          on conflict (endpoint) do update set user_id = excluded.user_id, endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth_key = excluded.auth_key`;
    const save = (ctx: DataContext, who: string, endpoint: string, key: string) =>
      new NotificationsService(() => ctx).savePushSubscription(me(who), { endpoint, p256dh: key, auth: "auth" }).then(() => null);
    it("a new phone", () => same(runTableQuery(db, me(buyer), upsert(buyer, "https://push.test/new", "k1"), false), runIsolated(db, (ctx) => save(ctx, buyer, "https://push.test/new", "k1"))));
    it("the same phone again, with new keys", () =>
      same(
        runIsolated(db, (ctx) => ctx.asCaller(me(other), (tx) => tx.execute(upsert(other, "https://push.test/other", "k2")).then(() => null))),
        runIsolated(db, (ctx) => save(ctx, other, "https://push.test/other", "k2")),
      ));
    it("a phone saved for another account: refused", () =>
      bothRefused(runTableQuery(db, me(buyer), upsert(buyer, "https://push.test/other", "k3"), false), runIsolated(db, (ctx) => save(ctx, buyer, "https://push.test/other", "k3"))));
  });

  describe("comment_reports", () => {
    const comment = uuid();
    const report = (ctx: DataContext, kind: "product" | "package") => new EngagementService(() => ctx).reportComment(me(buyer), kind, comment, "Spam or advert");
    it("report a comment", () =>
      same(
        runTableQuery(db, me(buyer), sql`insert into public.comment_reports (kind, comment_id, reason) values ('product', ${comment}, 'Spam or advert')`, false),
        runIsolated(db, (ctx) => report(ctx, "product").then(() => null)),
      ));
    it("the same comment twice: the first report stays (the app ignored the duplicate error)", async () => {
      const original = await runIsolated(db, (ctx) =>
        ctx.asCaller(me(buyer), async (tx) => {
          const q = sql`insert into public.comment_reports (kind, comment_id, reason) values ('package', ${comment}, 'Spam or advert')`;
          await tx.execute(q);
          return tx.transaction((sp) => sp.execute(q)).then(
            () => "no error",
            (e: { message?: string; cause?: { message?: string } }) => (/duplicate|unique/i.test(e.cause?.message ?? e.message ?? "") ? "duplicate" : "other"),
          );
        }),
      );
      expect(original.result).toBe("duplicate");
      const port = await runIsolated(db, async (ctx) => (await report(ctx, "package"), report(ctx, "package")));
      expect(port.result).toEqual({ reported: true, alreadyReported: true });
      expect(comparable(port, original).port.changes).toEqual(comparable(port, original).original.changes);
    });
  });

  describe("order_notes", () => {
    it("the buyer, the shop's owner and a stranger", async () => {
      for (const who of [buyer, owner, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`select id, sender_id, body, created_at from public.order_notes where order_id = ${order} order by created_at asc limit 60`),
          runIsolated(db, (ctx) => new OrderActionsService(() => ctx).notes(me(who), order)),
        );
      }
    });
  });

  describe("points_rules", () => {
    it("signed in and signed out: the active rules in display order", async () => {
      for (const who of [buyer, null]) {
        const o = await same(
          runTableQuery(db, who ? me(who) : null, sql`select * from public.points_rules where active = true order by sort_order`),
          runIsolated(db, (ctx) => new PointsService(() => ctx).rules(who ? me(who) : null)),
        );
        expect((o.result as { kind: string }[]).map((r) => r.kind)).toEqual(["product_listed", "order_completed"]);
      }
    });
  });
});
