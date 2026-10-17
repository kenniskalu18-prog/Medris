import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "./client.js";
import { rowsOf } from "./client.js";

/**
 * Calls a database function the way Supabase's REST API (`rpc/<name>`) did:
 * arguments by name (`p_order_id => $1`), each sent untyped so PostgreSQL
 * resolves the function and converts the values exactly as it did for
 * PostgREST, and the result shaped the same way:
 *
 *   returns setof / table  -> JSON array of rows
 *   returns a row or value -> that value as JSON
 *   returns void           -> null
 *
 * A JavaScript array sent to an array parameter (uuid[], text[]...) becomes a
 * PostgreSQL array, as PostgREST converted it; objects and arrays sent to any
 * other parameter (json / jsonb) are sent as JSON text.
 */

const NAME = /^[a-z_][a-z0-9_]*$/;
interface Shape {
  setof: boolean;
  void: boolean;
  /** Names of the parameters declared as arrays (any overload). */
  arrayArgs: Set<string>;
}
const shapeCache = new Map<string, Shape>();

async function shapeOf(db: Executor, name: string): Promise<Shape> {
  const cached = shapeCache.get(name);
  if (cached) return cached;
  const rows = rowsOf<{ setof: boolean; rettype: string; array_args: string[] | null }>(
    await db.execute(sql`
      select p.proretset as setof, p.prorettype::regtype::text as rettype,
             (select array_agg(a.name) from unnest(p.proargnames, p.proargtypes::oid[]) as a(name, type)
               join pg_type t on t.oid = a.type where t.typcategory = 'A') as array_args
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${name}
      order by p.oid`),
  );
  if (!rows[0]) throw Object.assign(new Error(`function public.${name} does not exist`), { code: "42883" });
  const shape = {
    setof: Boolean(rows[0].setof),
    void: rows[0].rettype === "void",
    arrayArgs: new Set(rows.flatMap((r) => r.array_args ?? [])),
  };
  shapeCache.set(name, shape);
  return shape;
}

/** A PostgreSQL array literal ('{"a","b"}'); null elements stay NULL. */
export function pgArrayLiteral(values: readonly unknown[]): string {
  const element = (v: unknown) => (v === null || v === undefined ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${values.map(element).join(",")}}`;
}

function toParam(value: unknown, isArrayParam: boolean): unknown {
  if (value === undefined) return null;
  if (isArrayParam && Array.isArray(value)) return pgArrayLiteral(value);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

export async function callFunction<T = unknown>(db: Executor, name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!NAME.test(name)) throw new Error(`Invalid function name: ${name}`);
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  for (const [key] of entries) if (!NAME.test(key)) throw new Error(`Invalid argument name: ${key}`);
  const shape = await shapeOf(db, name);
  const argList: SQL = entries.length
    ? sql.join(
        entries.map(([key, value]) => sql`${sql.raw(key)} => ${toParam(value, shape.arrayArgs.has(key))}`),
        sql`, `,
      )
    : sql``;
  const fn = sql`public.${sql.raw(name)}(${argList})`;

  if (shape.void) {
    await db.execute(sql`select ${fn}`);
    return null as T;
  }
  if (shape.setof) {
    const rows = rowsOf<{ result: T }>(await db.execute(sql`select coalesce(json_agg(to_json(r)), '[]'::json) as result from ${fn} r`));
    return rows[0]!.result;
  }
  const rows = rowsOf<{ result: T }>(await db.execute(sql`select to_json(r) as result from ${fn} r`));
  return (rows[0]?.result ?? null) as T;
}
