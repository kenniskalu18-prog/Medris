import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { AssistantService } from "../../src/modules/assistant/assistant.service.js";
import { CallsService } from "../../src/modules/calls/calls.service.js";
import { ConversationsService } from "../../src/modules/conversations/conversations.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on messages, conversations, voice_calls, ai_conversations and
 * ai_messages, against the endpoints that replace them: the browser's query (as the same user,
 * through row-level security) and the port, on the same rows.
 */
describe("parity: table queries - chat, calls and Levi history", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let blocker: string;
  let shop: string;
  let conversation: string;
  let blockedConversation: string;
  const msgs: string[] = [];
  let call: string;
  let aiChat: string;
  let strangerAiChat: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    blocker = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    const product = await seedProduct(db, shop);
    await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [product] });
    const conv = async (who: string) => (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [who, shop]))[0]!.id;
    conversation = await conv(buyer);
    blockedConversation = await conv(blocker);
    for (const [i, [who, minutesAgo]] of [
      [buyer, 30],
      [owner, 20],
      [buyer, 10],
      [owner, 1],
    ].entries()) {
      msgs.push(
        (
          await db.query<{ id: string }>(`insert into public.messages (conversation_id, sender_id, body, created_at) values ($1, $2, $3, now() - $4::interval) returning id`, [
            conversation,
            who,
            `message ${i}`,
            `${minutesAgo} minutes`,
          ])
        )[0]!.id,
      );
    }
    await db.query(`insert into public.blocked_users (blocker_id, blocked_id) values ($1, $2)`, [blocker, owner]);
    call = (
      await db.query<{ id: string }>(`insert into public.voice_calls (conversation_id, caller_id, callee_id, status) values ($1, $2, $3, 'ringing') returning id`, [conversation, buyer, owner])
    )[0]!.id;
    aiChat = (await db.query<{ id: string }>(`insert into public.ai_conversations (user_id, title) values ($1, 'Phones') returning id`, [buyer]))[0]!.id;
    strangerAiChat = (await db.query<{ id: string }>(`insert into public.ai_conversations (user_id, title) values ($1, 'Mine') returning id`, [stranger]))[0]!.id;
    await db.query(`insert into public.ai_messages (conversation_id, role, content, created_at) values ($1, 'user', 'hi', now() - interval '1 minute'), ($1, 'assistant', 'hello', now())`, [aiChat]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const chat = (ctx: DataContext) => new ConversationsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  async function bothRefused(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const [o, p] = [await original, await port];
    expect(o.error).toBeDefined();
    expect(p.error?.message).toBe(o.error?.message);
    expect(comparable(o, p).port.changes).toEqual(comparable(o, p).original.changes);
  }
  const single = (rows: unknown) => (Array.isArray(rows) ? (rows[0] ?? null) : rows);

  describe("messages", () => {
    it("newest first, limit 200; oldest first (admin view); newer than a time, limit 20", async () => {
      for (const who of [buyer, owner, stranger, admin]) {
        await same(
          runTableQuery(db, me(who), sql`select * from public.messages where conversation_id = ${conversation} order by created_at desc limit 200`),
          runIsolated(db, (ctx) => chat(ctx).messages(me(who), conversation, { order: "desc", limit: 200 })),
        );
        await same(
          runTableQuery(db, me(who), sql`select * from public.messages where conversation_id = ${conversation} order by created_at asc limit 1000`),
          runIsolated(db, (ctx) => chat(ctx).messages(me(who), conversation, { order: "asc", limit: 1000 })),
        );
      }
      const after = new Date(Date.now() - 15 * 60_000).toISOString();
      const o = await same(
        runTableQuery(db, me(buyer), sql`select * from public.messages where conversation_id = ${conversation} and created_at > ${after}::timestamptz order by created_at desc limit 20`),
        runIsolated(db, (ctx) => chat(ctx).messages(me(buyer), conversation, { order: "desc", limit: 20, after })),
      );
      expect(o.result).toHaveLength(2);
    });
    it("what replies quote", async () => {
      for (const who of [buyer, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`select id, sender_id, body, attachment_name, deleted_at from public.messages where id in (${msgs[0]!}, ${msgs[1]!})`),
          runIsolated(db, (ctx) => chat(ctx).messagePreviews(me(who), [msgs[0]!, msgs[1]!])),
        );
      }
    });
    it("send a message (and a reply with a photo); the shop is notified by the trigger", async () => {
      const o = await same(
        runTableQuery(db, me(buyer), sql`insert into public.messages (conversation_id, sender_id, body) values (${conversation}, ${buyer}, 'Is it available?') returning *`),
        runIsolated(db, (ctx) => chat(ctx).sendMessage(me(buyer), conversation, { body: "Is it available?", replyToId: null, attachment: null }).then((r) => [r])),
      );
      expect(o.changes.notifications!.inserted.length).toBeGreaterThan(0);
      await same(
        runTableQuery(
          db,
          me(owner),
          sql`insert into public.messages (conversation_id, sender_id, body, reply_to_id, attachment_url, attachment_name, attachment_type, attachment_size)
              values (${conversation}, ${owner}, '', ${msgs[0]!}, 'chat/p.jpg', 'photo.jpg', 'image/jpeg', 1200) returning *`,
        ),
        runIsolated(db, (ctx) =>
          chat(ctx)
            .sendMessage(me(owner), conversation, { body: "", replyToId: msgs[0]!, attachment: { url: "chat/p.jpg", name: "photo.jpg", type: "image/jpeg", size: 1200 } })
            .then((r) => [r]),
        ),
      );
    });
    it("refused: someone else's chat, a blocked chat, an empty message", async () => {
      await bothRefused(
        runTableQuery(db, me(stranger), sql`insert into public.messages (conversation_id, sender_id, body) values (${conversation}, ${stranger}, 'hi') returning *`),
        runIsolated(db, (ctx) => chat(ctx).sendMessage(me(stranger), conversation, { body: "hi", replyToId: null, attachment: null })),
      );
      await bothRefused(
        runTableQuery(db, me(owner), sql`insert into public.messages (conversation_id, sender_id, body) values (${blockedConversation}, ${owner}, 'hi') returning *`),
        runIsolated(db, (ctx) => chat(ctx).sendMessage(me(owner), blockedConversation, { body: "hi", replyToId: null, attachment: null })),
      );
      await bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.messages (conversation_id, sender_id, body) values (${conversation}, ${buyer}, '  ') returning *`),
        runIsolated(db, (ctx) => chat(ctx).sendMessage(me(buyer), conversation, { body: "  ", replyToId: null, attachment: null })),
      );
    });
    it("mark read (one or several), and a stranger's attempt changes nothing", async () => {
      for (const who of [owner, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`update public.messages set read_at = now(), delivered_at = now() where id in (${msgs[0]!}, ${msgs[2]!})`, false),
          runIsolated(db, (ctx) => chat(ctx).markMessagesRead(me(who), [msgs[0]!, msgs[2]!]).then(() => null)),
        );
      }
    });
    it("mark delivered: every message to the caller", () =>
      same(
        runTableQuery(db, me(buyer), sql`update public.messages set delivered_at = now() where delivered_at is null and sender_id <> ${buyer}`, false),
        runIsolated(db, (ctx) => chat(ctx).markMessagesDelivered(me(buyer)).then(() => null)),
      ));
    it("FINDING S5: the table lets a participant rewrite the other side's message; the endpoints only set read and delivery times", async () => {
      const forged = await runTableQuery(db, me(buyer), sql`update public.messages set body = 'I never said this' where id = ${msgs[1]!} returning body`);
      expect(forged.result).toEqual([{ body: "I never said this" }]);
      const port = await runIsolated(db, (ctx) => chat(ctx).markMessagesRead(me(buyer), [msgs[1]!]));
      const changed = port.changes.messages!.updated[0]!;
      expect(Object.keys(changed.after).filter((k) => JSON.stringify(changed.after[k]) !== JSON.stringify(changed.before[k])).sort()).toEqual(["delivered_at", "read_at"]);
    });
  });

  describe("conversations", () => {
    const getSql = sql`select c.id, c.buyer_id, c.vendor_id,
        (select json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url, 'user_id', v.user_id,
                                  'phone', v.phone, 'whatsapp_number', v.whatsapp_number, 'whatsapp_visible', v.whatsapp_visible)
         from public.vendors v where v.id = c.vendor_id) as vendor
      from public.conversations c`;
    it("a conversation and its shop (participants and admins; others get nothing)", async () => {
      for (const who of [buyer, owner, admin, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`${getSql} where c.id = ${conversation}`).then((o) => ({ ...o, result: single(o.result) })),
          runIsolated(db, (ctx) => chat(ctx).conversation(me(who), conversation)),
        );
      }
    });
    it("the order screens' find-then-create: existing, new (by the buyer or the shop), refused for others and admins", async () => {
      const findOrCreate = (who: string, b: string, v: string) =>
        runIsolated(db, async (ctx) => {
          const found = single(await ctx.asCaller(me(who), (tx) => tx.execute(sql`select id from public.conversations where buyer_id = ${b} and vendor_id = ${v}`).then((r) => (r as { rows: unknown[] }).rows)));
          if (found) return { id: (found as { id: string }).id, created: false };
          const made = await ctx.asCaller(me(who), (tx) => tx.execute(sql`insert into public.conversations (buyer_id, vendor_id) values (${b}, ${v}) returning id`).then((r) => (r as { rows: { id: string }[] }).rows[0]!));
          return { id: made.id, created: true };
        });
      for (const [who, b] of [
        [buyer, buyer],
        [stranger, stranger],
        [owner, stranger],
      ] as const) {
        await same(findOrCreate(who, b, shop), runIsolated(db, (ctx) => chat(ctx).direct(me(who), b, shop)));
      }
      await bothRefused(findOrCreate(stranger, buyer, uuid()), runIsolated(db, (ctx) => chat(ctx).direct(me(stranger), buyer, uuid())));
      await bothRefused(findOrCreate(admin, admin, shop), runIsolated(db, (ctx) => chat(ctx).direct(me(admin), admin, shop)));
    });
  });

  describe("voice_calls", () => {
    const calls = (ctx: DataContext) => new CallsService(() => ctx);
    it("call log, status and ringing (the caller, the callee, a stranger)", async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      for (const who of [buyer, owner, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`select id, caller_id, callee_id, status, created_at, answered_at, ended_at from public.voice_calls where conversation_id = ${conversation} order by created_at asc limit 100`),
          runIsolated(db, (ctx) => calls(ctx).callLog(me(who), conversation)),
        );
        await same(
          runTableQuery(db, me(who), sql`select status from public.voice_calls where id = ${call}`).then((o) => ({ ...o, result: { status: (single(o.result) as { status?: string } | null)?.status ?? null } })),
          runIsolated(db, (ctx) => calls(ctx).callStatus(me(who), call)),
        );
        await same(
          runTableQuery(db, me(who), sql`select id, conversation_id, created_at, caller_id from public.voice_calls where callee_id = ${who} and status = 'ringing' and created_at > ${since}::timestamptz limit 1`),
          runIsolated(db, (ctx) => calls(ctx).ringing(me(who), since)),
        );
      }
    });
  });

  describe("ai_conversations and ai_messages", () => {
    const levi = (ctx: DataContext) => new AssistantService(() => ctx);
    it("the history list (own chats only)", async () => {
      for (const who of [buyer, stranger, owner]) {
        await same(
          runTableQuery(db, me(who), sql`select id, title, updated_at from public.ai_conversations order by updated_at desc limit 50`),
          runIsolated(db, (ctx) => levi(ctx).history(me(who))),
        );
      }
    });
    it("start a chat, add messages (the chat moves up), read them back", async () => {
      await same(
        runTableQuery(db, me(buyer), sql`insert into public.ai_conversations (user_id, title) values (${buyer}, 'New chat') returning id`),
        runIsolated(db, (ctx) => levi(ctx).startConversation(me(buyer), "New chat").then((r) => [r])),
      );
      await same(
        runTableQuery(db, me(buyer), sql`insert into public.ai_messages (conversation_id, role, content) values (${aiChat}, 'user', 'cheap phones?') returning id`),
        runIsolated(db, (ctx) => levi(ctx).addMessage(me(buyer), aiChat, "user", "cheap phones?").then((r) => [r])),
      );
      for (const who of [buyer, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`select id, role, content, reaction, created_at from public.ai_messages where conversation_id = ${aiChat} order by created_at asc`),
          runIsolated(db, (ctx) => levi(ctx).conversationMessages(me(who), aiChat)),
        );
      }
      const [first] = (await db.query<{ id: string }>(`select id from public.ai_messages where conversation_id = $1 order by created_at limit 1`, [aiChat]))!;
      await same(
        runTableQuery(db, me(buyer), sql`select conversation_id, created_at from public.ai_messages where id = ${first!.id}`).then((o) => ({ ...o, result: single(o.result) })),
        runIsolated(db, (ctx) => levi(ctx).message(me(buyer), first!.id)),
      );
    });
    it("refused: a message in someone else's chat", () =>
      bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.ai_messages (conversation_id, role, content) values (${strangerAiChat}, 'user', 'x') returning id`),
        runIsolated(db, (ctx) => levi(ctx).addMessage(me(buyer), strangerAiChat, "user", "x")),
      ));
    it("delete chats (someone else's stays)", () =>
      same(
        runTableQuery(db, me(buyer), sql`delete from public.ai_conversations where id in (${aiChat}, ${strangerAiChat})`, false),
        runIsolated(db, (ctx) => levi(ctx).deleteConversations(me(buyer), [aiChat, strangerAiChat]).then(() => null)),
      ));
  });
});
