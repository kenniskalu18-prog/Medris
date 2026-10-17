import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../src/database/client.js";
import { rowsOf } from "../../src/database/client.js";
import { DataContext, type Identity } from "../../src/database/context.js";
import { callFunction } from "../../src/database/rpc.js";
import { findPgError } from "../../src/database/errors.js";
import type { TestDatabase } from "./test-db.js";

/**
 * Parity kit: proves that a backend port behaves like the database function it
 * replaces.
 *
 * Each side runs inside its own transaction that is always rolled back, on the
 * same seeded data, so both start from exactly the same rows:
 *
 *   const original = await runOriginal(db, me, "toggle_vendor_follow", { p_vendor_id, p_following: true });
 *   const port = await runIsolated(db, (ctx) => new FollowsService(() => ctx).setFollowing(me, vendorId, true));
 *   const { original: a, port: b } = comparable(original, port, { result: ... });
 *   expect(b).toEqual(a);
 *
 * What is compared: the result (or the error message), and every row inserted,
 * updated or deleted in every table of public (and the webhook calls recorded in
 * net.http_requests). Values that differ between any two
 * runs by nature - new ids, timestamps, random references - are masked
 * (`volatile`), so a difference left over is a real difference in behaviour.
 */

export interface RunOutcome<T = unknown> {
  result?: T;
  error?: { message: string; code?: string };
  changes: Record<string, TableChanges>;
}

export interface TableChanges {
  inserted: Record<string, unknown>[];
  updated: { before: Record<string, unknown>; after: Record<string, unknown> }[];
  deleted: Record<string, unknown>[];
}

class Rollback<T> extends Error {
  constructor(readonly outcome: RunOutcome<T>) {
    super("parity rollback");
  }
}

/** Every table in public, plus the webhook calls the database made (net.http_requests). */
async function allTables(tx: Db): Promise<string[]> {
  const rows = rowsOf<{ name: string }>(
    await tx.execute(sql`select 'public.' || tablename as name from pg_tables where schemaname = 'public' order by 1`),
  );
  return [...rows.map((r) => r.name), "net.http_requests"];
}

async function capture(tx: Db, tables: string[] | "all"): Promise<Record<string, Map<string, Record<string, unknown>>>> {
  // The work may have switched role / claims / time zone for the rest of the transaction;
  // snapshots are always taken as the owner and rendered in UTC so they compare.
  await tx.execute(sql`reset role`);
  await tx.execute(sql`select set_config('timezone', 'UTC', true)`);
  if (tables === "all") tables = await allTables(tx);
  const out: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const table of tables) {
    const qualified = table.includes(".") ? table : `public.${table}`;
    const rows = rowsOf<{ row: Record<string, unknown> }>(await tx.execute(sql.raw(`select to_jsonb(t) as row from ${qualified} t`)));
    const map = new Map<string, Record<string, unknown>>();
    for (const { row } of rows) map.set(rowKey(row), row);
    out[table.replace(/^public\./, "")] = map;
  }
  return out;
}

function rowKey(row: Record<string, unknown>): string {
  return "id" in row ? String(row.id) : JSON.stringify(row);
}

function diff(
  before: Record<string, Map<string, Record<string, unknown>>>,
  after: Record<string, Map<string, Record<string, unknown>>>,
): Record<string, TableChanges> {
  const out: Record<string, TableChanges> = {};
  for (const table of Object.keys(before)) {
    const b = before[table]!;
    const a = after[table]!;
    const changes: TableChanges = { inserted: [], updated: [], deleted: [] };
    for (const [key, row] of a) {
      const old = b.get(key);
      if (!old) changes.inserted.push(row);
      else if (JSON.stringify(old) !== JSON.stringify(row)) changes.updated.push({ before: old, after: row });
    }
    for (const [key, row] of b) if (!a.has(key)) changes.deleted.push(row);
    out[table] = changes;
  }
  return out;
}

/** Runs `work` on a DataContext bound to a transaction that is always rolled back; returns what it did. */
export async function runIsolated<T>(testDb: TestDatabase, work: (ctx: DataContext) => Promise<T>, tables: string[] | "all" = "all"): Promise<RunOutcome<T>> {
  try {
    await testDb.db.transaction(async (outer) => {
      const tx = outer as unknown as Db;
      const before = await capture(tx, tables);
      const outcome: RunOutcome<T> = { changes: {} };
      try {
        outcome.result = await work(new DataContext(tx));
      } catch (err) {
        const pg = findPgError(err);
        const appError = err as { message?: string; code?: string };
        outcome.error = { message: pg?.message ?? appError.message ?? String(err), code: pg?.code ?? appError.code };
      }
      outcome.changes = diff(before, await capture(tx, tables));
      throw new Rollback(outcome);
    });
  } catch (err) {
    if (err instanceof Rollback) return err.outcome as RunOutcome<T>;
    throw err;
  }
  throw new Error("unreachable");
}

/** The original database function, run as the caller - what the browser's sb.rpc() did. */
export function runOriginal(testDb: TestDatabase, caller: Identity | null, name: string, args: Record<string, unknown> = {}) {
  return runIsolated(testDb, (ctx) => ctx.asCaller(caller, (tx) => callFunction(tx, name, args)));
}

/**
 * The browser's table query (`sb.from(...)`), as PostgREST ran it: the equivalent SQL, as the caller
 * (role authenticated or anon, with their claims), so the table's row-level security, defaults and
 * triggers apply exactly as they did. Statements with RETURNING, and SELECTs, give their rows;
 * anything else gives null.
 */
export function runTableQuery(testDb: TestDatabase, caller: Identity | null, query: SQL, returnsRows = true) {
  return runIsolated(testDb, (ctx) =>
    ctx.asCaller(caller, async (tx) => {
      if (!returnsRows) {
        await tx.execute(query);
        return null;
      }
      const rows = rowsOf<{ row: unknown }>(await tx.execute(sql`with w as (${query}) select to_json(w) as row from w`));
      return rows.map((r) => r.row);
    }),
  );
}

/**
 * A helper the app never calls itself (award_points, finalize_points_weeks...), run the way the
 * functions and triggers that use it do: inside a SECURITY DEFINER context, so with full rights and,
 * when given, the signed-in user's id visible to auth.uid().
 */
export function runOriginalAsService(testDb: TestDatabase, name: string, args: Record<string, unknown> = {}, caller: Identity | null = null) {
  return runIsolated(testDb, (ctx) => (caller ? ctx.onBehalfOf(caller, (tx) => callFunction(tx, name, args)) : ctx.asService((tx) => callFunction(tx, name, args))));
}

/* ---------------------------------------------------------------- compare */

export interface CompareOptions {
  /** Columns whose values are masked everywhere (in addition to timestamps and new ids). */
  volatile?: (string | RegExp)[];
  /** Turns the result into something comparable (e.g. drop a generated id). */
  result?: (value: unknown) => unknown;
}

function maskRow(row: Record<string, unknown>, isNew: boolean, extra: (string | RegExp)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const extraHit = extra.some((m) => (typeof m === "string" ? m === key : m.test(key)));
    const newId = isNew && key === "id";
    out[key] = extraHit || newId ? "<volatile>" : maskTimestamps(value);
  }
  return out;
}

/** Timestamps anywhere in a value - also inside json columns (e.g. a proposal's proposed_at). */
function maskTimestamps(value: unknown): unknown {
  if (typeof value === "string") return ISO_TIMESTAMP.test(value) ? "<volatile>" : value;
  if (Array.isArray(value)) return value.map(maskTimestamps);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskTimestamps(v)]));
  return value;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalise(outcome: RunOutcome, options: CompareOptions) {
  const extra = options.volatile ?? [];
  // Ids of rows created during the run differ between runs, and so does every reference to them
  // (a notification id inside a webhook body, a new order id in the result...).
  const created = new Set<string>();
  for (const c of Object.values(outcome.changes)) for (const row of c.inserted) if (typeof row.id === "string") created.add(row.id);
  const unmask = (json: string) => json.replace(UUID, (id) => (created.has(id) ? "<new-id>" : id));
  const changes: Record<string, unknown> = {};
  for (const [table, c] of Object.entries(outcome.changes)) {
    const sortJson = (rows: unknown[]) => rows.map((r) => unmask(JSON.stringify(r))).sort();
    changes[table] = {
      inserted: sortJson(c.inserted.map((r) => maskRow(r, true, extra))),
      updated: sortJson(c.updated.map((u) => ({ before: maskRow(u.before, false, extra), after: maskRow(u.after, false, extra) }))),
      deleted: sortJson(c.deleted.map((r) => maskRow(r, false, extra))),
    };
  }
  // Results are compared as JSON, the form both reach the browser in. Errors by message: the backend
  // reports the same message with an HTTP status instead of a SQLSTATE.
  const maskDeep = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(maskDeep)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, extra.some((m) => (typeof m === "string" ? m === k : m.test(k))) ? "<volatile>" : maskDeep(v)]),
          )
        : typeof value === "string" && ISO_TIMESTAMP.test(value)
          ? "<volatile>"
          : value;
  const result = outcome.error ? undefined : maskDeep(JSON.parse(unmask(JSON.stringify(outcome.result ?? null))));
  return {
    result: options.result ? options.result(result) : result,
    error: outcome.error ? outcome.error.message : undefined,
    changes,
  };
}

/** The comparable form of two outcomes: equal means the port behaves like the original. */
export function comparable(original: RunOutcome, port: RunOutcome, options: CompareOptions = {}) {
  return { original: normalise(original, options), port: normalise(port, options) };
}

/**
 * Both sides refused and changed nothing. For callers the original never accepted
 * at all (e.g. a function not granted to signed-out visitors, where PostgreSQL said
 * "permission denied" and the port gives its own message).
 */
export function bothRefused(original: RunOutcome, port: RunOutcome): boolean {
  const unchanged = (o: RunOutcome) => Object.values(o.changes).every((c) => !c.inserted.length && !c.updated.length && !c.deleted.length);
  return Boolean(original.error && port.error && unchanged(original) && unchanged(port));
}
