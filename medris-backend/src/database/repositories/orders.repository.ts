import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";
import { orders, payments } from "../schema/index.js";
import { isUuid } from "../../lib/format.js";

/** Orders and their payments, for the original order/payment endpoints (run as service_role after authorising in code). */
export class OrdersRepository {
  constructor(private readonly db: Executor) {}

  async parties(orderId: string): Promise<{ buyer_id: string; vendor_id: string; vendor_user_id: string | null } | null> {
    if (!isUuid(orderId)) return null;
    return jsonRow(this.db, sql`
      select o.buyer_id, o.vendor_id, v.user_id as vendor_user_id
      from public.orders o left join public.vendors v on v.id = o.vendor_id
      where o.id = ${orderId}`);
  }

  async basic(orderId: string): Promise<{ id: string; status: string; order_type: string; buyer_id: string } | null> {
    if (!isUuid(orderId)) return null;
    const [row] = await this.db
      .select({ id: orders.id, status: orders.status, order_type: orders.orderType, buyer_id: orders.buyerId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    return row ?? null;
  }

  async payoutStatus(orderId: string): Promise<{ id: string; payout_status: string } | null> {
    if (!isUuid(orderId)) return null;
    const [row] = await this.db.select({ id: orders.id, payout_status: orders.payoutStatus }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return row ?? null;
  }

  /** id, status and the owning vendor's user id (`vendor:vendors(user_id)`). */
  async withVendorOwner(orderId: string): Promise<{ id: string; status: string; vendor: { user_id: string } | null } | null> {
    if (!isUuid(orderId)) return null;
    return jsonRow(this.db, sql`
      select o.id, o.status,
        (select json_build_object('user_id', v.user_id) from public.vendors v where v.id = o.vendor_id) as vendor
      from public.orders o where o.id = ${orderId}`);
  }

  /** Order with the vendor's payout details (legacy card payouts). */
  async withPayoutVendor(orderId: string): Promise<{
    id: string;
    payout_status: string;
    vendor: { id: string; commission_pct: number | null; bank_code: string | null; account_number: string | null; account_name: string | null; transfer_recipient_code: string | null } | null;
  } | null> {
    if (!isUuid(orderId)) return null;
    return jsonRow(this.db, sql`
      select o.id, o.payout_status,
        (select json_build_object('id', v.id, 'commission_pct', v.commission_pct, 'bank_code', v.bank_code, 'account_number', v.account_number,
                                  'account_name', v.account_name, 'transfer_recipient_code', v.transfer_recipient_code)
         from public.vendors v where v.id = o.vendor_id) as vendor
      from public.orders o where o.id = ${orderId}`);
  }

  /** `buyer:users(email), vendor:vendors(paystack_subaccount_code)` for starting a card payment. */
  async checkoutContacts(orderId: string): Promise<{ buyer: { email: string | null } | null; vendor: { paystack_subaccount_code: string | null } | null } | null> {
    if (!isUuid(orderId)) return null;
    return jsonRow(this.db, sql`
      select
        (select json_build_object('email', u.email) from public.users u where u.id = o.buyer_id) as buyer,
        (select json_build_object('paystack_subaccount_code', v.paystack_subaccount_code) from public.vendors v where v.id = o.vendor_id) as vendor
      from public.orders o where o.id = ${orderId}`);
  }

  async update(orderId: string, values: Partial<typeof orders.$inferInsert>): Promise<void> {
    await this.db.update(orders).set(values).where(eq(orders.id, orderId));
  }

  /** Orders the 30-minute reminder sweep should look at, with vendor and payments (as the original embedded select). */
  async dueForReminders(graceCutoff: string, repeatCutoff: string): Promise<Record<string, unknown>[]> {
    return jsonRows(this.db, sql`
      select o.id, o.order_type, o.status, o.delivery_method, o.buyer_id,
        (select json_build_object('id', v.id, 'business_name', v.business_name, 'user_id', v.user_id) from public.vendors v where v.id = o.vendor_id) as vendor,
        (select coalesce(json_agg(json_build_object('payment_type', p.payment_type, 'status', p.status)), '[]'::json) from public.payments p where p.order_id = o.id) as payments
      from public.orders o
      where o.status in ('confirmed', 'handed_over', 'returned')
        and o.created_at <= ${graceCutoff}::timestamptz
        and (o.last_reminder_sent_at is null or o.last_reminder_sent_at <= ${repeatCutoff}::timestamptz)`);
  }

  /** Orders of these vendors that are not completed or cancelled. */
  async activeForVendors(vendorIds: string[]): Promise<{ id: string; status: string }[]> {
    if (!vendorIds.length) return [];
    return this.db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(inArray(orders.vendorId, vendorIds), notInArray(orders.status, ["completed", "cancelled"])));
  }
}

export class PaymentsRepository {
  constructor(private readonly db: Executor) {}

  /** First paid payment of the given types (all columns, as `select=*`). */
  async firstPaid(orderId: string, types: string[]): Promise<Record<string, unknown> | null> {
    return jsonRow(this.db, sql`
      select * from public.payments
      where order_id = ${orderId} and status = 'paid' and payment_type::text in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
      limit 1`);
  }

  async paidAmounts(orderId: string): Promise<{ payment_type: string; amount: number }[]> {
    return this.db
      .select({ payment_type: payments.paymentType, amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));
  }

  /** The first paid payment's provider reference (`select=provider_reference&limit=1`). */
  async firstPaidReference(orderId: string): Promise<{ provider_reference: string | null } | null> {
    const [row] = await this.db
      .select({ provider_reference: payments.providerReference })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .limit(1);
    return row ?? null;
  }

  async markPaidByReference(reference: string, at: string): Promise<number> {
    const rows = await this.db.update(payments).set({ status: "paid", paidAt: at }).where(eq(payments.providerReference, reference)).returning({ id: payments.id });
    return rows.length;
  }

  async exists(orderId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)).limit(1);
    return Boolean(row);
  }
}
