import { randomUUID } from "node:crypto";
import { z } from "../../shared/openapi/zod.js";
import type { DataContext, Identity } from "../../database/context.js";
import { isLiveTable, LIVE_TABLES, LiveRepository, type LiveRoom, type LiveTable } from "../../database/repositories/live.repository.js";
import type { ChangeSource } from "../../integrations/live/change-source.js";

/**
 * Live updates - replaces the app's 12 `sb.channel(...)` subscriptions (Supabase Realtime):
 *
 *  - row changes (postgres_changes): the backend_live_notify trigger (migration 0004) announces each committed
 *    change; for every subscriber whose subscription matches, the row is re-read in the subscriber's own session,
 *    so row-level security decides who gets it - the check Realtime made. DELETE carries only the key, as before.
 *  - broadcast and presence (typing in a conversation, call signalling): rooms. Unlike the old public channels,
 *    only a conversation's two people may join its room and only a call's two people its call room (finding S14),
 *    and the sender / presence key is the signed-in user, not what the browser claims.
 *
 * The socket layer (live.socket.ts) turns a WebSocket into a LiveConnection; this class holds the state.
 */

export const LIVE_CHANNEL = "backend_live";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { subscriptions: 50, messagesPer10s: 300, presenceStateBytes: 2048 };

type Event = "INSERT" | "UPDATE" | "DELETE";
const Filter = z
  .string()
  .max(2000)
  .regex(/^[a-z_][a-z0-9_]*=(eq\.[^,()]{1,200}|in\.\([^()]{1,1800}\))$/, "Filter must be column=eq.value or column=in.(a,b)");

const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().max(8192).nullable() }),
  z.object({
    type: z.literal("subscribe"),
    id: z.string().min(1).max(100),
    changes: z
      .array(z.object({ event: z.enum(["INSERT", "UPDATE", "DELETE", "*"]), table: z.string().max(64), filter: Filter.optional() }))
      .max(10)
      .default([]),
    room: z
      .string()
      .regex(/^(conversation|call):[0-9a-f-]{36}$/i)
      .optional(),
    presence: z.boolean().default(false),
    self: z.boolean().default(false),
  }),
  z.object({ type: z.literal("unsubscribe"), id: z.string().max(100) }),
  z.object({ type: z.literal("broadcast"), id: z.string().max(100), event: z.string().min(1).max(64), payload: z.unknown() }),
  z.object({ type: z.literal("track"), id: z.string().max(100), state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("untrack"), id: z.string().max(100) }),
  z.object({ type: z.literal("ping") }),
]);
export type LiveClientMessage = z.input<typeof ClientMessage>;

interface ChangeSpec {
  events: Event[];
  table: LiveTable;
  filter: { column: string; values: string[] } | null;
}
interface Subscription {
  id: string;
  changes: ChangeSpec[];
  room: LiveRoom | null;
  presence: boolean;
  self: boolean;
  tracked: Record<string, unknown> | null;
}
interface Notice {
  t: string;
  op: Event;
  at: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

export interface LiveConnection {
  readonly id: string;
  handle(raw: string): Promise<void>;
  close(): void;
}

export class LiveService {
  private readonly connections = new Map<string, Connection>();
  private queue: Promise<void> = Promise.resolve();
  private readonly columns = new Map<string, Promise<string[]>>();

  constructor(
    private readonly db: () => DataContext,
    private readonly verify: (token: string) => Promise<Identity | null> = async () => null,
  ) {}

  /** Starts listening for row changes. Returns the stop function. */
  start(source: ChangeSource): Promise<() => Promise<void>> {
    return source.listen(LIVE_CHANNEL, (payload) => {
      // one at a time, in commit order
      this.queue = this.queue.then(() => this.dispatch(payload)).catch(() => {});
    });
  }

  /** Resolves once every announcement received so far has been delivered (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  connect(send: (message: unknown) => void, identity: Identity | null = null): LiveConnection {
    const conn = new Connection(this, send, identity);
    this.connections.set(conn.id, conn);
    return conn;
  }

  get size(): number {
    return this.connections.size;
  }

  /* ----------------------------------------------------------------- internals used by Connection */

  verifyToken(token: string) {
    return this.verify(token);
  }

  async mayJoin(identity: Identity | null, room: LiveRoom): Promise<boolean> {
    if (!identity) return false;
    return this.db().asService((tx) => new LiveRepository(tx).canJoin(identity.userId, room));
  }

  dropped(conn: Connection): void {
    this.connections.delete(conn.id);
  }

  /** Everyone subscribed to a room (with the subscription). */
  members(room: LiveRoom): { conn: Connection; sub: Subscription }[] {
    const out: { conn: Connection; sub: Subscription }[] = [];
    for (const conn of this.connections.values()) {
      for (const sub of conn.subscriptions.values()) if (sub.room && sub.room.kind === room.kind && sub.room.id === room.id) out.push({ conn, sub });
    }
    return out;
  }

  presenceState(room: LiveRoom): Record<string, Record<string, unknown>[]> {
    const state: Record<string, Record<string, unknown>[]> = {};
    for (const { conn, sub } of this.members(room)) {
      if (!sub.tracked || !conn.identity) continue;
      (state[conn.identity.userId] ??= []).push({ ...sub.tracked, presence_ref: `${conn.id}:${sub.id}` });
    }
    return state;
  }

  presenceChanged(room: LiveRoom, event: "join" | "leave", key: string, state: Record<string, unknown>): void {
    const sync = this.presenceState(room);
    for (const { conn, sub } of this.members(room)) {
      if (!sub.presence) continue;
      conn.send({ type: "presence", id: sub.id, event, key, state });
      conn.send({ type: "presence", id: sub.id, event: "sync", state: sync });
    }
  }

  private visibleColumns(table: LiveTable, identity: Identity | null): Promise<string[]> {
    const role = identity ? "authenticated" : "anon";
    const key = `${role}:${table}`;
    let found = this.columns.get(key);
    if (!found) {
      found = this.db().asCaller(identity, (tx) => new LiveRepository(tx).visibleColumns(table));
      found.catch(() => this.columns.delete(key));
      this.columns.set(key, found);
    }
    return found;
  }

  /** One announced change, to every matching subscription. */
  private async dispatch(payload: string): Promise<void> {
    let notice: Notice;
    try {
      notice = JSON.parse(payload) as Notice;
    } catch {
      return;
    }
    if (!isLiveTable(notice.t) || !["INSERT", "UPDATE", "DELETE"].includes(notice.op)) return;
    const table = notice.t;
    const pkOf = (row: Record<string, unknown> | null) => Object.fromEntries(LIVE_TABLES[table].map((c) => [c, row?.[c] ?? null]));
    const base = { type: "change", table, schema: "public", eventType: notice.op, commit_timestamp: notice.at };

    // who is listening for this table and kind of change
    const targets: { conn: Connection; sub: Subscription; spec: ChangeSpec }[] = [];
    for (const conn of this.connections.values()) {
      for (const sub of conn.subscriptions.values()) {
        for (const spec of sub.changes) if (spec.table === table && spec.events.includes(notice.op)) targets.push({ conn, sub, spec });
      }
    }
    if (!targets.length) return;
    const matches = (spec: ChangeSpec, row: Record<string, unknown> | null) => !spec.filter || (row != null && spec.filter.values.includes(String(row[spec.filter.column] ?? "\u0000")));

    if (notice.op === "DELETE") {
      // Only the key leaves the database (the row is gone, so there is nothing to check visibility on); the
      // subscription's filter is checked on the deleted row's id columns.
      for (const { conn, sub, spec } of targets) {
        if (spec.filter && !(spec.filter.column in (notice.old ?? {}))) continue;
        if (matches(spec, notice.old)) conn.send({ ...base, id: sub.id, new: {}, old: pkOf(notice.old) });
      }
      return;
    }

    // Re-read the row once per subscriber (identity), in that subscriber's session.
    const byIdentity = new Map<string, { identity: Identity | null; list: typeof targets }>();
    for (const t of targets) {
      // a filter on an id column that the announcement already shows does not match: no need to read
      if (t.spec.filter && notice.new && t.spec.filter.column in notice.new && !matches(t.spec, notice.new)) continue;
      const key = t.conn.identity ? `u:${t.conn.identity.userId}:${t.conn.identity.sessionId ?? ""}` : "anon";
      const group = byIdentity.get(key) ?? { identity: t.conn.identity, list: [] };
      group.list.push(t);
      byIdentity.set(key, group);
    }
    for (const { identity, list } of byIdentity.values()) {
      let row: Record<string, unknown> | null = null;
      try {
        const columns = await this.visibleColumns(table, identity);
        row = await this.db().asCaller(identity, (tx) => new LiveRepository(tx).row(table, pkOf(notice.new), columns));
      } catch {
        row = null;
      }
      if (!row) continue;
      for (const { conn, sub, spec } of list) {
        if (matches(spec, row)) conn.send({ ...base, id: sub.id, new: row, old: notice.op === "UPDATE" ? pkOf(notice.old) : {} });
      }
    }
  }
}

class Connection implements LiveConnection {
  readonly id = randomUUID();
  readonly subscriptions = new Map<string, Subscription>();
  private window = { start: Date.now(), count: 0 };
  private expiry: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly hub: LiveService,
    private readonly sendRaw: (message: unknown) => void,
    public identity: Identity | null,
  ) {
    this.watchExpiry();
  }

  send(message: unknown): void {
    if (!this.closed) this.sendRaw(message);
  }

  async handle(raw: string): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.window.start > 10_000) this.window = { start: now, count: 0 };
    if (++this.window.count > LIMITS.messagesPer10s) return this.send({ type: "error", message: "Too many messages. Slow down." });
    let parsed: z.infer<typeof ClientMessage>;
    try {
      const result = ClientMessage.safeParse(JSON.parse(raw));
      if (!result.success) return this.send({ type: "error", message: result.error.issues[0]?.message ?? "Invalid message." });
      parsed = result.data;
    } catch {
      return this.send({ type: "error", message: "Messages must be JSON." });
    }
    switch (parsed.type) {
      case "ping":
        return this.send({ type: "pong" });
      case "auth":
        return this.authenticate(parsed.token);
      case "subscribe":
        return this.subscribe(parsed);
      case "unsubscribe":
        return this.unsubscribe(parsed.id);
      case "broadcast":
        return this.broadcast(parsed.id, parsed.event, parsed.payload);
      case "track":
        return this.track(parsed.id, parsed.state);
      case "untrack":
        return this.track(parsed.id, null);
    }
  }

  close(): void {
    if (this.closed) return;
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id, false);
    this.closed = true;
    if (this.expiry) clearTimeout(this.expiry);
    this.hub.dropped(this);
  }

  private async authenticate(token: string | null): Promise<void> {
    const identity = token ? await this.hub.verifyToken(token) : null;
    if (token && !identity) return this.send({ type: "error", ref: "auth", message: "Invalid or expired session. Please log in again." });
    const changed = identity?.userId !== this.identity?.userId;
    this.identity = identity;
    this.watchExpiry();
    // a different person (or signed out): leave the rooms they may not be in
    if (changed) {
      for (const sub of [...this.subscriptions.values()]) {
        if (sub.room && !(await this.hub.mayJoin(identity, sub.room))) {
          this.unsubscribe(sub.id, false);
          this.send({ type: "closed", id: sub.id, reason: "You are not part of this conversation or call." });
        }
      }
    }
    this.send({ type: "authenticated", userId: identity?.userId ?? null });
  }

  /** At the token's expiry the connection continues signed out (as Realtime closed the channels). */
  private watchExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const exp = Number(this.identity?.claims?.exp);
    if (!this.identity || !Number.isFinite(exp)) return;
    const ms = exp * 1000 - Date.now();
    const expire = () => {
      this.send({ type: "auth_expired" });
      void this.authenticate(null);
    };
    if (ms <= 0) return expire();
    this.expiry = setTimeout(expire, Math.min(ms, 2 ** 31 - 1));
    this.expiry.unref?.();
  }

  private async subscribe(m: Extract<z.infer<typeof ClientMessage>, { type: "subscribe" }>): Promise<void> {
    if (!this.subscriptions.has(m.id) && this.subscriptions.size >= LIMITS.subscriptions) return this.send({ type: "error", ref: m.id, message: "Too many subscriptions." });
    const changes: ChangeSpec[] = [];
    for (const c of m.changes) {
      if (!isLiveTable(c.table)) return this.send({ type: "error", ref: m.id, message: `Changes to ${c.table} are not available.` });
      let filter: ChangeSpec["filter"] = null;
      if (c.filter) {
        const [column, rest] = [c.filter.slice(0, c.filter.indexOf("=")), c.filter.slice(c.filter.indexOf("=") + 1)];
        filter = { column, values: rest.startsWith("eq.") ? [rest.slice(3)] : rest.slice(4, -1).split(",").map((v) => v.trim()) };
      }
      changes.push({ events: c.event === "*" ? ["INSERT", "UPDATE", "DELETE"] : [c.event], table: c.table, filter });
    }
    let room: LiveRoom | null = null;
    if (m.room) {
      const [kind, id] = m.room.split(":") as ["conversation" | "call", string];
      if (!UUID.test(id) || !(await this.hub.mayJoin(this.identity, { kind, id }))) {
        return this.send({ type: "error", ref: m.id, message: "You are not part of this conversation or call." });
      }
      room = { kind, id: id.toLowerCase() };
    }
    if (this.subscriptions.has(m.id)) this.unsubscribe(m.id, false);
    this.subscriptions.set(m.id, { id: m.id, changes, room, presence: m.presence, self: m.self, tracked: null });
    this.send({ type: "subscribed", id: m.id });
    if (room && m.presence) this.send({ type: "presence", id: m.id, event: "sync", state: this.hub.presenceState(room) });
  }

  private unsubscribe(id: string, reply = true): void {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    const wasTracked = sub.tracked;
    this.subscriptions.delete(id);
    if (sub.room && wasTracked && this.identity) this.hub.presenceChanged(sub.room, "leave", this.identity.userId, wasTracked);
    if (reply) this.send({ type: "unsubscribed", id });
  }

  private broadcast(id: string, event: string, payload: unknown): void {
    const sub = this.subscriptions.get(id);
    if (!sub?.room || !this.identity) return this.send({ type: "error", ref: id, message: "Join the conversation or call first." });
    for (const { conn, sub: other } of this.hub.members(sub.room)) {
      if (conn === this && (other.id !== id || !sub.self)) continue;
      conn.send({ type: "broadcast", id: other.id, event, payload, from: this.identity.userId });
    }
  }

  private track(id: string, state: Record<string, unknown> | null): void {
    const sub = this.subscriptions.get(id);
    if (!sub?.room || !this.identity) return this.send({ type: "error", ref: id, message: "Join the conversation or call first." });
    if (state && JSON.stringify(state).length > LIMITS.presenceStateBytes) return this.send({ type: "error", ref: id, message: "Presence state is too large." });
    const before = sub.tracked;
    sub.tracked = state ? { ...state, user_id: this.identity.userId } : null;
    if (sub.tracked) this.hub.presenceChanged(sub.room, "join", this.identity.userId, sub.tracked);
    else if (before) this.hub.presenceChanged(sub.room, "leave", this.identity.userId, before);
  }
}
