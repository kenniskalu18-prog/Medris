import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { LiveService, type LiveClientMessage, type LiveConnection } from "../../src/modules/live/live.service.js";
import { asUserSeed, identityOf, seedOrder, seedPackage, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { runTableQuery } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * Live updates: the app's 12 sb.channel(...) subscriptions against /api/v1/live's LiveService, on the real schema
 * with migration 0004's trigger. Supabase Realtime delivered a row change to a subscriber only when that subscriber
 * could read the row (row-level security); every delivery here is checked against the same row read as the same
 * user (runTableQuery). Changes are committed for real (NOTIFY is only sent on commit).
 */
describe("parity: live updates (Realtime channels)", () => {
  let db: TestDatabase;
  let live: LiveService;
  let stop: () => Promise<void>;
  let admin: string;
  let buyer: string;
  let owner: string;
  let outsider: string;
  let shop: string;
  let product: string;
  let pkg: string;
  let conv: string;
  const tokens = new Map<string, Identity>();

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    outsider = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    product = await seedProduct(db, shop, { name: "Phone" });
    pkg = await seedPackage(db, shop, { name: "Starter" });
    conv = (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [buyer, shop]))[0]!.id;
    for (const id of [admin, buyer, owner, outsider]) tokens.set(`t-${id}`, identityOf(id));
    live = new LiveService(() => db.data, async (token) => tokens.get(token) ?? null);
    stop = await live.start(db.changes);
  }, 60_000);
  afterAll(async () => {
    await stop();
    await db.close();
  });

  /** A connected client that records what it receives. */
  async function client(userId: string | null) {
    const inbox: Record<string, unknown>[] = [];
    const conn: LiveConnection = live.connect((m) => inbox.push(m as Record<string, unknown>));
    const send = (m: LiveClientMessage) => conn.handle(JSON.stringify(m));
    if (userId) await send({ type: "auth", token: `t-${userId}` });
    return { inbox, send, conn, changes: () => inbox.filter((m) => m.type === "change"), clear: () => (inbox.length = 0) };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await live.idle();
    }
  };
  /** The row as the subscriber can read it (what Realtime's RLS check allowed), or undefined. */
  const asSeenBy = async (userId: string | null, table: string, id: string) =>
    ((await runTableQuery(db, userId ? identityOf(userId) : null, sql`select * from public.${sql.identifier(table)} where id = ${id}`)).result as unknown[])[0];

  let clients: Awaited<ReturnType<typeof client>>[] = [];
  beforeEach(() => {
    for (const c of clients) c.conn.close();
    clients = [];
  });
  const open = async (userId: string | null) => {
    const c = await client(userId);
    clients.push(c);
    return c;
  };

  it("notifications-<user>: INSERT and UPDATE on the user's own notifications only", async () => {
    const [mine, other] = [await open(buyer), await open(outsider)];
    for (const c of [mine, other]) {
      await c.send({
        type: "subscribe",
        id: "notif",
        changes: [
          { event: "INSERT", table: "notifications", filter: `user_id=eq.${buyer}` },
          { event: "UPDATE", table: "notifications", filter: `user_id=eq.${buyer}` },
        ],
      });
    }
    const id = (await db.query<{ id: string }>(`insert into public.notifications (user_id, type, title) values ($1, 'order_status_changed', 'Your order moved') returning id`, [buyer]))[0]!.id;
    await db.query(`update public.notifications set read = true where id = $1`, [id]);
    await settle();
    expect(mine.changes().map((m) => m.eventType)).toEqual(["INSERT", "UPDATE"]);
    expect(mine.changes()[0]).toMatchObject({ id: "notif", table: "notifications", schema: "public", new: await asSeenBy(buyer, "notifications", id), old: {} });
    expect(mine.changes()[1]).toMatchObject({ old: { id } });
    // the outsider asked for the buyer's notifications: RLS hides them, as in Realtime
    expect(await asSeenBy(outsider, "notifications", id)).toBeUndefined();
    expect(other.changes()).toEqual([]);
  });

  it("orders-live: buyer side, shop side, admin (all orders); payments unfiltered but only one's own", async () => {
    const [b, v, a, x] = [await open(buyer), await open(owner), await open(admin), await open(outsider)];
    await b.send({ type: "subscribe", id: "o", changes: [{ event: "*", table: "orders", filter: `buyer_id=eq.${buyer}` }, { event: "*", table: "payments" }] });
    await v.send({ type: "subscribe", id: "o", changes: [{ event: "*", table: "orders", filter: `vendor_id=eq.${shop}` }, { event: "*", table: "payments" }] });
    await a.send({ type: "subscribe", id: "o", changes: [{ event: "*", table: "orders" }, { event: "*", table: "payments" }] });
    await x.send({ type: "subscribe", id: "o", changes: [{ event: "*", table: "orders" }, { event: "*", table: "payments" }] });
    const order = await seedOrder(db, buyer, shop, { status: "pending", productIds: [product] });
    await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', 2500, 'transfer', 'pending')`, [order]);
    await settle();
    const tables = (c: typeof b) => c.changes().map((m) => `${m.table} ${m.eventType}`);
    for (const c of [b, v, a]) expect(tables(c)).toEqual(expect.arrayContaining(["orders INSERT", "payments INSERT"]));
    expect(tables(x)).toEqual([]);
    const seen = b.changes().find((m) => m.table === "orders" && m.eventType === "INSERT")!;
    expect(seen.new).toEqual(await asSeenBy(buyer, "orders", order));
  });

  it("order-extras and requests-live: unfiltered tables, delivered only where readable", async () => {
    const [b, x] = [await open(buyer), await open(outsider)];
    for (const c of [b, x]) await c.send({ type: "subscribe", id: "aux", changes: ["order_items", "order_notes", "service_offers"].map((table) => ({ event: "*" as const, table })) });
    await seedOrder(db, buyer, shop, { status: "pending", productIds: [product] });
    await settle();
    expect(b.changes().some((m) => m.table === "order_items")).toBe(true);
    expect(x.changes()).toEqual([]);
  });

  it("conv-<id>: new messages to the two people; an outsider's subscription gets nothing; DELETE carries only the key", async () => {
    const [b, v, x] = [await open(buyer), await open(owner), await open(outsider)];
    for (const c of [b, v, x]) await c.send({ type: "subscribe", id: "m", changes: [{ event: "*", table: "messages", filter: `conversation_id=eq.${conv}` }] });
    const msg = (await db.query<{ id: string }>(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hi') returning id`, [conv, buyer]))[0]!.id;
    await db.query(`update public.messages set read_at = now() where id = $1`, [msg]);
    await settle();
    expect(v.changes().map((m) => m.eventType)).toEqual(["INSERT", "UPDATE"]);
    expect(v.changes()[0]!.new).toEqual(await asSeenBy(owner, "messages", msg));
    expect(x.changes()).toEqual([]);
    v.clear();
    await db.query(`delete from public.messages where id = $1`, [msg]);
    await settle();
    expect(v.changes()).toMatchObject([{ eventType: "DELETE", new: {}, old: { id: msg } }]);
  });

  it("product and package comments (signed out too); FIX B15: package comments now arrive", async () => {
    const anon = await open(null);
    await anon.send({
      type: "subscribe",
      id: "c",
      changes: [
        { event: "*", table: "product_comments", filter: `product_id=eq.${product}` },
        { event: "*", table: "package_comments", filter: `package_id=eq.${pkg}` },
      ],
    });
    await asUserSeed(db, buyer, [[`insert into public.product_comments (product_id, user_id, content, author_name) values ($1, $2, 'Nice', 'Bola')`, [product, buyer]]]);
    await db.query(`insert into public.package_comments (package_id, user_id, content) values ($1, $2, 'Good deal')`, [pkg, buyer]);
    const publication = await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'package_comments'`);
    expect(publication).toEqual([]); // Realtime never streamed this table
    await settle();
    expect(anon.changes().map((m) => m.table)).toEqual(["product_comments", "package_comments"]);
  });

  it("marketplace and leaderboard: shop and listing changes for visitors; points_weekly (two-column key)", async () => {
    const anon = await open(null);
    await anon.send({ type: "subscribe", id: "mk", changes: ["products", "vendors", "points_weekly"].map((table) => ({ event: "*" as const, table })) });
    await db.query(`update public.products set name = 'Phone 2' where id = $1`, [product]);
    await db.query(`insert into public.points_weekly (user_id, week_start, points, tx_count, last_at) values ($1, date_trunc('week', now())::date, 10, 1, now())`, [buyer]);
    await settle();
    const got = anon.changes();
    expect(got.find((m) => m.table === "products")).toMatchObject({ eventType: "UPDATE", new: { id: product, name: "Phone 2" }, old: { id: product } });
    const points = got.find((m) => m.table === "points_weekly");
    if (points) expect(points.old).toEqual({});
    const visible = ((await runTableQuery(db, null, sql`select count(*)::int as n from public.points_weekly`)).result as { n: number }[])[0]!.n;
    expect(Boolean(points)).toBe(visible > 0);
  });

  it("nothing is sent for a change that is rolled back", async () => {
    const b = await open(buyer);
    await b.send({ type: "subscribe", id: "n", changes: [{ event: "*", table: "notifications", filter: `user_id=eq.${buyer}` }] });
    await db.query(`do $$ begin insert into public.notifications (user_id, type, title) values ('${buyer}', 'x', 'y'); raise exception 'undo'; end $$`).catch(() => {});
    await settle();
    expect(b.changes()).toEqual([]);
  });

  it("refuses tables that were never live and malformed filters", async () => {
    const b = await open(buyer);
    await b.send({ type: "subscribe", id: "bad", changes: [{ event: "*", table: "users" }] });
    await b.send({ type: "subscribe", id: "bad2", changes: [{ event: "*", table: "orders", filter: "buyer_id=like.%" }] });
    expect(b.inbox.filter((m) => m.type === "error")).toHaveLength(2);
  });

  describe("rooms: typing, presence and call signalling (FIX S14)", () => {
    it("only the conversation's two people may join its room", async () => {
      const [b, x, anon] = [await open(buyer), await open(outsider), await open(null)];
      await b.send({ type: "subscribe", id: "r", room: `conversation:${conv}`, presence: true });
      await x.send({ type: "subscribe", id: "r", room: `conversation:${conv}`, presence: true });
      await anon.send({ type: "subscribe", id: "r", room: `conversation:${conv}` });
      expect(b.inbox).toContainEqual({ type: "subscribed", id: "r" });
      expect(x.inbox).toContainEqual(expect.objectContaining({ type: "error", ref: "r" }));
      expect(anon.inbox).toContainEqual(expect.objectContaining({ type: "error", ref: "r" }));
    });

    it("typing reaches the other person, stamped with the real sender; presence join/sync/leave", async () => {
      const [b, v] = [await open(buyer), await open(owner)];
      for (const c of [b, v]) await c.send({ type: "subscribe", id: "chat", room: `conversation:${conv}`, presence: true });
      await b.send({ type: "track", id: "chat", state: { user_id: owner, typing: false } });
      expect(v.inbox).toContainEqual(expect.objectContaining({ type: "presence", event: "join", key: buyer, state: { user_id: buyer, typing: false } }));
      const sync = v.inbox.filter((m) => m.type === "presence" && m.event === "sync").at(-1)!;
      expect(Object.keys(sync.state as object)).toEqual([buyer]);
      await b.send({ type: "broadcast", id: "chat", event: "typing", payload: { user_id: owner, typing: true } });
      expect(v.inbox).toContainEqual({ type: "broadcast", id: "chat", event: "typing", payload: { user_id: owner, typing: true }, from: buyer });
      expect(b.inbox.some((m) => m.type === "broadcast")).toBe(false); // not echoed to the sender
      b.conn.close();
      expect(v.inbox).toContainEqual(expect.objectContaining({ type: "presence", event: "leave", key: buyer }));
    });

    it("call signalling: only the caller and callee", async () => {
      const call = (await db.query<{ id: string }>(`insert into public.voice_calls (conversation_id, caller_id, callee_id) values ($1, $2, $3) returning id`, [conv, buyer, owner]))[0]!.id;
      const [b, v, x] = [await open(buyer), await open(owner), await open(outsider)];
      for (const c of [b, v, x]) await c.send({ type: "subscribe", id: "call", room: `call:${call}` });
      await b.send({ type: "broadcast", id: "call", event: "sig", payload: { t: "offer", sdp: { type: "offer", sdp: "v=0" } } });
      expect(v.inbox).toContainEqual(expect.objectContaining({ type: "broadcast", event: "sig", from: buyer }));
      expect(x.inbox.some((m) => m.type === "broadcast")).toBe(false);
      await x.send({ type: "broadcast", id: "call", event: "sig", payload: { t: "end" } });
      expect(v.inbox.filter((m) => m.type === "broadcast")).toHaveLength(1);
    });

    it("signing in as someone else leaves the rooms the new person is not in; a bad token is refused", async () => {
      const c = await open(buyer);
      await c.send({ type: "subscribe", id: "chat", room: `conversation:${conv}` });
      await c.send({ type: "auth", token: "nope" });
      expect(c.inbox).toContainEqual(expect.objectContaining({ type: "error", ref: "auth" }));
      await c.send({ type: "auth", token: `t-${outsider}` });
      expect(c.inbox).toContainEqual(expect.objectContaining({ type: "closed", id: "chat" }));
    });
  });
});
