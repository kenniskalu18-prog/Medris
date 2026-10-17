import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { jsonResponse } from "../../shared/openapi/schemas.js";
import { LIVE_TABLES } from "../../database/repositories/live.repository.js";

/**
 * /api/v1/live is a WebSocket (replaces the app's sb.channel(...) subscriptions). OpenAPI cannot describe a
 * socket, so this documents it: a plain GET (no Upgrade header) answers with where to connect and the protocol.
 */

const tags = ["Live updates"];

export const LiveInfo = z.object({
  websocket: z.string(),
  protocol: z.string(),
  tables: z.array(z.string()),
  rooms: z.array(z.string()),
  clientMessages: z.array(z.string()),
  serverMessages: z.array(z.string()),
});

export const liveInfo = defineRoute({
  method: "get",
  path: "/live",
  tags,
  summary: "Live updates (WebSocket)",
  description: [
    "Connect with a WebSocket to `wss://<host>/api/v1/live` (the long-running server; not on Vercel). Full protocol: `docs/LIVE.md`.",
    "",
    "1. Sign in with the first message: `{\"type\":\"auth\",\"token\":\"<access token>\"}` (or the backend session cookie). Without it you are a signed-out visitor.",
    "2. Row changes: `{\"type\":\"subscribe\",\"id\":\"orders\",\"changes\":[{\"event\":\"*\",\"table\":\"orders\",\"filter\":\"buyer_id=eq.<uuid>\"}]}`. Each change is re-read as you, so you only get rows you may see. Server sends `{\"type\":\"change\",\"id\",\"table\",\"eventType\",\"new\",\"old\",\"commit_timestamp\"}`.",
    "3. Rooms (typing, presence, call signalling): `{\"type\":\"subscribe\",\"id\":\"chat\",\"room\":\"conversation:<uuid>\",\"presence\":true}`, then `broadcast` / `track` / `untrack`. Only the conversation's two people (or the call's caller and callee) may join.",
    "",
    "A plain GET returns this summary as JSON.",
  ].join("\n"),
  security: [],
  responses: { 200: jsonResponse(LiveInfo, "How to connect (open a WebSocket, Upgrade: websocket, on this path).") },
});

export const liveSummary = (): z.infer<typeof LiveInfo> => ({
  websocket: "/api/v1/live",
  protocol: "docs/LIVE.md",
  tables: Object.keys(LIVE_TABLES),
  rooms: ["conversation:<uuid>", "call:<uuid>"],
  clientMessages: ["auth", "subscribe", "unsubscribe", "broadcast", "track", "untrack", "ping"],
  serverMessages: ["hello", "authenticated", "auth_expired", "subscribed", "unsubscribed", "closed", "change", "broadcast", "presence", "pong", "error"],
});
