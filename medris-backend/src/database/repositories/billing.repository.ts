import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";
import { CommissionRepository } from "./commission.repository.js";
import { commissionCharges, commissionSettlements, listingPaymentIntents, products, vendorMonthlyCharges, vendorPackages } from "../schema/index.js";

export type ListingTable = "products" | "vendor_packages";

export interface ListingRow {
  id: string;
  vendor_id: string;
  name?: string;
  status?: string;
  billing_model?: string;
  billing_status?: string;
  billing_reference?: string | null;
  billing_paid_until?: string | null;
}

/** Commission settlements, monthly card billing and the ₦999 monthly listing activations. */
export class BillingRepository {
  constructor(private readonly db: Executor) {}

  /** compute_monthly_billing_amount() (CommissionRepository): the vendor's monthly charge and listing count. */
  async computeMonthlyBillingAmount(vendorId: string): Promise<{ listing_count?: number; amount?: number } | null> {
    const [row] = await new CommissionRepository(this.db).monthlyBillingAmount(vendorId);
    return row ?? null;
  }

  /** process_listing_billing_reminders() (CommissionRepository): the daily listing billing lifecycle (reminders, expiry). */
  processListingBillingReminders(): Promise<Record<string, unknown>> {
    return new CommissionRepository(this.db).listingBillingReminders();
  }

  /** process_commission_deadline_reminders() (CommissionRepository): commission heads-up 5/3/2/1 days before the deadline. */
  processCommissionDeadlineReminders(): Promise<unknown> {
    return new CommissionRepository(this.db).deadlineReminders();
  }

  async settlementByReference(reference: string): Promise<{ id: string; vendor_id: string; status: string } | null> {
    const [row] = await this.db
      .select({ id: commissionSettlements.id, vendor_id: commissionSettlements.vendorId, status: commissionSettlements.status })
      .from(commissionSettlements)
      .where(eq(commissionSettlements.providerReference, reference))
      .limit(1);
    return row ?? null;
  }

  async markSettlementPaid(id: string, vendorId: string, at: string): Promise<void> {
    await this.db.update(commissionSettlements).set({ status: "paid", paidAt: at }).where(eq(commissionSettlements.id, id));
    await this.db
      .update(commissionCharges)
      .set({ status: "paid", paidAt: at })
      .where(and(eq(commissionCharges.vendorId, vendorId), eq(commissionCharges.status, "owed")));
  }

  async monthlyChargeByReference(reference: string): Promise<{ id: string; vendor_id: string; status: string } | null> {
    const [row] = await this.db
      .select({ id: vendorMonthlyCharges.id, vendor_id: vendorMonthlyCharges.vendorId, status: vendorMonthlyCharges.status })
      .from(vendorMonthlyCharges)
      .where(eq(vendorMonthlyCharges.providerReference, reference))
      .limit(1);
    return row ?? null;
  }

  async markMonthlyChargePaid(id: string): Promise<void> {
    await this.db.update(vendorMonthlyCharges).set({ status: "paid" }).where(eq(vendorMonthlyCharges.id, id));
  }

  async insertMonthlyCharge(values: { vendorId: string; listingCount: number; amount: number; reference: string }): Promise<void> {
    await this.db.insert(vendorMonthlyCharges).values({
      vendorId: values.vendorId,
      listingCount: values.listingCount,
      amount: values.amount,
      status: "pending",
      providerReference: values.reference,
    });
  }

  /* ------------------------------------------------ monthly listings (₦999) */

  async listing(table: ListingTable, where: { id?: string; reference?: string; vendorId?: string }, withName = false): Promise<ListingRow | null> {
    const t = table === "products" ? sql`public.products` : sql`public.vendor_packages`;
    const conditions = [
      where.id ? sql`id = ${where.id}` : null,
      where.reference ? sql`billing_reference = ${where.reference}` : null,
      where.vendorId ? sql`vendor_id = ${where.vendorId}` : null,
    ].filter(Boolean);
    if (!conditions.length) return null;
    return jsonRow<ListingRow>(this.db, sql`
      select id, vendor_id, ${withName ? sql`name, ` : sql``}status, billing_model, billing_status, billing_reference, billing_paid_until
      from ${t} where ${sql.join(conditions as ReturnType<typeof sql>[], sql` and `)} limit 1`);
  }

  /** Updates one listing; `reference` makes the update conditional on the pending payment still being this one. */
  async updateListing(
    table: ListingTable,
    match: { id: string; vendorId: string; reference?: string },
    values: { status?: string; billingStatus?: string; billingPaidUntil?: string | null; billingReference?: string | null },
  ): Promise<number> {
    const target = table === "products" ? products : vendorPackages;
    const set: Record<string, unknown> = {};
    if (values.status !== undefined) set.status = values.status;
    if (values.billingStatus !== undefined) set.billingStatus = values.billingStatus;
    if (values.billingPaidUntil !== undefined) set.billingPaidUntil = values.billingPaidUntil;
    if (values.billingReference !== undefined) set.billingReference = values.billingReference;
    const conditions = [eq(target.id, match.id), eq(target.vendorId, match.vendorId)];
    if (match.reference !== undefined) conditions.push(eq(target.billingReference, match.reference));
    const rows = await this.db
      .update(target)
      .set(set as never)
      .where(and(...conditions))
      .returning({ id: target.id });
    return rows.length;
  }

  /** Reconciliation record for a listing payment (insert once per reference). */
  async insertListingIntent(values: { reference: string; userId: string; vendorId: string; listingId: string; kind: string; amountNaira: number }): Promise<void> {
    await this.db
      .insert(listingPaymentIntents)
      .values({ ...values, status: "pending" })
      .onConflictDoNothing();
  }

  async markListingIntentPaid(reference: string, at: string): Promise<void> {
    await this.db.update(listingPaymentIntents).set({ status: "paid", paidAt: at }).where(eq(listingPaymentIntents.reference, reference));
  }
}
