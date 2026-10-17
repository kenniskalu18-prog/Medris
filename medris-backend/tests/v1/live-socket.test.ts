import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServices } from "../../src/container.js";
import { silentLogger } from "../../src/lib/logger.js";
import { attachLiveSocket, LIVE_PATH } from "../../src/modules/live/live.socket.js";
import { accessToken, seedUser, seedVendor, testConfig } from "../support/fixtures.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** /api/v1/live over a real WebSocket: sign-in by first message, a row change pushed after commit. */
describe("/api/v1/live (WebSocket)", () => {
  let db: TestDatabase;
  let server: Server;
  let url: string;
  let stop: () => Promise<void>;
  let socket: { close(): void };
  let buyer: string;
  let shop: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db)).id;
    shop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id)).id;
    const services = createServices({ config: testConfig(), logger: silentLogger, data: () => db.data });
    stop = await services.live.start(db.changes);
    server = createServer((_req, res) => res.end());
    socket = attachLiveSocket(server, services);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${LIVE_PATH}`;
  }, 60_000);
  afterAll(async () => {
    socket.close();
    await stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  });

  function connect() {
    const ws = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    const waiters: { test: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      inbox.push(m);
      for (const w of [...waiters]) {
        if (!w.test(m)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    });
    const next = (test: (m: Record<string, unknown>) => boolean, ms = 3000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = inbox.find(test);
        if (found) return resolve(found);
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(inbox)}`)), ms);
      });
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    return { ws, inbox, next, send, opened: new Promise((r) => ws.once("open", r)) };
  }

  it("says hello, signs in with the first message, pushes the user's new notification", async () => {
    const c = connect();
    await c.opened;
    expect(await c.next((m) => m.type === "hello")).toEqual({ type: "hello", userId: null });
    c.send({ type: "auth", token: await accessToken(buyer) });
    expect(await c.next((m) => m.type === "authenticated")).toEqual({ type: "authenticated", userId: buyer });
    c.send({ type: "subscribe", id: "n", changes: [{ event: "INSERT", table: "notifications", filter: `user_id=eq.${buyer}` }] });
    await c.next((m) => m.type === "subscribed");
    await db.query(`insert into public.notifications (user_id, type, title) values ($1, 'x', 'Hello')`, [buyer]);
    expect(await c.next((m) => m.type === "change")).toMatchObject({ id: "n", table: "notifications", eventType: "INSERT", new: { user_id: buyer, title: "Hello" } });
    c.ws.close();
  });

  it("answers ping; rejects non-JSON and unknown messages without closing", async () => {
    const c = connect();
    await c.opened;
    c.ws.send("not json");
    c.send({ type: "nope" });
    c.send({ type: "ping" });
    await c.next((m) => m.type === "pong");
    expect(c.inbox.filter((m) => m.type === "error")).toHaveLength(2);
    c.ws.close();
  });

  it("a signed-out visitor sees public changes (a shop's update)", async () => {
    const c = connect();
    await c.opened;
    c.send({ type: "subscribe", id: "v", changes: [{ event: "UPDATE", table: "vendors" }] });
    await c.next((m) => m.type === "subscribed");
    await db.query(`update public.vendors set bio = 'Renamed' where id = $1`, [shop]);
    expect(await c.next((m) => m.type === "change")).toMatchObject({ table: "vendors", new: { id: shop, bio: "Renamed" } });
    c.ws.close();
  });

  it("a plain GET on the path is documented in Swagger and answers with how to connect", async () => {
    const { buildTestApp, call } = await import("../support/fixtures.js");
    const app = buildTestApp(db);
    const res = await call(app, "GET", LIVE_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ websocket: LIVE_PATH, rooms: ["conversation:<uuid>", "call:<uuid>"] });
    const doc = (await (await app.fetch(new Request("https://app.test/api/v1/openapi.json"))).json()) as { paths: Record<string, unknown> };
    expect(doc.paths[LIVE_PATH]).toBeDefined();
  });

  it("other paths are not upgraded", async () => {
    const ws = new WebSocket(url.replace(LIVE_PATH, "/api/v1/other"));
    const outcome = await new Promise((r) => {
      ws.once("open", () => r("open"));
      ws.once("error", () => r("error"));
      setTimeout(() => r("timeout"), 1500);
    });
    expect(outcome).not.toBe("open");
    ws.terminate();
  });
});
