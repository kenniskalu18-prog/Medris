import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow } from "../json.js";

export type ListingKind = "product" | "package";

export interface Submission {
  id: string;
  kind: ListingKind;
  listing_id: string;
  vendor_id: string;
  status: string;
}

const table = (kind: ListingKind) => (kind === "product" ? sql`public.products` : sql`public.vendor_packages`);

/**
 * ₦1,000-a-month listings paid by bank transfer: the vendor submits the transfer receipt, an admin
 * approves (the listing is live for a month), rejects or deactivates it.
 */
export class MonthlyListingsRepository {
  constructor(private readonly db: Executor) {}

  shopOf(userId: string): Promise<{ id: string; business_name: string | null } | null> {
    return jsonRow(this.db, sql`select id, business_name from public.vendors where user_id = ${userId} and deleted_at is null limit 1`);
  }

  async isMonthlyListing(kind: ListingKind, listingId: string, vendorId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from ${table(kind)} where id = ${listingId} and vendor_id = ${vendorId} and billing_model = 'monthly'`)) !== null;
  }

  async submit(kind: ListingKind, listingId: string, vendorId: string, userId: string, payerName: string, receiptPath: string): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.monthly_listing_submissions (kind, listing_id, vendor_id, user_id, payer_name, receipt_path, status)
        values (${kind}, ${listingId}, ${vendorId}, ${userId}, trim(${payerName}::text), trim(${receiptPath}::text), 'pending') returning id`),
    );
    return row!.id;
  }

  /** Waiting for review: paused unless a paid month is still running. */
  async markPending(kind: ListingKind, listingId: string, vendorId: string): Promise<void> {
    await this.db.execute(sql`
      update ${table(kind)} set billing_status = 'pending_payment',
        status = case when billing_paid_until is null or billing_paid_until <= now() then 'paused' else status end, billing_reference = null
      where id = ${listingId} and vendor_id = ${vendorId}`);
  }

  /** One "new monthly listing payment" notification per admin. */
  async notifyAdminsOfSubmission(submissionId: string, kind: ListingKind, listingId: string, shop: { id: string; business_name: string | null }, userId: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, vendor_id, notification_category, metadata)
      select u.id, 'monthly_listing_submitted', 'New monthly listing payment', ${shop.business_name}::text || ' submitted a ₦1,000 monthly listing payment for review.',
             'adminMonthlyListings', jsonb_build_object('submissionId', ${submissionId}::uuid), ${userId}::uuid, ${shop.business_name}::text, ${shop.id}::uuid, 'system',
             jsonb_build_object('submission_id', ${submissionId}::uuid, 'kind', ${kind}::text, 'listing_id', ${listingId}::uuid)
      from public.users u where u.role = 'admin'`);
  }

  /** A submission, locked. */
  async lock(submissionId: string): Promise<Submission | null> {
    const [row] = rowsOf<Submission>(
      await this.db.execute(sql`select id, kind, listing_id, vendor_id, status from public.monthly_listing_submissions where id = ${submissionId} for update`),
    );
    return row ?? null;
  }

  async listingName(s: Submission): Promise<string | null> {
    return (await jsonRow<{ name: string }>(this.db, sql`select name from ${table(s.kind)} where id = ${s.listing_id} and vendor_id = ${s.vendor_id}`))?.name ?? null;
  }

  /** Approved: live for one month from now. Returns the paid-until time. */
  async activate(s: Submission, adminId: string): Promise<string> {
    const until = (await jsonRow<{ t: string }>(this.db, sql`select now() + interval '1 month' as t`))!.t;
    await this.db.execute(sql`
      update ${table(s.kind)} set status = 'active', billing_status = 'active', billing_paid_until = ${until}::timestamptz, billing_reference = null
      where id = ${s.listing_id} and vendor_id = ${s.vendor_id}`);
    await this.review(s.id, "approved", adminId, undefined);
    return until;
  }

  /** Rejected (waiting for a new payment) or deactivated (cancelled): the listing is paused. */
  async stop(s: Submission, outcome: "rejected" | "deactivated", adminId: string, note: string | null): Promise<void> {
    await this.db.execute(sql`
      update ${table(s.kind)} set status = 'paused', billing_status = ${outcome === "rejected" ? "pending_payment" : "cancelled"}, billing_paid_until = null, billing_reference = null
      where id = ${s.listing_id} and vendor_id = ${s.vendor_id}`);
    await this.review(s.id, outcome, adminId, note);
  }

  private async review(id: string, status: string, adminId: string, note: string | null | undefined): Promise<void> {
    await this.db.execute(sql`
      update public.monthly_listing_submissions
      set status = ${status}, reviewed_at = now(), reviewed_by = ${adminId} ${note !== undefined ? sql`, review_note = nullif(trim(coalesce(${note}::text, '')), '')` : sql``}, updated_at = now()
      where id = ${id}`);
  }

  async adminName(adminId: string): Promise<string | null> {
    return (await jsonRow<{ name: string | null }>(this.db, sql`select name from public.users where id = ${adminId}`))?.name ?? null;
  }

  async shopOwner(vendorId: string): Promise<string | null> {
    return (await jsonRow<{ user_id: string }>(this.db, sql`select user_id from public.vendors where id = ${vendorId}`))?.user_id ?? null;
  }

  /** The admin log row these functions wrote (the admin's name only). */
  async log(adminId: string, adminName: string | null, action: string, listingId: string, label: string | null): Promise<void> {
    await this.db.execute(sql`
      insert into public.admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
      values (${adminId}, ${adminName}, ${action}, 'monthly_listing', ${listingId}, ${label})`);
  }

  async notifyVendor(n: { userId: string | null; type: string; title: string; body: string; s: Submission; adminId: string; adminName: string | null; metadata: Record<string, unknown> }): Promise<void> {
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, vendor_id, notification_category, metadata)
      values (${n.userId}::uuid, ${n.type}, ${n.title}, ${n.body}, 'vendorProducts', jsonb_build_object('listingId', ${n.s.listing_id}::uuid, 'kind', ${n.s.kind}::text),
              ${n.adminId}, ${n.adminName}, ${n.s.vendor_id}, 'system', ${JSON.stringify(n.metadata)}::jsonb)`);
  }
}
