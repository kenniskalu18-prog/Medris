import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { CommissionRepository } from "../../database/repositories/commission.repository.js";
import { MonthlyListingsRepository, type ListingKind } from "../../database/repositories/monthly-listings.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { isSqlBlank, sqlTrim } from "../../lib/sql-text.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

/** Commission owed to Levromart, its deadlines and reminders, and ₦1,000 monthly listings. */
export class CommissionService {
  constructor(private readonly db: () => DataContext) {}

  private run<T>(me: Identity | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    return me ? this.db().onBehalfOf(me, work) : this.db().asService(work);
  }

  private async ownerOrAdmin(tx: Tx, me: Identity | null, vendorId: string): Promise<boolean> {
    const access = new AccessRepository(tx);
    return (await access.ownsVendor(me?.userId, vendorId)) || (await access.isAdmin(me?.userId));
  }

  /** Replaces: public.get_vendor_commission_owed(uuid) - the shop owner or an admin. */
  async owed(me: Identity | null, vendorId: string): Promise<{ owed: number }> {
    return this.db().asService(async (tx) => {
      if (!(await this.ownerOrAdmin(tx, me, vendorId))) throw forbidden("not authorized");
      return { owed: Number(await new CommissionRepository(tx).owed(vendorId)) };
    });
  }

  /** Replaces: public.get_vendor_commission_deadline(uuid) - the owner's total and earliest due time (zero for anyone else). */
  deadline(me: Identity | null, vendorId: string): Promise<{ total_owed: number; earliest_due_at: string | null }[]> {
    return this.db().asService((tx) => new CommissionRepository(tx).deadline(vendorId, me?.userId ?? null));
  }

  /** Replaces: public.get_vendor_commission_breakdown(uuid) - each owed charge with its sale. */
  async breakdown(me: Identity | null, vendorId: string): Promise<Record<string, unknown>[]> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).ownsLiveVendor(me.userId, vendorId))) throw forbidden("Not authorized.");
      return new CommissionRepository(tx).breakdown(vendorId);
    });
  }

  /** Replaces: public.create_commission_payment_intent(uuid) - the whole owed amount as one payment (reference "commission_..."). */
  async paymentIntent(me: Identity | null, vendorId: string): Promise<{ reference: string; amount: number }[]> {
    return this.run(me, async (tx) => {
      if (!(await new AccessRepository(tx).ownsVendor(me?.userId, vendorId))) throw forbidden("not authorized");
      const commission = new CommissionRepository(tx);
      const owed = await commission.owedRounded(vendorId);
      if (Number(owed) <= 0) throw badRequest("No commission currently owed.");
      const reference = `commission_${crypto.randomUUID().replace(/-/g, "")}`;
      await commission.createSettlement(vendorId, owed, reference);
      return [{ reference, amount: Number(owed) }];
    });
  }

  /** Replaces: public.compute_monthly_billing_amount(uuid) */
  monthlyBillingAmount(vendorId: string): Promise<{ listing_count: number; amount: number }[]> {
    return this.db().asService((tx) => new CommissionRepository(tx).monthlyBillingAmount(vendorId));
  }

  /**
   * Replaces: public.enforce_commission_deadlines(uuid) - pause storefronts whose commission is overdue
   * (₦100 or more) and reopen the ones that paid; for one shop (owner or admin), or all (the job).
   */
  async enforceDeadlines(me: Identity | null, vendorId: string | null): Promise<{ changed: number }> {
    return this.run(me, async (tx) => {
      if (vendorId != null && !(await this.ownerOrAdmin(tx, me, vendorId))) throw forbidden("not authorized");
      const { paused, reopened } = await new CommissionRepository(tx).enforce(vendorId);
      const notify = new NotificationWriter(tx);
      for (const shop of paused) {
        await notify.notifyAdmins(
          "Storefront paused: commission overdue",
          `${shop.business_name ?? "A vendor"}'s storefront was automatically paused because their commission balance is overdue.`,
          "adminPanel",
          { vendorId: shop.id },
          null,
        );
      }
      return { changed: paused.length + reopened };
    });
  }

  /** Replaces: public.process_commission_deadline_reminders() - the daily job. */
  deadlineReminders(): Promise<{ notifications_created: number; processed_at: string }> {
    return this.db().asService((tx) => new CommissionRepository(tx).deadlineReminders());
  }

  /** Replaces: public.process_vendor_commission_hour_reminders(uuid) - checked when the vendor opens the app. */
  async hourReminders(me: Identity | null, vendorId: string): Promise<{ notifications_created: number }> {
    return this.run(me, async (tx) => {
      if (!(await this.ownerOrAdmin(tx, me, vendorId))) throw forbidden("not authorized");
      return new CommissionRepository(tx).hourReminder(vendorId);
    });
  }

  /** Replaces: public.process_listing_billing_reminders() - the daily job. */
  listingBillingReminders(): Promise<{ notifications_created: number; listings_paused: number; processed_at: string }> {
    return this.db().asService((tx) => new CommissionRepository(tx).listingBillingReminders());
  }

  /* -------------------------------------------------------------- monthly listings */

  /** Replaces: public.submit_monthly_listing_payment(text, uuid, text, text) - the vendor's transfer receipt for review. */
  async submitMonthlyPayment(me: Identity | null, kind: string, listingId: string, payerName: string | null, receiptPath: string | null): Promise<{ id: string }> {
    if (kind !== "product" && kind !== "package") throw badRequest("Invalid listing type.");
    if ([...sqlTrim(payerName ?? "")].length < 2) throw badRequest("Enter the name of the account that made the transfer.");
    if ([...sqlTrim(receiptPath ?? "")].length < 3) throw badRequest("Upload your payment receipt.");
    return this.run(me, async (tx) => {
      const listings = new MonthlyListingsRepository(tx);
      const shop = me ? await listings.shopOf(me.userId) : null;
      if (!shop) throw notFound("Your vendor profile is unavailable.");
      if (!(await listings.isMonthlyListing(kind, listingId, shop.id))) throw notFound("Monthly listing not found for this vendor.");
      if (!sqlTrim(receiptPath!).startsWith(`${me!.userId}/`)) throw badRequest("Invalid receipt upload path.");
      const id = await listings.submit(kind, listingId, shop.id, me!.userId, payerName!, receiptPath!);
      await listings.markPending(kind, listingId, shop.id);
      await listings.notifyAdminsOfSubmission(id, kind, listingId, shop, me!.userId);
      return { id };
    });
  }

  private reviewer<T>(me: Identity | null, work: (listings: MonthlyListingsRepository, adminId: string) => Promise<T>): Promise<T> {
    if (!me) return Promise.reject(badRequest("Admin access required."));
    return this.db().onBehalfOf(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me.userId))) throw badRequest("Admin access required.");
      return work(new MonthlyListingsRepository(tx), me.userId);
    });
  }

  /** Replaces: public.admin_approve_monthly_listing(uuid) - the listing is live for one month. */
  approveMonthly(me: Identity | null, submissionId: string): Promise<Record<string, unknown>> {
    return this.reviewer(me, async (listings, adminId) => {
      const s = await listings.lock(submissionId);
      if (!s) throw notFound("Monthly listing submission not found.");
      if (s.status !== "pending") throw badRequest("This submission has already been reviewed.");
      const name = await listings.listingName(s);
      if (name == null) throw notFound(s.kind === "product" ? "Product no longer exists." : "Package no longer exists.");
      const until = await listings.activate(s, adminId);
      const adminName = await listings.adminName(adminId);
      await listings.log(adminId, adminName, "Approved monthly listing payment", s.listing_id, name);
      await listings.notifyVendor({
        userId: await listings.shopOwner(s.vendor_id),
        type: "monthly_listing_approved",
        title: "Monthly listing activated",
        body: `Your ₦1,000 monthly payment for ${name} was approved. Your listing is active for one month.`,
        s,
        adminId,
        adminName,
        metadata: { submission_id: s.id, listing_id: s.listing_id, kind: s.kind, paid_until: until },
      });
      return { ok: true, listing_id: s.listing_id, kind: s.kind, paid_until: until };
    });
  }

  /** Replaces: public.admin_reject_monthly_listing(uuid, text) - the payment was not received: paused until paid. */
  rejectMonthly(me: Identity | null, submissionId: string, note: string | null): Promise<{ ok: true }> {
    return this.stopMonthly(me, submissionId, note, "rejected");
  }

  /** Replaces: public.admin_deactivate_monthly_listing(uuid, text) - an admin ends a monthly listing. */
  deactivateMonthly(me: Identity | null, submissionId: string, note: string | null): Promise<{ ok: true }> {
    return this.stopMonthly(me, submissionId, note, "deactivated");
  }

  private stopMonthly(me: Identity | null, submissionId: string, note: string | null, outcome: "rejected" | "deactivated"): Promise<{ ok: true }> {
    return this.reviewer(me, async (listings, adminId) => {
      const s = await listings.lock(submissionId);
      if (!s) throw notFound("Monthly listing submission not found.");
      if (outcome === "rejected" && s.status !== "pending") throw badRequest("This submission has already been reviewed.");
      const name = await listings.listingName(s);
      await listings.stop(s, outcome, adminId, note);
      const adminName = await listings.adminName(adminId);
      await listings.log(adminId, adminName, outcome === "rejected" ? "Rejected monthly listing payment" : "Deactivated monthly listing", s.listing_id, name);
      const extra = isSqlBlank(note) ? "" : ` Note: ${sqlTrim(note)}`;
      await listings.notifyVendor({
        userId: await listings.shopOwner(s.vendor_id),
        type: outcome === "rejected" ? "monthly_listing_rejected" : "monthly_listing_deactivated",
        title: outcome === "rejected" ? "Monthly listing payment rejected" : "Monthly listing deactivated",
        body:
          outcome === "rejected"
            ? `Your ₦1,000 monthly payment for ${name ?? "this listing"} was not approved.${extra}`
            : `Your monthly listing ${name ?? ""} was deactivated by an administrator.${extra}`,
        s,
        adminId,
        adminName,
        metadata: { submission_id: s.id, listing_id: s.listing_id, kind: s.kind },
      });
      return { ok: true as const };
    });
  }

  /** The shop's unpaid commission charges, earliest due first (the app's fallback when the summary function failed). */
  owedCharges(me: Identity, vendorId: string): Promise<{ amount: number; due_at: string | null }[]> {
    return this.db().asUser(me, (tx) => new CommissionRepository(tx).owedCharges(vendorId));
  }
}

export type { ListingKind };
