import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow } from "../json.js";

/** Amounts travel as PostgreSQL numeric text, so comparisons and sums are exact. */
type Numeric = string;

export interface ClaimOrder {
  id: string;
  buyer_id: string;
  vendor_id: string;
  status: string;
  order_type: string;
  delivery_method: string | null;
  payment_timing: string | null;
  payout_status: string | null;
  service_offer_id: string | null;
  payment_escalated_at: string | null;
  /** coalesce(status_changed_at, created_at) is more than 24 hours ago. */
  confirmed_a_day_ago: boolean;
  total_amount: Numeric | null;
  delivery_fee: Numeric | null;
  deposit_amount: Numeric | null;
  payment_deposit_percent: Numeric | null;
  vendor_user_id: string | null;
  vendor_name: string | null;
}

export interface PendingClaim {
  id: string;
  payment_type: string;
  amount: Numeric;
  provider_reference: string | null;
}

/**
 * Direct (bank transfer) payments between buyer and vendor: the buyer reports paying, the vendor or an
 * admin confirms or disputes it, and disputes about orders.
 */
export class PaymentClaimsRepository {
  constructor(private readonly db: Executor) {}

  /** The order (locked unless `lock` is false), with the amounts as numeric text and the shop's owner and name. */
  async order(orderId: string, lock = true): Promise<ClaimOrder | null> {
    const [row] = rowsOf<{ row: ClaimOrder }>(
      await this.db.execute(sql`
        select json_build_object(
          'id', o.id, 'buyer_id', o.buyer_id, 'vendor_id', o.vendor_id, 'status', o.status::text, 'order_type', o.order_type::text,
          'delivery_method', o.delivery_method::text, 'payment_timing', o.payment_timing::text, 'payout_status', o.payout_status,
          'service_offer_id', o.service_offer_id, 'payment_escalated_at', o.payment_escalated_at,
          'confirmed_a_day_ago', coalesce(o.status_changed_at, o.created_at) <= now() - interval '24 hours',
          'total_amount', o.total_amount::text, 'delivery_fee', o.delivery_fee::text, 'deposit_amount', o.deposit_amount::text,
          'payment_deposit_percent', o.payment_deposit_percent::text,
          'vendor_user_id', (select v.user_id from public.vendors v where v.id = o.vendor_id),
          'vendor_name', (select v.business_name from public.vendors v where v.id = o.vendor_id)) as row
        from public.orders o where o.id = ${orderId} ${lock ? sql`for update of o` : sql``}`),
    );
    return row?.row ?? null;
  }

  /** The user's own live shop is this one. */
  async ownsLiveShop(vendorId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.vendors where id = ${vendorId} and user_id = ${userId} and deleted_at is null`)) !== null;
  }

  async paid(orderId: string, types: string[]): Promise<boolean> {
    return (
      (await jsonRow(this.db, sql`select 1 as x from public.payments where order_id = ${orderId} and payment_type::text = any(${`{${types.join(",")}}`}::text[]) and status = 'paid' limit 1`)) !==
      null
    );
  }

  /** A numeric expression evaluated by PostgreSQL. */
  async calc(expression: SQL): Promise<Numeric> {
    return (await jsonRow<{ v: Numeric }>(this.db, sql`select (${expression})::text as v`))!.v;
  }

  async test(condition: SQL): Promise<boolean> {
    return (await jsonRow<{ v: boolean }>(this.db, sql`select coalesce((${condition}), false) as v`))!.v;
  }

  /** Σ paid amounts of a type. */
  sumPaid(orderId: string, type: string): Promise<Numeric> {
    return this.calc(sql`select coalesce(sum(amount),0) from public.payments where order_id = ${orderId} and payment_type = ${type}::public.payment_type and status = 'paid'`);
  }

  /** The latest pending (else paid) amount recorded for a type, if any. */
  async latestAmount(orderId: string, type: string): Promise<Numeric | null> {
    const row = await jsonRow<{ v: Numeric }>(
      this.db,
      sql`select amount::text as v from public.payments where order_id = ${orderId} and payment_type = ${type}::public.payment_type and status in ('pending','paid')
          order by (status = 'pending') desc, created_at desc limit 1`,
    );
    return row?.v ?? null;
  }

  /** The pending report of one payment type by the buyer (locked). */
  async buyerReport(orderId: string, type: string): Promise<string | null> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        select id from public.payments where order_id = ${orderId} and payment_type = ${type}::public.payment_type and status = 'pending' and provider_reference = 'buyer_report'
        order by created_at desc limit 1 for update`),
    );
    return row?.id ?? null;
  }

  async recordBuyerReport(orderId: string, type: string, amount: number, existing: string | null): Promise<string> {
    if (existing) {
      await this.db.execute(sql`update public.payments set amount = ${String(amount)}::numeric, method = 'transfer'::public.payment_method, provider_reference = 'buyer_report' where id = ${existing}`);
      return existing;
    }
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.payments (order_id, payment_type, amount, method, status, provider_reference)
        values (${orderId}, ${type}::public.payment_type, ${String(amount)}::numeric, 'transfer'::public.payment_method, 'pending'::public.payment_status, 'buyer_report')
        returning id`),
    );
    return row!.id;
  }

  /** The newest pending payment the buyer reported (a product order or a service booking), locked. */
  async latestClaim(orderId: string): Promise<PendingClaim | null> {
    const [row] = rowsOf<{ row: PendingClaim }>(
      await this.db.execute(sql`
        select json_build_object('id', id, 'payment_type', payment_type::text, 'amount', amount::text, 'provider_reference', provider_reference) as row
        from public.payments where order_id = ${orderId} and status = 'pending' and provider_reference in ('buyer_report','service_offer_report')
        order by created_at desc limit 1 for update`),
    );
    return row?.row ?? null;
  }

  async markClaimPaid(paymentId: string, reference: SQL, method?: string): Promise<void> {
    await this.db.execute(sql`
      update public.payments set status = 'paid'::public.payment_status, paid_at = coalesce(paid_at, now()),
        ${method ? sql`method = ${method}::public.payment_method,` : sql``} provider_reference = ${reference}
      where id = ${paymentId}`);
  }

  async rejectClaim(paymentId: string): Promise<void> {
    await this.db.execute(sql`update public.payments set provider_reference = 'reported_payment_rejected' where id = ${paymentId}`);
  }

  async insertDirectPayment(orderId: string, type: string, amount: Numeric): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.payments (order_id, payment_type, amount, method, status, provider_reference, paid_at)
        values (${orderId}, ${type}::public.payment_type, ${amount}::numeric, 'transfer'::public.payment_method, 'paid'::public.payment_status, 'vendor_confirmed_direct', now())
        returning id`),
    );
    return row!.id;
  }

  /** An order update; `fields` is the SET list. */
  async updateOrder(orderId: string, fields: SQL, where: SQL = sql``): Promise<void> {
    await this.db.execute(sql`update public.orders set ${fields} where id = ${orderId} ${where}`);
  }

  async openDispute(orderId: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.disputes where order_id = ${orderId} and status = 'open' order by created_at desc limit 1`))?.id ?? null;
  }

  async updateDispute(disputeId: string, fields: SQL): Promise<void> {
    await this.db.execute(sql`update public.disputes set ${fields} where id = ${disputeId}`);
  }

  async newDispute(orderId: string, raisedBy: "buyer" | "vendor", reason: string, attachments?: unknown[]): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.disputes (order_id, raised_by, reason ${attachments ? sql`, attachments` : sql``})
        values (${orderId}, ${raisedBy}::public.dispute_raised_by, ${reason} ${attachments ? sql`, ${JSON.stringify(attachments)}::jsonb` : sql``})
        returning id`),
    );
    return row!.id;
  }

  async completeServiceOffer(offerId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'completed', completed_at = now(), updated_at = now() where id = ${offerId}`);
  }

  async expireServiceOffer(offerId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'expired', updated_at = now() where id = ${offerId}`);
  }

  async userName(userId: string): Promise<string | null> {
    return (await jsonRow<{ name: string | null }>(this.db, sql`select name from public.users where id = ${userId}`))?.name ?? null;
  }

  /** The dispute's order and shop. */
  disputeOrder(disputeId: string): Promise<{ order_id: string; vendor_id: string } | null> {
    return jsonRow(this.db, sql`select d.order_id, o.vendor_id from public.disputes d join public.orders o on o.id = d.order_id where d.id = ${disputeId}`);
  }

  async disputeOrderId(disputeId: string): Promise<string | null> {
    return (await jsonRow<{ order_id: string }>(this.db, sql`select order_id from public.disputes where id = ${disputeId}`))?.order_id ?? null;
  }

  /** Fails like PostgreSQL does for a value that is not of this enum type. */
  async castEnum(value: string, type: "order_status" | "payment_type" | "payment_method"): Promise<void> {
    await this.db.execute(sql`select ${value}::${sql.raw(`public.${type}`)}`);
  }

  /* ---------------------------------------------------------- card payment intent */

  async deletePending(orderId: string): Promise<void> {
    await this.db.execute(sql`delete from public.payments where order_id = ${orderId} and status = 'pending'`);
  }

  async insertCardPayment(orderId: string, type: string, amount: Numeric, reference: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.payments (order_id, payment_type, amount, method, status, provider_reference)
      values (${orderId}, ${type}::public.payment_type, ${amount}::numeric, 'card', 'pending', ${reference})`);
  }

  /* ------------------------------------------------- named changes (the services call these) */

  /** abs(amount - expected) > 0.01; a missing expectation never differs. */
  amountDiffers(amount: number, expected: Numeric | null): Promise<boolean> {
    return this.test(sql`abs(${String(amount)}::numeric - coalesce(${expected}::numeric, ${String(amount)}::numeric)) > 0.01`);
  }

  /** abs(amount - the payment's amount) > 0.01 */
  differsFromPayment(amount: number, paymentId: string): Promise<boolean> {
    return this.test(sql`abs(${String(amount)}::numeric - (select amount from public.payments where id = ${paymentId})) > 0.01`);
  }

  /**
   * What the buyer owes next, as buyer_report_manual_payment() worked it out: for pay-after-delivery
   * orders the delivery deposit (a percentage of the items) and then the rest; otherwise the sale or
   * rental fee and then any refundable deposit. "none" when nothing is outstanding.
   */
  async outstanding(o: ClaimOrder): Promise<{ type: string; expected: Numeric | null } | "none"> {
    const timing = o.payment_timing === "pay_before" || o.payment_timing === "pay_after" ? o.payment_timing : o.delivery_method === "delivery" ? "pay_after" : "pay_before";
    const feeType = o.order_type === "sale" ? "sale_price" : "rental_fee";
    const total = sql`coalesce(${o.total_amount}::numeric, 0)`;
    if (o.delivery_method === "delivery" && timing === "pay_after") {
      if (!(await this.paid(o.id, ["delivery_deposit_20"]))) {
        const pct = sql`greatest(0.01, least(99.99, coalesce(${o.payment_deposit_percent}::numeric, 20)))::numeric(5,2)`;
        return { type: "delivery_deposit_20", expected: await this.calc(sql`round(greatest(0, ${total} - coalesce(${o.delivery_fee}::numeric, 0)) * ${pct} / 100, 2)`) };
      }
      const deposit = await this.sumPaid(o.id, "delivery_deposit_20");
      return { type: feeType, expected: await this.calc(sql`greatest(0, ${total} - ${deposit}::numeric)`) };
    }
    const depositDue = async () =>
      (await this.test(sql`coalesce(${o.deposit_amount}::numeric, 0) > 0`)) && !(await this.paid(o.id, ["deposit"]))
        ? { type: "deposit", expected: (await this.latestAmount(o.id, "deposit")) ?? (await this.calc(sql`coalesce(${o.deposit_amount}::numeric, 0)`)) }
        : null;
    if (o.delivery_method === "pickup") {
      if (!(await this.paid(o.id, [feeType]))) return { type: feeType, expected: await this.calc(sql`greatest(0, ${total})`) };
      return (await depositDue()) ?? "none";
    }
    if (!(await this.paid(o.id, [feeType]))) {
      return { type: feeType, expected: (await this.latestAmount(o.id, feeType)) ?? (await this.calc(sql`coalesce(${o.total_amount}::numeric, 0)`)) };
    }
    return (await depositDue()) ?? "none";
  }

  /** vendor_confirm_unreported_payment(): the delivery deposit when one is due (percentage clamped 1-99), else the whole total. */
  async unreportedDue(o: ClaimOrder, depositDue: boolean): Promise<{ type: string; expected: Numeric }> {
    if (depositDue) {
      const pct = sql`greatest(1, least(99, coalesce(${o.payment_deposit_percent}::numeric, 20)))`;
      return {
        type: "delivery_deposit_20",
        expected: await this.calc(sql`round(greatest(0, coalesce(${o.total_amount}::numeric, 0) - coalesce(${o.delivery_fee}::numeric, 0)) * ${pct} / 100, 2)`),
      };
    }
    return { type: o.order_type === "rental" ? "rental_fee" : "sale_price", expected: await this.calc(sql`greatest(0, coalesce(${o.total_amount}::numeric, 0))`) };
  }

  /** The order moves on after a payment change. */
  async setOrderState(
    orderId: string,
    state:
      | "reported"
      | "deposit_confirmed"
      | "await_buyer"
      | "completed"
      | "confirmed"
      | "vendor_disputed"
      | "follow_up_disputed"
      | "follow_up_cleared"
      | "claim_rejected"
      | "disputed"
      | "overdue_cancelled"
      | "escalation_cleared",
  ): Promise<void> {
    const clear = sql`payment_unresolved_at = null, payment_escalated_at = null`;
    const changes: Record<typeof state, [SQL, SQL?]> = {
      reported: [sql`status = 'payment_unresolved'::public.order_status, payment_unresolved_at = coalesce(payment_unresolved_at, now()), payment_escalated_at = null, awaiting_confirmation_since = null`],
      deposit_confirmed: [sql`status = 'confirmed'::public.order_status, ${clear}`],
      await_buyer: [sql`status = case when status = 'payment_unresolved' then 'confirmed'::public.order_status else status end, ${clear}, awaiting_confirmation_since = now()`],
      completed: [sql`status = 'completed'::public.order_status, completed_at = coalesce(completed_at, now()), ${clear}, awaiting_confirmation_since = null`, sql`and status <> 'cancelled'`],
      confirmed: [sql`status = 'confirmed'::public.order_status, ${clear}`],
      vendor_disputed: [sql`status = 'payment_unresolved'::public.order_status, payment_unresolved_at = coalesce(payment_unresolved_at, now())`, sql`and status <> 'completed'`],
      follow_up_disputed: [sql`status = 'payment_unresolved'::public.order_status, payment_unresolved_at = coalesce(payment_unresolved_at, now()), payment_escalated_at = null`],
      follow_up_cleared: [clear],
      claim_rejected: [sql`status = 'cancelled'::public.order_status, cancelled_at = coalesce(cancelled_at, now()), payment_unresolved_at = null`, sql`and status <> 'completed'`],
      disputed: [sql`status = 'disputed'`],
      overdue_cancelled: [sql`status = 'cancelled'::public.order_status, cancelled_at = coalesce(cancelled_at, now()), payment_escalated_at = null`],
      escalation_cleared: [sql`payment_escalated_at = null`],
    };
    const [fields, where] = changes[state];
    await this.updateOrder(orderId, fields, where);
  }

  /** The vendor confirmed unreported money: complete without the buyer's confirmation clock. */
  async completeDirect(orderId: string): Promise<void> {
    await this.updateOrder(orderId, sql`status = 'completed'::public.order_status, completed_at = coalesce(completed_at, now()), payment_escalated_at = null, payment_unresolved_at = null, awaiting_confirmation_since = null`);
  }

  async setOrderStatus(orderId: string, status: string): Promise<void> {
    await this.updateOrder(orderId, sql`status = ${status}::public.order_status`);
  }

  /** The reported payment confirmed by the vendor ('vendor_confirmed', or 'service_offer_confirmed' for a booking). */
  confirmClaimByVendor(paymentId: string, method?: string): Promise<void> {
    return this.markClaimPaid(paymentId, sql`case when provider_reference = 'service_offer_report' then 'service_offer_confirmed' else 'vendor_confirmed' end`, method);
  }

  confirmClaimByAdmin(paymentId: string): Promise<void> {
    return this.markClaimPaid(paymentId, sql`'admin_confirmed'`);
  }

  /** Resolves a dispute with notes (`append` adds a line to existing notes). */
  async resolveDispute(disputeId: string, notes: string | null, mode: "replace" | "append" | "default_verified" = "replace"): Promise<void> {
    const value =
      mode === "append"
        ? sql`coalesce(admin_notes, '') || case when coalesce(admin_notes, '') = '' then '' else E'\n' end || ${notes}::text`
        : mode === "default_verified"
          ? sql`coalesce(${notes}::text, 'Payment claim verified by admin.')`
          : sql`${notes}::text`;
    await this.updateDispute(disputeId, sql`status = 'resolved', admin_notes = ${value}`);
  }

  async raiseByVendor(disputeId: string, reason: string): Promise<void> {
    await this.updateDispute(disputeId, sql`reason = ${reason}, raised_by = 'vendor'::public.dispute_raised_by`);
  }

  async setVendorResponse(disputeId: string, response: string | null): Promise<void> {
    await this.updateDispute(disputeId, sql`vendor_response = ${response}`);
  }

  sum(a: Numeric | null, b: Numeric | null): Promise<Numeric> {
    return this.calc(sql`${a}::numeric + ${b}::numeric`);
  }

  isPositive(value: Numeric | null): Promise<boolean> {
    return this.test(sql`${value}::numeric > 0`);
  }
}
