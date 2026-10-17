import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { LeviRepository } from "../../src/database/repositories/levi.repository.js";
import { AssistantService } from "../../src/modules/assistant/assistant.service.js";
import { SuggestionsService } from "../../src/modules/suggestions/suggestions.service.js";
import { identityOf, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** Suggestions, Levi conversations and Levi usage counters: original functions vs ports. */
describe("parity: suggestions, assistant, Levi usage", () => {
  let db: TestDatabase;
  let buyer: string;
  let owner: string;
  let otherOwner: string;
  let admin: string;
  let shop: string;
  let toShop: string;
  let toPlatform: string;
  let conversation: string;
  let otherConversation: string;
  let message: string;
  const token = "11111111-2222-4333-8444-555555555555";
  const missing = "00000000-0000-4000-8000-000000000999";

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    otherOwner = (await seedUser(db, { role: "vendor" })).id;
    admin = (await seedUser(db, { role: "admin" })).id;
    shop = (await seedVendor(db, owner)).id;
    await seedVendor(db, otherOwner);
    const [s1] = await db.query<{ id: string }>(
      `insert into public.suggestions (sender_id, target_type, target_vendor_id, message, is_anonymous) values ($1, 'vendor', $2, 'More sizes please', false) returning id`,
      [buyer, shop],
    );
    await db.query(`insert into public.suggestions (sender_id, target_type, target_vendor_id, message, is_anonymous) values ($1, 'vendor', $2, 'Open on Sundays', true)`, [buyer, shop]);
    const [s2] = await db.query<{ id: string }>(
      `insert into public.suggestions (sender_id, target_type, message) values ($1, 'platform', 'Dark mode') returning id`,
      [buyer],
    );
    toShop = s1!.id;
    toPlatform = s2!.id;
    const [c1] = await db.query<{ id: string }>(`insert into public.ai_conversations (user_id, title, share_token) values ($1, 'Lamp ideas', $2) returning id`, [buyer, token]);
    const [c2] = await db.query<{ id: string }>(`insert into public.ai_conversations (user_id, title) values ($1, 'Shop setup') returning id`, [owner]);
    conversation = c1!.id;
    otherConversation = c2!.id;
    const [m] = await db.query<{ id: string }>(`insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'Which lamp is brightest?') returning id`, [conversation]);
    message = m!.id;
    await db.query(`insert into public.ai_messages (conversation_id, role, content, reaction) values ($1, 'assistant', 'The Solar 300.', '👍')`, [conversation]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options: Parameters<typeof comparable>[2] = {}) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  const suggestions = <T>(work: (s: SuggestionsService) => Promise<T>) => runIsolated(db, (ctx) => work(new SuggestionsService(() => ctx)));
  const assistant = <T>(work: (s: AssistantService) => Promise<T>) => runIsolated(db, (ctx) => work(new AssistantService(() => ctx)));

  describe("submit_suggestion", () => {
    const cases: [string, string | null, string, string | null, string | null, boolean | null][] = [
      ["to a shop, signed in", "buyer", "vendor", "shop", "Stock blue ones", false],
      ["to Levromart, anonymous", "buyer", "platform", null, "  Faster delivery  ", true],
      ["signed out", null, "platform", null, "Hello", null],
      ["empty message", "buyer", "platform", null, "   ", false],
      ["shop suggestion without a shop", "buyer", "vendor", null, "Hi", false],
    ];
    for (const [label, who, type, target, text, anonymous] of cases) {
      it(label, () => {
        const caller = who ? me(buyer) : null;
        const vendorId = target ? shop : null;
        return same(
          runOriginal(db, caller, "submit_suggestion", { p_target_type: type, p_target_vendor_id: vendorId, p_message: text, p_is_anonymous: anonymous }),
          suggestions((s) => s.submit(caller, { targetType: type, targetVendorId: vendorId, message: text, isAnonymous: anonymous }).then((r) => r.id)),
        );
      });
    }
  });

  for (const [label, who] of [["the shop owner", () => owner], ["a buyer without a shop", () => buyer]] as const) {
    it(`get_vendor_suggestions as ${label}`, () =>
      same(runOriginal(db, me(who()), "get_vendor_suggestions", {}), suggestions((s) => s.vendorSuggestions(me(who())))));
  }
  for (const [label, who] of [["an admin", () => admin], ["a buyer", () => buyer]] as const) {
    it(`get_platform_suggestions as ${label}`, () =>
      same(runOriginal(db, me(who()), "get_platform_suggestions", {}), suggestions((s) => s.platformSuggestions(me(who())))));
  }

  describe("mark_suggestion_read", () => {
    const cases: [string, () => string, () => string][] = [
      ["the receiving shop", () => owner, () => toShop],
      ["another shop", () => otherOwner, () => toShop],
      ["an admin, platform suggestion", () => admin, () => toPlatform],
      ["a buyer, platform suggestion", () => buyer, () => toPlatform],
      ["unknown suggestion", () => owner, () => missing],
    ];
    for (const [label, who, id] of cases) {
      it(label, () =>
        same(runOriginal(db, me(who()), "mark_suggestion_read", { p_suggestion_id: id() }), suggestions((s) => s.markRead(me(who()), id())), {
          result: () => null,
        }),
      );
    }
  });

  describe("search_ai_conversations", () => {
    for (const [label, who, q] of [
      ["by title", () => buyer, "lamp"],
      ["by message text", () => buyer, "SOLAR"],
      ["someone else's", () => owner, "lamp"],
      ["signed out", () => null, "lamp"],
    ] as const) {
      it(label, () => same(runOriginal(db, me(who()), "search_ai_conversations", { p_query: q }), assistant((s) => s.search(me(who()), q))));
    }
  });

  it("get_shared_ai_conversation", () => same(runOriginal(db, null, "get_shared_ai_conversation", { p_token: token }), assistant((s) => s.shared(token))));

  describe("set_ai_conversation_shared", () => {
    for (const [label, who, id, shared] of [
      ["share again keeps the token", () => buyer, () => conversation, true],
      ["unshare", () => buyer, () => conversation, false],
      ["first share creates a token", () => owner, () => otherConversation, true],
      ["someone else's conversation", () => owner, () => conversation, true],
    ] as const) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "set_ai_conversation_shared", { p_conversation_id: id(), p_shared: shared }),
          assistant((s) => s.setShared(me(who()), id(), shared).then((r) => r.shareToken)),
          { volatile: ["share_token"], result: (r) => (typeof r === "string" && r !== token ? "<new token>" : r) },
        ),
      );
    }
  });

  describe("toggle_ai_message_reaction", () => {
    for (const [label, who, emoji] of [
      ["adds a reaction", () => buyer, "❤️"],
      ["family emoji (several code points)", () => buyer, "👨‍👩‍👧"],
      ["someone else's message", () => owner, "❤️"],
      ["empty emoji", () => buyer, ""],
      ["too long", () => buyer, "abcdefghi"],
    ] as const) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "toggle_ai_message_reaction", { p_message_id: message, p_emoji: emoji }),
          assistant((s) => s.toggleReaction(me(who()), message, emoji).then((r) => r.reaction)),
        ),
      );
    }
  });

  describe("Levi usage counters", () => {
    for (const limit of [5, 0]) {
      it(`increment_chat_usage, limit ${limit}`, () =>
        same(
          runOriginal(db, null, "increment_chat_usage", { p_user_id: buyer, p_limit: limit }),
          runIsolated(db, (ctx) => ctx.asService((tx) => new LeviRepository(tx).incrementChatUsage(buyer, limit))),
        ));
    }
    it("increment_tts_usage", () =>
      same(
        runOriginal(db, null, "increment_tts_usage", { p_user_id: buyer, p_chars: 120, p_daily_char_limit: 100 }),
        runIsolated(db, (ctx) => ctx.asService((tx) => new LeviRepository(tx).incrementTtsUsage(buyer, 120, 100))),
      ));
  });
});
