import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";

/**
 * Runs queries with the same identity context Supabase's REST API used.
 *
 * Every row-level-security policy (149) and SECURITY DEFINER function (265) in
 * the database decides access with auth.uid(), which reads the
 * `request.jwt.claims` setting. PostgREST set that setting and switched to the
 * `authenticated` / `anon` role at the start of each request; DataContext does
 * exactly the same inside a transaction:
 *
 *   asUser(identity, work)  role authenticated, claims = the caller's verified claims
 *   asAnon(work)            role anon, no claims (signed-out visitors)
 *   asService(work)         role service_role (bypasses RLS) - only for server
 *                           jobs and for code that has already authorised the
 *                           caller itself (webhooks, cron, payments)
 *   onBehalfOf(identity, work)
 *                           role service_role with the caller's claims: what a
 *                           SECURITY DEFINER database function runs as. RLS is
 *                           bypassed (the service has authorised the caller),
 *                           while auth.uid() - and so every trigger and helper
 *                           that reads it - still sees the caller.
 *
 * All settings are transaction-local (set_config(..., true)), so nothing leaks
 * between requests that share a pooled connection, including through
 * Supabase's transaction-mode pooler.
 */

export type DbRole = "anon" | "authenticated" | "service_role";

export interface Identity {
  userId: string;
  email: string | null;
  /** Claims as Postgres sees them through auth.uid() / auth.jwt(). */
  claims: Record<string, unknown>;
  source: "supabase-jwt" | "backend-session";
  sessionId?: string;
}

export interface DataContextOptions {
  statementTimeoutMs?: number;
}

export class DataContext {
  constructor(
    readonly db: Db,
    private readonly options: DataContextOptions = {},
  ) {}

  asUser<T>(identity: Identity, work: (tx: Tx) => Promise<T>): Promise<T> {
    const claims = { ...identity.claims, sub: identity.userId, role: "authenticated" };
    return this.run("authenticated", claims, work);
  }

  /**
   * Elevated work done for a signed-in caller, the way the database's SECURITY
   * DEFINER functions ran it: service_role (no RLS) with the caller's identity in
   * the claims. Use only after the service itself has checked the caller may do it.
   */
  onBehalfOf<T>(identity: Identity, work: (tx: Tx) => Promise<T>): Promise<T> {
    const claims = { ...identity.claims, sub: identity.userId, role: "authenticated" };
    return this.run("service_role", claims, work);
  }

  asAnon<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run("anon", { role: "anon" }, work);
  }

  asService<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run("service_role", { role: "service_role" }, work);
  }

  /**
   * As the connection's own login role, without switching to an API role.
   * Only for reading Supabase Auth's tables (auth.users / auth.identities),
   * which the API roles cannot see; see migration 0001 for the grants.
   */
  asAuthReader<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // `reset role`: back to the login role even when an enclosing transaction switched it.
      await tx.execute(sql`reset role`);
      await tx.execute(sql`select set_config('request.jwt.claims', '', true), set_config('timezone', 'UTC', true)`);
      return work(tx);
    });
  }

  /** As the signed-in user when there is one, otherwise as anon. */
  asCaller<T>(identity: Identity | null | undefined, work: (tx: Tx) => Promise<T>): Promise<T> {
    return identity ? this.asUser(identity, work) : this.asAnon(work);
  }

  /** Readiness probe: a round trip plus the role memberships the API relies on. */
  async probe(): Promise<{ ok: boolean; roles: Record<DbRole, boolean>; latencyMs: number }> {
    const started = Date.now();
    const result = await this.db.execute(sql`
      select pg_has_role(current_user, 'anon', 'MEMBER') as anon,
             pg_has_role(current_user, 'authenticated', 'MEMBER') as authenticated,
             pg_has_role(current_user, 'service_role', 'MEMBER') as service_role`);
    const row = ((result as { rows?: Record<string, boolean>[] }).rows ?? [])[0] ?? {};
    const roles = { anon: Boolean(row.anon), authenticated: Boolean(row.authenticated), service_role: Boolean(row.service_role) };
    return { ok: roles.anon && roles.authenticated && roles.service_role, roles, latencyMs: Date.now() - started };
  }

  private run<T>(role: DbRole, claims: Record<string, unknown>, work: (tx: Tx) => Promise<T>): Promise<T> {
    const claimsJson = JSON.stringify(claims);
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const timeout = this.options.statementTimeoutMs ? `${this.options.statementTimeoutMs}ms` : null;
    return this.db.transaction(async (tx) => {
      // `role` is one of three fixed literals (DbRole); set_config takes it as a bound parameter anyway.
      await tx.execute(sql`
        select set_config('role', ${role}, true),
               set_config('request.jwt.claims', ${claimsJson}, true),
               set_config('request.jwt.claim.sub', ${sub}, true),
               set_config('request.jwt.claim.role', ${typeof claims.role === "string" ? claims.role : role}, true),
               set_config('timezone', 'UTC', true)
               ${timeout ? sql`, set_config('statement_timeout', ${timeout}, true)` : sql``}`);
      return work(tx);
    });
  }
}
