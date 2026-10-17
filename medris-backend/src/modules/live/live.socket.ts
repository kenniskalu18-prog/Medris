import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { parse } from "cookie";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppServices } from "../../container.js";
import type { Identity } from "../../database/context.js";
import { sessionCookieName } from "../auth/session-cookie.js";

export const LIVE_PATH = "/api/v1/live";

/**
 * The WebSocket at /api/v1/live (long-running server only - not on Vercel). Protocol: docs/LIVE.md.
 *
 * Sign-in: send `{"type":"auth","token":"<access token>"}` as the first message (browsers cannot set headers on
 * a WebSocket, and a token in the URL would end up in logs), or rely on the backend session cookie. Until then the
 * connection is a signed-out visitor. Only the app's own origins may connect (CORS_ALLOWED_ORIGINS / APP_ORIGIN).
 */
export function attachLiveSocket(server: Server, services: AppServices): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const allowed = new Set([services.config.appOrigin, ...services.config.cors.allowedOrigins].filter(Boolean));

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== LIVE_PATH) {
      // another upgrade handler may want it; if there is none, do not leave the socket hanging
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin) && services.config.env === "production") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    void cookieIdentity(req, services).then((identity) => wss.handleUpgrade(req, socket, head, (ws) => serve(ws, identity, services)));
  };
  server.on("upgrade", onUpgrade);

  // Dead connections (a phone that went to sleep) are noticed by the missing pong.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });

  return {
    close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

async function cookieIdentity(req: IncomingMessage, services: AppServices): Promise<Identity | null> {
  if (!services.sessions.enabled || !req.headers.cookie) return null;
  const token = parse(req.headers.cookie)[sessionCookieName(services.config)];
  return token ? services.sessions.resolve(token).catch(() => null) : null;
}

function serve(ws: WebSocket, identity: Identity | null, services: AppServices): void {
  const conn = services.live.connect((message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }, identity);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    conn.handle(data.toString()).catch(() => {});
  });
  ws.on("close", () => conn.close());
  ws.on("error", () => conn.close());
  ws.send(JSON.stringify({ type: "hello", userId: identity?.userId ?? null }));
}
