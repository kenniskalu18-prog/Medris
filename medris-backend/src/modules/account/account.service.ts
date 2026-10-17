import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { AccountDeletionRepository } from "../../database/repositories/account-deletion.repository.js";
import { AccountRepository } from "../../database/repositories/account.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { SupabaseAuthAdmin } from "../../integrations/supabase-auth.js";
import { badRequest, forbidden, notFound, unauthenticated } from "../../shared/errors/app-error.js";
import type { AccountAppeal, ResetStatusResult } from "./account.schemas.js";
import { isSqlBlank } from "../../lib/sql-text.js";

/** The version of the terms and privacy policy a user must accept (same constant as the database functions). */
export const LEGAL_TERMS_VERSION = "2026-10-02";

/** Sets a login password while Supabase Auth still holds the accounts (its admin API). */
export type PasswordSetter = (userId: string, password: string) => Promise<{ ok: boolean; message?: string }>;

/** The signed-in user's own account: terms, role, suspension appeal, sign-in log; and manual password resets. */
export class AccountService {
  constructor(
    private readonly db: () => DataContext,
    private readonly setPassword: PasswordSetter = (userId, password) => SupabaseAuthAdmin.fromEnv().setPassword(userId, password),
  ) {}

  private signedIn(me: Identity | null, message = "Not authenticated"): Identity {
    if (!me) throw unauthenticated(message);
    return me;
  }

  /** Replaces: public.accept_legal_terms() */
  async acceptLegalTerms(me: Identity | null): Promise<{ accepted: true; version: string; accepted_at: string }> {
    const caller = this.signedIn(me);
    const row = await this.db().onBehalfOf(caller, (tx) => new AccountRepository(tx).acceptTerms(caller.userId, LEGAL_TERMS_VERSION));
    if (!row) throw notFound("Account profile not found");
    return { accepted: true, version: LEGAL_TERMS_VERSION, accepted_at: row.accepted_at };
  }

  /** Replaces: public.get_legal_terms_consent() */
  async legalTermsConsent(me: Identity | null): Promise<{ accepted: boolean; version: string | null; accepted_at: string | null; current_version: string }> {
    const caller = this.signedIn(me);
    const row = await this.db().asService((tx) => new AccountRepository(tx).termsConsent(caller.userId));
    if (!row) throw notFound("Account profile not found");
    return {
      accepted: (row.legal_terms_version ?? "") === LEGAL_TERMS_VERSION && row.legal_terms_accepted_at !== null,
      version: row.legal_terms_version,
      accepted_at: row.legal_terms_accepted_at,
      current_version: LEGAL_TERMS_VERSION,
    };
  }

  /** Replaces: public.sync_current_account_role() - re-derives buyer / vendor from the verified shop (admins keep admin). */
  async syncRole(me: Identity | null): Promise<{ role: string }> {
    const caller = this.signedIn(me, "Authentication required.");
    const role = await this.db().onBehalfOf(caller, async (tx) => {
      const resolved = await new AccessRepository(tx).resolvedRole(caller.userId);
      if (!resolved) throw notFound("Account profile not found.");
      await new AccountRepository(tx).setRole(caller.userId, resolved);
      return resolved;
    });
    return { role };
  }

  /** Replaces: public.get_my_account_appeal() - the latest appeal (empty when none or signed out). */
  myAppeal(me: Identity | null): Promise<AccountAppeal[]> {
    return this.db().asService((tx) => new AccountRepository(tx).latestAppeal(me?.userId ?? null));
  }

  /** Replaces: public.submit_account_appeal(text) - and tells every admin. */
  async submitAppeal(me: Identity | null, message: string | null | undefined): Promise<{ done: true }> {
    const userId = me?.userId ?? null;
    const work = async (repo: AccountRepository, notify: NotificationWriter) => {
      const suspension = userId ? await repo.suspension(userId) : null;
      if (!suspension?.suspended_reason) throw badRequest("Your account is not currently suspended.");
      if (await repo.hasPendingAppeal(userId!)) throw badRequest("You already have an appeal pending review.");
      if (isSqlBlank(message)) throw badRequest("Please explain why you're appealing.");
      if ((await repo.appealsInLastDay(userId!)) >= 3) throw badRequest("You've reached the limit of 3 appeals per day. Please try again later.");
      await repo.createAppeal(userId!, suspension.suspended_reason, message);
      for (const admin of await notify.admins()) {
        await notify.create({
          userId: admin.id,
          type: "appeal_submitted",
          title: "New suspension appeal",
          body: `${suspension.name ?? "A user"} has appealed their suspension.`,
          targetView: "adminPeople",
          targetParams: {},
          actorId: userId,
        });
      }
    };
    if (me) await this.db().onBehalfOf(me, (tx) => work(new AccountRepository(tx), new NotificationWriter(tx)));
    else await this.db().asService((tx) => work(new AccountRepository(tx), new NotificationWriter(tx)));
    return { done: true };
  }

  /** Replaces: public.record_auth_activity(text, text) */
  async recordAuthActivity(me: Identity | null, eventType: string, userAgent: string | null | undefined): Promise<{ done: true }> {
    const caller = this.signedIn(me, "Authentication required.");
    if (eventType !== "login" && eventType !== "logout") throw badRequest("Invalid auth event.");
    await this.db().onBehalfOf(caller, (tx) => new AccountRepository(tx).logAuthEvent(caller.userId, eventType, userAgent ?? null));
    return { done: true };
  }

  /* ------------------------------------------------------------ manual password reset (no sign-in) */

  /** Replaces: public.get_manual_password_reset_status(uuid, text) - an expired pending request is marked expired. */
  resetStatus(requestId: string, token: string | null | undefined): Promise<ResetStatusResult> {
    return this.db().asService(async (tx) => {
      const repo = new AccountRepository(tx);
      const request = await repo.resetRequest(requestId, token ?? null);
      if (!request) return { status: "invalid" };
      if (request.status === "pending" && request.expired) {
        await repo.setResetStatus(request.id, "expired", true);
        return { status: "expired" };
      }
      return { status: request.status, email: request.email, expires_at: request.expires_at };
    });
  }

  /**
   * Replaces: public.complete_manual_password_reset(uuid, text, text)
   * The password is set through Supabase Auth's admin API (the function wrote auth.users itself),
   * then the request is completed.
   */
  async completeReset(requestId: string, token: string | null | undefined, newPassword: string | null | undefined): Promise<{ completed: true }> {
    const password = newPassword ?? "";
    // Length in characters, as char_length() counted.
    if ([...password].length < 8) throw badRequest("Password must be at least 8 characters.");
    if ([...password].length > 128) throw badRequest("Password is too long.");
    await this.db().asService(async (tx) => {
      const repo = new AccountRepository(tx);
      const request = await repo.resetRequest(requestId, token ?? null);
      if (!request) throw badRequest("This reset request is invalid.");
      if (request.status !== "approved") throw badRequest("This reset request has not been approved.");
      // The original marked the request expired and then raised, which rolled the mark back: nothing changes.
      if (request.expired) throw badRequest("This reset request has expired.");
      if (!request.user_id) throw badRequest("The account could not be found.");
      const set = await this.setPassword(request.user_id, password);
      if (!set.ok) throw badRequest("The account could not be found.");
      await repo.markHasPassword(request.user_id);
      await repo.setResetStatus(request.id, "completed");
    });
    return { completed: true };
  }

  /** Replaces: public.request_manual_password_reset(text) - creates a request and tells the admins. */
  async requestReset(emailInput: string | null | undefined): Promise<{ request_id: string; token: string; expires_at: string }> {
    const email = (emailInput ?? "").trim().toLowerCase();
    if (email === "" || email.indexOf("@") < 1) throw badRequest("Enter a valid email address.");
    // auth.users is only readable by the connection's own login role (see DataContext.asAuthReader).
    const userId = await this.db().asAuthReader((tx) => new AccountRepository(tx).authUserIdByEmail(email));
    return this.db().asService(async (tx) => {
      const repo = new AccountRepository(tx);
      const notify = new NotificationWriter(tx);
      const created = await repo.createResetRequest(email, userId);
      for (const admin of await notify.admins()) {
        await notify.create({
          userId: admin.id,
          type: "password_reset_request",
          title: "Password reset request",
          body: `A password reset request was received for ${email}. ${admin.is_super_admin ? "Your approval is required." : "The super admin has been notified."}`,
          targetView: admin.is_super_admin ? "adminPasswordResets" : "adminDisputes",
          targetParams: admin.is_super_admin ? { requestId: created.request_id } : {},
          actorId: null,
        });
      }
      return created;
    });
  }

  /**
   * Replaces: public.delete_my_account(uuid) - every public row of the account (shops, orders,
   * conversations, listings...) in an order the foreign keys allow. Only the account itself or an admin.
   */
  async deleteAccountData(me: Identity | null, userId?: string | null): Promise<{ deleted: true; user_id: string }> {
    // Signed out, the original always refused (no caller can be the account or an admin).
    if (!me) throw forbidden("Not authorized to delete this account.");
    const uid = userId ?? me.userId;
    return this.db().onBehalfOf(me, async (tx) => {
      if (me.userId !== uid && !(await new AccessRepository(tx).isAdmin(me.userId))) throw forbidden("Not authorized to delete this account.");
      await new AccountDeletionRepository(tx).deleteEverything(uid);
      return { deleted: true as const, user_id: uid };
    });
  }
}
