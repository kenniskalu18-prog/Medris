import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { AdminLog } from "../../database/repositories/admin-log.repository.js";
import { AdminUsersRepository } from "../../database/repositories/admin-users.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";
import type { PasswordResetRequestRow, PendingAppeal } from "./admin-users.schemas.js";
import { isSqlBlank } from "../../lib/sql-text.js";

interface Tools {
  repo: AdminUsersRepository;
  access: AccessRepository;
  notify: NotificationWriter;
  log: AdminLog;
}

/** Admin work on accounts. Every method checks the caller is an admin (or the super admin) first. */
export class AdminUsersService {
  constructor(private readonly db: () => DataContext) {}

  /** Runs as the admin (on their behalf: triggers see them), after the admin check. */
  private async asAdmin<T>(me: Identity | null, level: "admin" | "super", message: string, work: (t: Tools) => Promise<T>): Promise<T> {
    if (!me) throw forbidden(message);
    return this.db().onBehalfOf(me, async (tx) => {
      const access = new AccessRepository(tx);
      const allowed = level === "super" ? await access.isSuperAdmin(me.userId) : await access.isAdmin(me.userId);
      if (!allowed) throw forbidden(message);
      return work({ repo: new AdminUsersRepository(tx), access, notify: new NotificationWriter(tx), log: new AdminLog(tx) });
    });
  }

  /**
   * Replaces: public.admin_get_pending_appeals()
   * FIX (BASELINE_FINDINGS S1): the original had no admin check and was callable by anyone; admins only now.
   */
  pendingAppeals(me: Identity | null): Promise<PendingAppeal[]> {
    return this.asAdmin(me, "admin", "not authorized", ({ repo }) => repo.pendingAppeals());
  }

  /** Replaces: public.admin_deny_appeal(uuid, text) - the user is told why. */
  async denyAppeal(me: Identity | null, appealId: string, response: string | null | undefined): Promise<{ done: true }> {
    await this.asAdmin(me, "admin", "not authorized", async ({ repo, notify }) => {
      if (isSqlBlank(response)) throw badRequest("A reason is required to deny an appeal.");
      const userId = await repo.denyAppeal(appealId, response, me!.userId);
      if (!userId) throw notFound("Appeal not found or already resolved.");
      await notify.create({ userId, type: "appeal_denied", title: "Your appeal was not approved", body: response, targetView: "editProfile", targetParams: {}, actorId: me!.userId });
    });
    return { done: true };
  }

  /** Replaces: public.admin_suspend_user(uuid, text) - also hides their shops, logs it and tells them. */
  async suspend(me: Identity | null, userId: string, reason: string | null | undefined): Promise<{ done: true }> {
    await this.asAdmin(me, "admin", "not authorized", async ({ repo, notify, log }) => {
      if (isSqlBlank(reason)) throw badRequest("a reason is required to suspend an account");
      await repo.suspend(userId, reason, me!.userId);
      const target = await repo.nameAndEmail(userId);
      await log.record(me!.userId, "suspend_user", "user", userId, `${target?.name ?? target?.email ?? "user"} — ${reason}`);
      await notify.create({ userId, type: "account_suspended", title: "Your account has been suspended", body: reason, targetView: "editProfile", targetParams: {}, actorId: me!.userId });
    });
    return { done: true };
  }

  /** Replaces: public.admin_unsuspend_user(uuid) - approves their pending appeal, logs it and tells them. */
  async unsuspend(me: Identity | null, userId: string): Promise<{ done: true }> {
    await this.asAdmin(me, "admin", "not authorized", async ({ repo, notify, log }) => {
      await repo.unsuspend(userId, me!.userId);
      const target = await repo.nameAndEmail(userId);
      await log.record(me!.userId, "unsuspend_user", "user", userId, target?.name ?? target?.email ?? "user");
      await notify.create({
        userId,
        type: "account_unsuspended",
        title: "Your account has been reinstated",
        body: "Your account is active again.",
        targetView: "home",
        targetParams: {},
        actorId: me!.userId,
      });
    });
    return { done: true };
  }

  /** Replaces: public.admin_set_user_role(text, text) - the super admin only; the protected super admin cannot be demoted by others. */
  async setRole(me: Identity | null, email: string, role: string): Promise<{ done: true }> {
    await this.asAdmin(me, "super", "Only the super admin can change admin roles", async ({ repo, notify, log }) => {
      if (!["buyer", "vendor", "admin"].includes(role)) throw badRequest(`Invalid role: ${role}`);
      const target = await repo.byEmail(email);
      if (!target) throw notFound(`No user found with email ${email}`);
      if (target.is_super_admin && role !== "admin" && target.id !== me!.userId) {
        throw forbidden("This admin account is protected. Only that account itself can remove its own admin access.");
      }
      if ((await repo.setRole(target.id, role)) === 0) throw notFound(`No user found with email ${email}`);
      const promoted = role === "admin";
      await log.record(me!.userId, promoted ? "promote_admin" : "demote_admin", "user", target.id, email);
      await notify.create({
        userId: target.id,
        type: promoted ? "promoted_admin" : "demoted_admin",
        title: promoted ? "You were made an admin" : "Your admin access was removed",
        body: promoted ? "You can now approve vendors, resolve disputes, and manage other admins." : `Your account is now a regular ${role} account.`,
        targetView: "home",
        targetParams: {},
        actorId: me!.userId,
      });
    });
    return { done: true };
  }

  /** Replaces: public.admin_get_manual_password_reset_requests() - the latest 100 (super admin). */
  resetRequests(me: Identity | null): Promise<PasswordResetRequestRow[]> {
    return this.asAdmin(me, "super", "Super admin access required.", ({ repo }) => repo.resetRequests());
  }

  /** Replaces: public.admin_approve_manual_password_reset(uuid) */
  async approveReset(me: Identity | null, requestId: string): Promise<{ ok: true }> {
    await this.asAdmin(me, "super", "Super admin access required.", async ({ repo }) => {
      if (!(await repo.approveReset(requestId, me!.userId))) throw badRequest("Request is no longer pending, has expired, or the account was not found.");
    });
    return { ok: true };
  }

  /** Replaces: public.admin_reject_manual_password_reset(uuid) */
  async rejectReset(me: Identity | null, requestId: string): Promise<{ ok: true }> {
    await this.asAdmin(me, "super", "Super admin access required.", async ({ repo }) => {
      if (!(await repo.rejectReset(requestId, me!.userId))) throw badRequest("Request is no longer pending.");
    });
    return { ok: true };
  }
}
