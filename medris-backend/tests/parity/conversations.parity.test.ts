import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { CallsService } from "../../src/modules/calls/calls.service.js";
import { ConversationsService } from "../../src/modules/conversations/conversations.service.js";
import { PresenceService } from "../../src/modules/presence/presence.service.js";
import { identityOf, seedOrder, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * ConversationsService, CallsService and PresenceService replace the chat, call and presence
 * functions; each case runs the original and the port on the same rows.
 */
describe("parity: conversations, calls and presence", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let shop: string;
  let closedShop: string;
  let quietShop: string;
  let chat: string;
  let closedChat: string;
  let quietChat: string;
  let recentFromBuyer: string;
  let recentFromOwner: string;
  let oldFromBuyer: string;
  let deletedFromBuyer: string;
  let list: string;
  let ringing: string;
  let answered: string;
  let othersRinging: string;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    // What the database functions have written into them (export.sh replaces the real secret).
    process.env.EMAIL_WEBHOOK_SECRET = "<WEBHOOK_SECRET>";
    delete process.env.APP_ORIGIN;
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola Buyer" })).id;
    owner = (await seedUser(db, { role: "vendor", name: "Ola Owner" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Ola Phones" })).id;
    closedShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Closed Shop" })).id;
    quietShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Quiet Shop" })).id;
    await db.query(`update auth.users set last_sign_in_at = now() - interval '2 days' where id = $1`, [owner]);
    await db.query(`update auth.users set last_sign_in_at = now() - interval '1 minute' where id = $1`, [buyer]);

    // Chat is open with `shop` (confirmed order), closed with `closedShop` (only a pending order), and
    // `quietShop` has messages but no order at all (callable, not open).
    await seedOrder(db, buyer, shop, { status: "confirmed" });
    await seedOrder(db, buyer, closedShop, { status: "pending" });
    const conversation = async (vendor: string) =>
      (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id, pinned_by_vendor) values ($1, $2, true) returning id`, [buyer, vendor]))[0]!.id;
    chat = await conversation(shop);
    closedChat = await conversation(closedShop);
    quietChat = await conversation(quietShop);
    const message = async (conv: string, sender: string, body: string, age: string, extra = "") =>
      (
        await db.query<{ id: string }>(
          `insert into public.messages (conversation_id, sender_id, body, created_at${extra ? ", deleted_at" : ""}) values ($1, $2, $3, now() - $4::interval${extra ? ", now()" : ""}) returning id`,
          [conv, sender, body, age],
        )
      )[0]!.id;
    oldFromBuyer = await message(chat, buyer, "Is it still available?", "2 hours");
    recentFromOwner = await message(chat, owner, "Yes, ₦250,000", "5 minutes");
    recentFromBuyer = await message(chat, buyer, "Great, I'll take it", "1 minute");
    deletedFromBuyer = await message(chat, buyer, "oops", "2 minutes", "deleted");
    await message(quietChat, buyer, "Hello?", "3 days");
    await db.query(`update public.messages set reactions = jsonb_build_object($2::text, '👍') where id = $1`, [recentFromOwner, buyer]);

    list = (await db.query<{ id: string }>(`insert into public.chat_lists (user_id, name) values ($1, 'Phones') returning id`, [buyer]))[0]!.id;
    await db.query(`insert into public.chat_list_conversations (list_id, conversation_id) values ($1, $2)`, [list, closedChat]);
    await db.query(`insert into public.chat_lists (user_id, name) values ($1, 'Empty')`, [buyer]);
    await db.query(`insert into public.user_presence (user_id, last_seen_at) values ($1, now() - interval '10 minutes')`, [owner]);
    await db.query(`insert into public.app_presence (user_id, seen_at) values ($1, now() - interval '1 hour')`, [buyer]);

    const call = async (caller: string, callee: string, status: string, age: string, rings = 0) =>
      (
        await db.query<{ id: string }>(
          `insert into public.voice_calls (conversation_id, caller_id, callee_id, status, created_at, rings) values ($1, $2, $3, $4, now() - $5::interval, $6) returning id`,
          [chat, caller, callee, status, age, rings],
        )
      )[0]!.id;
    ringing = await call(buyer, owner, "ringing", "10 seconds");
    answered = await call(buyer, owner, "active", "5 minutes");
    othersRinging = await call(owner, buyer, "ringing", "2 minutes", 9);
    await db.query(
      `insert into public.notifications (user_id, type, title, target_params) values ($1, 'incoming_call', 'Incoming call', jsonb_build_object('callId', $2::text, 'conversationId', $3::text))`,
      [owner, ringing, chat],
    );
  }, 60_000);
  afterAll(async () => {
    process.env = previousEnv;
    await db.close();
  });

  const conversations = (ctx: DataContext) => new ConversationsService(() => ctx);
  const calls = (ctx: DataContext) => new CallsService(() => ctx);
  const presence = (ctx: DataContext) => new PresenceService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }
  const voidResult = { result: () => null };
  type Who = () => string | null;
  const people: [string, Who][] = [
    ["the buyer", () => buyer],
    ["the shop owner", () => owner],
    ["someone else", () => stranger],
    ["signed out", () => null],
  ];

  describe("get_or_create_conversation", () => {
    const cases: [string, Who, () => string][] = [
      ["the existing conversation", () => buyer, () => shop],
      ["refused while no order is accepted", () => buyer, () => closedShop],
      ["refused for admins", () => admin, () => shop],
      ["refused signed out", () => null, () => shop],
    ];
    for (const [name, who, vendor] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "get_or_create_conversation", { p_vendor_id: vendor() }),
          runIsolated(db, (ctx) => conversations(ctx).open(me(who()), vendor()).then((r) => r.id)),
        ),
      );
    }
    it("creates the conversation on first use", async () => {
      const newBuyer = (await seedUser(db)).id;
      await seedOrder(db, newBuyer, shop, { status: "handed_over" });
      const a = await same(
        runOriginal(db, me(newBuyer), "get_or_create_conversation", { p_vendor_id: shop }),
        runIsolated(db, (ctx) => conversations(ctx).open(me(newBuyer), shop).then((r) => r.id)),
      );
      expect(a.result).toBe("<new-id>");
    });
  });

  for (const [label, who] of people) {
    it(`list_my_conversations, ${label}`, () =>
      same(runOriginal(db, me(who()), "list_my_conversations"), runIsolated(db, (ctx) => conversations(ctx).list(me(who())))),
    );
    for (const [chatLabel, conv] of [["open", () => chat], ["closed", () => closedChat]] as const) {
      it(`conversation_is_open (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "conversation_is_open", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).isOpen(me(who()), conv()).then((r) => r.open)),
        ),
      );
      it(`get_conversation_other_party (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "get_conversation_other_party", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).otherParty(me(who()), conv())),
        ),
      );
      it(`mark_conversation_opened (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "mark_conversation_opened", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).markOpened(me(who()), conv())),
          voidResult,
        ),
      );
      it(`toggle_conversation_unread (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "toggle_conversation_unread", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).toggleUnread(me(who()), conv()).then((r) => r.unread)),
        ),
      );
      it(`can_call_in_conversation (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "can_call_in_conversation", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => calls(ctx).canCall(me(who()), conv()).then((r) => r.callable)),
        ),
      );
      it(`get_call_party (${chatLabel}), ${label}`, () =>
        same(
          runOriginal(db, me(who()), "get_call_party", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => calls(ctx).party(me(who()), conv())),
        ),
      );
      it(`get_conversation_presence (${chatLabel}), ${label}`, async () => {
        // Compared unmasked: which of the three times wins is the point.
        const original = await runOriginal(db, me(who()), "get_conversation_presence", { p_conversation_id: conv() });
        const port = await runIsolated(db, (ctx) => presence(ctx).conversationPresence(me(who()), conv()).then((r) => r.last_seen_at));
        expect(port.error).toBeUndefined();
        const time = (v: unknown) => (v == null ? null : new Date(String(v)).getTime());
        expect(time(port.result)).toBe(time(original.result));
      });
    }
  }

  it("can_call_in_conversation: messages and no order at all", () =>
    same(
      runOriginal(db, me(buyer), "can_call_in_conversation", { p_conversation_id: quietChat }),
      runIsolated(db, (ctx) => calls(ctx).canCall(me(buyer), quietChat).then((r) => r.callable)),
    ));

  describe("toggle_conversation_pin", () => {
    const cases: [string, Who, () => string][] = [
      ["the buyer's pin", () => buyer, () => chat],
      ["the shop's pin", () => owner, () => chat],
      ["someone else is refused", () => stranger, () => chat],
      ["an unknown conversation gives null", () => buyer, () => uuid()],
    ];
    for (const [name, who, conv] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "toggle_conversation_pin", { p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).togglePin(me(who()), conv()).then((r) => r.pinned)),
        ),
      );
    }
    it("FIX S4: signed out, the original flipped the shop's pin; the port refuses", async () => {
      const original = await runOriginal(db, null, "toggle_conversation_pin", { p_conversation_id: chat });
      expect(original.changes.conversations!.updated).toHaveLength(1);
      const port = await runIsolated(db, (ctx) => conversations(ctx).togglePin(null, chat));
      expect(port.error?.message).toBe("not part of this conversation");
      expect(port.changes.conversations!.updated).toHaveLength(0);
    });
  });

  describe("delete_message / edit_message", () => {
    const cases: [string, Who, () => string][] = [
      ["one's own recent message", () => buyer, () => recentFromBuyer],
      ["someone else's message is refused", () => buyer, () => recentFromOwner],
      ["after 30 minutes is refused", () => buyer, () => oldFromBuyer],
      ["an already deleted message", () => buyer, () => deletedFromBuyer],
      ["an unknown message", () => buyer, () => uuid()],
    ];
    for (const [name, who, message] of cases) {
      it(`delete: ${name}`, () =>
        same(
          runOriginal(db, me(who()), "delete_message", { p_message_id: message() }),
          runIsolated(db, (ctx) => conversations(ctx).deleteMessage(me(who()), message())),
          voidResult,
        ),
      );
      it(`edit: ${name}`, () =>
        same(
          runOriginal(db, me(who()), "edit_message", { p_message_id: message(), p_new_body: "Edited text" }),
          runIsolated(db, (ctx) => conversations(ctx).editMessage(me(who()), message(), "Edited text")),
          voidResult,
        ),
      );
    }
    for (const body of ["   ", null]) {
      it(`edit: an empty body (${JSON.stringify(body)}) is refused`, () =>
        same(
          runOriginal(db, me(buyer), "edit_message", { p_message_id: recentFromBuyer, p_new_body: body }),
          runIsolated(db, (ctx) => conversations(ctx).editMessage(me(buyer), recentFromBuyer, body)),
          voidResult,
        ),
      );
    }
    it("signed out, an unknown message: both say not found", () =>
      same(
        runOriginal(db, null, "delete_message", { p_message_id: uuid() }),
        runIsolated(db, (ctx) => conversations(ctx).deleteMessage(null, uuid())),
        voidResult,
      ));
    it("FIX S4: signed out, the original deleted and rewrote someone's message; the port refuses", async () => {
      const deleted = await runOriginal(db, null, "delete_message", { p_message_id: recentFromOwner });
      expect(deleted.changes.messages!.updated).toHaveLength(1);
      const edited = await runOriginal(db, null, "edit_message", { p_message_id: recentFromOwner, p_new_body: "Price is now ₦1" });
      expect(edited.changes.messages!.updated).toHaveLength(1);
      for (const port of [
        await runIsolated(db, (ctx) => conversations(ctx).deleteMessage(null, recentFromOwner)),
        await runIsolated(db, (ctx) => conversations(ctx).editMessage(null, recentFromOwner, "Price is now ₦1")),
      ]) {
        expect(port.error?.message).toMatch(/^You can only (delete|edit) your own messages\.$/);
        expect(port.changes.messages!.updated).toHaveLength(0);
      }
    });
  });

  describe("toggle_message_reaction", () => {
    const cases: [string, Who, () => string, string | null][] = [
      ["adds a reaction", () => owner, () => recentFromBuyer, "❤️"],
      ["the same emoji again removes it", () => buyer, () => recentFromOwner, "👍"],
      ["another emoji replaces it", () => buyer, () => recentFromOwner, "😂"],
      ["eight characters is the limit", () => buyer, () => recentFromOwner, "👍👍👍👍👍👍👍👍👍"],
      ["empty is refused", () => buyer, () => recentFromOwner, ""],
      ["missing is refused", () => buyer, () => recentFromOwner, null],
      ["someone else is refused", () => stranger, () => recentFromOwner, "👍"],
      ["an unknown message", () => buyer, () => uuid(), "👍"],
      ["signed out is refused", () => null, () => recentFromOwner, "👍"],
    ];
    for (const [name, who, message, emoji] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "toggle_message_reaction", { p_message_id: message(), p_emoji: emoji }),
          runIsolated(db, (ctx) => conversations(ctx).toggleReaction(me(who()), message(), emoji)),
        ),
      );
    }
  });

  describe("chat lists", () => {
    for (const [label, who] of people) {
      it(`list_my_chat_lists, ${label}`, () =>
        same(runOriginal(db, me(who()), "list_my_chat_lists"), runIsolated(db, (ctx) => conversations(ctx).lists(me(who())))),
      );
      it(`delete_chat_list, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "delete_chat_list", { p_list_id: list }),
          runIsolated(db, (ctx) => conversations(ctx).deleteList(me(who()), list)),
          voidResult,
        ),
      );
    }
    for (const name of ["  Suppliers ", "", "   ", "x".repeat(41)]) {
      it(`create_chat_list ${JSON.stringify(name.slice(0, 12))}`, () =>
        same(
          runOriginal(db, me(owner), "create_chat_list", { p_name: name }),
          runIsolated(db, (ctx) => conversations(ctx).createList(me(owner), name).then((r) => r.id)),
        ),
      );
    }
    const toggles: [string, Who, () => string, () => string][] = [
      ["adds a conversation", () => buyer, () => list, () => chat],
      ["removes one already in it", () => buyer, () => list, () => closedChat],
      ["someone else's list", () => owner, () => list, () => chat],
      ["a conversation the caller is not in", () => stranger, () => list, () => chat],
      ["signed out", () => null, () => list, () => chat],
    ];
    for (const [name, who, l, conv] of toggles) {
      it(`toggle_conversation_in_list: ${name}`, () =>
        same(
          runOriginal(db, me(who()), "toggle_conversation_in_list", { p_list_id: l(), p_conversation_id: conv() }),
          runIsolated(db, (ctx) => conversations(ctx).toggleInList(me(who()), l(), conv()).then((r) => r.inList)),
        ),
      );
    }
  });

  describe("admin views", () => {
    for (const [label, who] of [["an admin", () => admin], ["the buyer", () => buyer], ["signed out", () => null]] as const) {
      it(`admin_find_conversation, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_find_conversation", { p_buyer_id: buyer, p_vendor_id: shop }),
          runIsolated(db, (ctx) => conversations(ctx).adminFind(me(who()), buyer, shop).then((r) => r.id)),
        ),
      );
      it(`admin_get_conversation_participants, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_get_conversation_participants", { p_conversation_id: chat }),
          runIsolated(db, (ctx) => conversations(ctx).adminParticipants(me(who()), chat)),
        ),
      );
      it(`admin_list_conversations, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_list_conversations", {}),
          runIsolated(db, (ctx) => conversations(ctx).adminList(me(who()), null, null)),
        ),
      );
    }
    for (const [search, limit] of [["ola", 100], ["BOLA", 1], ["", 0], ["nobody", 500], [null, -5]] as const) {
      it(`admin_list_conversations search ${JSON.stringify(search)} limit ${limit}`, () =>
        same(
          runOriginal(db, me(admin), "admin_list_conversations", { p_search: search, p_limit: limit }),
          runIsolated(db, (ctx) => conversations(ctx).adminList(me(admin), search, limit)),
        ),
      );
    }
  });

  describe("presence", () => {
    // parity-tested: touch_presence, clear_presence, touch_last_seen
    for (const fn of ["touch_presence", "clear_presence", "touch_last_seen"] as const) {
      const port = (s: PresenceService, who: Identity | null) =>
        fn === "touch_presence" ? s.touch(who) : fn === "clear_presence" ? s.clear(who) : s.touchLastSeen(who);
      for (const [label, who] of [["the buyer (has a row)", () => buyer], ["the owner (has none)", () => stranger]] as const) {
        it(`${fn}, ${label}`, () =>
          same(runOriginal(db, me(who()), fn), runIsolated(db, (ctx) => port(presence(ctx), me(who()))), voidResult),
        );
      }
    }
    it("touch_last_seen signed out does nothing", () =>
      same(runOriginal(db, null, "touch_last_seen"), runIsolated(db, (ctx) => presence(ctx).touchLastSeen(null)), voidResult));
  });

  describe("voice calls", () => {
    const starts: [string, Who, () => string][] = [
      ["one ringing call at a time (the buyer's is ringing)", () => buyer, () => chat],
      ["the shop calls the buyer", () => owner, () => chat],
      ["someone else is refused", () => stranger, () => chat],
      ["not while chat is closed", () => buyer, () => closedChat],
      ["an unknown conversation", () => buyer, () => uuid()],
      ["signed out", () => null, () => chat],
    ];
    for (const [name, who, conv] of starts) {
      it(`start_voice_call: ${name}`, () =>
        same(runOriginal(db, me(who()), "start_voice_call", { p_conversation_id: conv() }), runIsolated(db, (ctx) => calls(ctx).start(me(who()), conv()))),
      );
    }
    const rings: [string, Who, () => string][] = [
      ["the caller rings again (webhook to /api/notify)", () => buyer, () => ringing],
      ["not the callee", () => owner, () => ringing],
      ["not an answered call", () => buyer, () => answered],
      ["not after 9 rings", () => owner, () => othersRinging],
      ["not an unknown call", () => buyer, () => uuid()],
    ];
    for (const [name, who, call] of rings) {
      it(`ring_callee_again: ${name}`, () =>
        same(
          runOriginal(db, me(who()), "ring_callee_again", { p_call_id: call() }),
          runIsolated(db, (ctx) => calls(ctx).ringAgain(me(who()), call()).then((r) => r.rang)),
        ),
      );
    }
    it("FIX S4: signed out, the original rang the call again; the port does not", async () => {
      const original = await runOriginal(db, null, "ring_callee_again", { p_call_id: ringing });
      expect(original.result).toBe(true);
      const port = await runIsolated(db, (ctx) => calls(ctx).ringAgain(null, ringing));
      expect(port.result).toEqual({ rang: false });
      expect(port.changes.voice_calls!.updated).toHaveLength(0);
    });

    const updates: [string, Who, () => string, string][] = [
      ["the callee answers", () => owner, () => ringing, "active"],
      ["the callee declines", () => owner, () => ringing, "declined"],
      ["the caller gives up: missed, the callee is told", () => buyer, () => ringing, "missed"],
      ["either side ends it", () => owner, () => answered, "ended"],
      ["the caller cannot answer", () => buyer, () => ringing, "active"],
      ["an unknown status changes nothing", () => buyer, () => ringing, "on-hold"],
      ["someone else is refused", () => stranger, () => ringing, "ended"],
      ["an unknown call", () => buyer, () => uuid(), "ended"],
    ];
    for (const [name, who, call, status] of updates) {
      it(`update_voice_call: ${name}`, () =>
        same(
          runOriginal(db, me(who()), "update_voice_call", { p_call_id: call(), p_status: status }),
          runIsolated(db, (ctx) => calls(ctx).update(me(who()), call(), status)),
          voidResult,
        ),
      );
    }
    it("FIX S4: signed out, the original ended anyone's call; the port refuses", async () => {
      const original = await runOriginal(db, null, "update_voice_call", { p_call_id: answered, p_status: "ended" });
      expect(original.changes.voice_calls!.updated).toHaveLength(1);
      const port = await runIsolated(db, (ctx) => calls(ctx).update(null, answered, "ended"));
      expect(port.error?.message).toBe("Call not found.");
      expect(port.changes.voice_calls!.updated).toHaveLength(0);
    });
  });
});
