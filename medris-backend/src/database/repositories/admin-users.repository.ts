import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";
import type { PasswordResetRequestRow, PendingAppeal } from "../../modules/admin-users/admin-users.schemas.js";

/** Admin work on accounts: appeals, suspensions, roles, manual password resets. */
export class AdminUsersRepository {
  constructor(private readonly db: Executor) {}

  pendingAppeals(): Promise<PendingAppeal[]> {
    return jsonRows<PendingAppeal>(
      this.db,
      sql`select a.id, a.user_id, u.name as user_name, u.email as user_email, a.suspension_reason, a.message, a.created_at
          from public.account_appeals a join public.users u on u.id = a.user_id
          where a.status = 'pending'
          order by a.created_at asc`,
    );
  }

  /** Denies a pending appeal; returns its user, or null when it was not pending. */
  async denyAppeal(appealId: string, response: string, adminId: string): Promise<string | null> {
    const [row] = await jsonReturning<{ user_id: string }>(
      this.db,
      sql`update public.account_appeals set status = 'denied', admin_response = ${response}, resolved_at = now(), resolved_by = ${adminId}
          where id = ${appealId} and status = 'pending' returning user_id`,
    );
    return row?.user_id ?? null;
  }

  nameAndEmail(userId: string): Promise<{ name: string | null; email: string | null } | null> {
    return jsonRow(this.db, sql`select name, email from public.users where id = ${userId}`);
  }

  async suspend(userId: string, reason: string, adminId: string): Promise<void> {
    await this.db.execute(sql`update public.users set suspended_at = now(), suspended_reason = ${reason}, suspended_by = ${adminId} where id = ${userId}`);
    await this.db.execute(sql`update public.vendors set is_active = false where user_id = ${userId}`);
  }

  async unsuspend(userId: string, adminId: string): Promise<void> {
    await this.db.execute(sql`update public.users set suspended_at = null, suspended_reason = null, suspended_by = null where id = ${userId}`);
    await this.db.execute(
      sql`update public.account_appeals set status = 'approved', resolved_at = now(), resolved_by = ${adminId} where user_id = ${userId} and status = 'pending'`,
    );
  }

  /** The account with exactly this e-mail (as the function looked it up). */
  byEmail(email: string): Promise<{ id: string; is_super_admin: boolean | null } | null> {
    return jsonRow(this.db, sql`select id, is_super_admin from public.users where email = ${email} limit 1`);
  }

  async setRole(userId: string, role: string): Promise<number> {
    const rows = await jsonReturning(this.db, sql`update public.users set role = ${role}::public.user_role where id = ${userId} returning id`);
    return rows.length;
  }

  resetRequests(): Promise<PasswordResetRequestRow[]> {
    return jsonRows<PasswordResetRequestRow>(
      this.db,
      sql`select r.id, r.email, r.user_id, u.name as user_name, r.status, r.created_at, r.approved_at, r.rejected_at, r.completed_at, r.expires_at
          from public.password_reset_requests r left join public.users u on u.id = r.user_id
          order by r.created_at desc
          limit 100`,
    );
  }

  /** Approves a pending, unexpired request of a known account; false when there is none. */
  async approveReset(requestId: string, adminId: string): Promise<boolean> {
    const rows = await jsonReturning(
      this.db,
      sql`update public.password_reset_requests set status = 'approved', approved_at = now(), approved_by = ${adminId}
          where id = ${requestId} and status = 'pending' and expires_at >= now() and user_id is not null returning id`,
    );
    return rows.length > 0;
  }

  async rejectReset(requestId: string, adminId: string): Promise<boolean> {
    const rows = await jsonReturning(
      this.db,
      sql`update public.password_reset_requests set status = 'rejected', rejected_at = now(), rejected_by = ${adminId}
          where id = ${requestId} and status = 'pending' returning id`,
    );
    return rows.length > 0;
  }
}
