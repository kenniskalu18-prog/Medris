import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";
import type { AccountAppeal } from "../../modules/account/account.schemas.js";

/** The signed-in user's own account rows: legal consent, role, appeals, sign-in log, manual password resets. */
export class AccountRepository {
  constructor(private readonly db: Executor) {}

  /** Records consent to the given terms version; the timestamp is the database clock. Null when there is no profile. */
  async acceptTerms(userId: string, version: string): Promise<{ accepted_at: string } | null> {
    const [row] = await jsonReturning<{ accepted_at: string }>(
      this.db,
      sql`update public.users set legal_terms_version = ${version}, legal_terms_accepted_at = now() where id = ${userId} returning legal_terms_accepted_at as accepted_at`,
    );
    return row ?? null;
  }

  termsConsent(userId: string): Promise<{ legal_terms_version: string | null; legal_terms_accepted_at: string | null } | null> {
    return jsonRow(this.db, sql`select legal_terms_version, legal_terms_accepted_at from public.users where id = ${userId}`);
  }

  /** Sets the role unless the account is an admin or already has it. */
  async setRole(userId: string, role: string): Promise<void> {
    await this.db.execute(sql`update public.users set role = ${role}::public.user_role where id = ${userId} and role <> 'admin' and role is distinct from ${role}::public.user_role`);
  }

  latestAppeal(userId: string | null): Promise<AccountAppeal[]> {
    return jsonRows<AccountAppeal>(
      this.db,
      sql`select id, message, status, admin_response, created_at from public.account_appeals where user_id = ${userId}::uuid order by created_at desc limit 1`,
    );
  }

  suspension(userId: string): Promise<{ suspended_reason: string | null; name: string | null } | null> {
    return jsonRow(this.db, sql`select suspended_reason, name from public.users where id = ${userId} and suspended_at is not null`);
  }

  async hasPendingAppeal(userId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.account_appeals where user_id = ${userId} and status = 'pending'`)) !== null;
  }

  async appealsInLastDay(userId: string): Promise<number> {
    const row = await jsonRow<{ n: number }>(
      this.db,
      sql`select count(*)::int as n from public.account_appeals where user_id = ${userId} and created_at > now() - interval '24 hours'`,
    );
    return row?.n ?? 0;
  }

  async createAppeal(userId: string, reason: string, message: string): Promise<void> {
    await this.db.execute(sql`insert into public.account_appeals (user_id, suspension_reason, message) values (${userId}, ${reason}, ${message})`);
  }

  async logAuthEvent(userId: string, eventType: string, userAgent: string | null): Promise<void> {
    await this.db.execute(sql`insert into public.auth_activity_logs (user_id, event_type, occurred_at, user_agent, source)
                              values (${userId}, ${eventType}, now(), left(${userAgent}, 1000), 'app')`);
  }

  /* ------------------------------------------------------------ manual password reset */

  /** The request matching id + token (the token is stored as its SHA-256 hex digest). */
  resetRequest(requestId: string, token: string | null): Promise<{ id: string; status: string; email: string; expired: boolean; user_id: string | null; expires_at: string } | null> {
    return jsonRow(
      this.db,
      sql`select id, status, email, user_id, expires_at, (expires_at < now()) as expired
          from public.password_reset_requests
          where id = ${requestId} and token_hash = encode(extensions.digest(coalesce(${token}, ''), 'sha256'), 'hex')
          limit 1
          for update`,
    );
  }

  async setResetStatus(requestId: string, status: string, onlyIfPending = false): Promise<void> {
    await this.db.execute(
      sql`update public.password_reset_requests set status = ${status}, completed_at = case when ${status} = 'completed' then now() else completed_at end
          where id = ${requestId} ${onlyIfPending ? sql`and status = 'pending'` : sql``}`,
    );
  }

  async markHasPassword(userId: string): Promise<void> {
    await this.db.execute(sql`update public.users set has_password = true where id = ${userId}`);
  }

  async authUserIdByEmail(email: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from auth.users where lower(email) = ${email} limit 1`);
    return row?.id ?? null;
  }

  /** Creates a request with a fresh random token; returns the id, the token and its expiry (30 minutes). */
  async createResetRequest(email: string, userId: string | null): Promise<{ request_id: string; token: string; expires_at: string }> {
    const [row] = await jsonReturning<{ request_id: string; token: string; expires_at: string }>(
      this.db,
      sql`with t as (select encode(extensions.gen_random_bytes(32), 'hex') as token)
          insert into public.password_reset_requests (email, user_id, token_hash)
          select ${email}, ${userId}::uuid, encode(extensions.digest(t.token, 'sha256'), 'hex') from t
          returning id as request_id, (select token from t) as token, now() + interval '30 minutes' as expires_at`,
    );
    return row!;
  }
}
