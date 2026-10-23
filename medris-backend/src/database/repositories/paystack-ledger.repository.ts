import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

export interface LedgerTransaction {
  id: string;
  reference: string;
  purpose: "order_payment" | "order_balance" | "listing_fee" | "commission";
  order_id: string | null;
  vendor_id: string | null;
  amount_kobo: string; // bigint comes back as text
  currency: string;
  status: string;
}
export interface OpenAttempt extends LedgerTransaction {
  created_at: string;
  age_seconds: number;
  authorization: { authorization_url?: string; access_code?: string } | null;
}
export interface LedgerPayout {
  id: string;
  order_id: string;
  vendor_id: string;
  transfer_reference: string;
  status: string;
}
export interface LedgerRefund {
  id: string;
  order_id: string;
  transaction_reference: string;
  status: string;
}
export interface LedgerEvent {
  id: string;
  processed_at: string | null;
}

/** The Paystack ledger tables of migration 0005 (service role only). */
export class PaystackLedgerRepository {
  constructor(private readonly db: Executor) {}

  /** Held until the surrounding transaction ends, so two deliveries of one event are handled one after the other. */
  async lockEvent(eventKey: string): Promise<void> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paystack_event:" + eventKey}, 0))`);
  }

  async recordEvent(eventKey: string, event: string, reference: string | null): Promise<LedgerEvent> {
    await this.db.execute(sql`
      insert into public.paystack_events (event_key, event, reference) values (${eventKey}, ${event}, ${reference})
      on conflict (event_key) do nothing`);
    const row = await jsonRow<LedgerEvent>(this.db, sql`select id, processed_at from public.paystack_events where event_key = ${eventKey}`);
    return row as LedgerEvent;
  }

  async finishEvent(id: string, result: string, error: string | null = null): Promise<void> {
    await this.db.execute(sql`
      update public.paystack_events
      set result = ${result}, error = ${error}, processed_at = case when ${error}::text is null then now() else null end
      where id = ${id}`);
  }

  transactionByReference(reference: string): Promise<LedgerTransaction | null> {
    return jsonRow<LedgerTransaction>(
      this.db,
      sql`select id, reference, purpose, order_id, vendor_id, amount_kobo::text as amount_kobo, currency, status
          from public.paystack_transactions where reference = ${reference}`,
    );
  }

  /** initialized/failed/abandoned -> success, once. Returns false when it was already success (or refunded). */
  async markTransactionSuccess(reference: string, fields: { paystackId?: number | null; channel?: string | null; paidAt?: string | null }): Promise<boolean> {
    const rows = await jsonReturning(
      this.db,
      sql`update public.paystack_transactions
          set status = 'success', paid_at = coalesce(paid_at, ${fields.paidAt ?? null}::timestamptz, now()),
              channel = coalesce(${fields.channel ?? null}, channel), paystack_transaction_id = coalesce(${fields.paystackId ?? null}, paystack_transaction_id)
          where reference = ${reference} and status in ('initialized', 'failed', 'abandoned')
          returning id`,
    );
    return rows.length > 0;
  }

  async setTransactionStatus(reference: string, to: string, from: readonly string[]): Promise<boolean> {
    const rows = await jsonReturning(
      this.db,
      sql`update public.paystack_transactions set status = ${to}
          where reference = ${reference} and status in (${sql.join(from.map((x) => sql`${x}`), sql`, `)}) returning id`,
    );
    return rows.length > 0;
  }

  payoutByReference(reference: string): Promise<LedgerPayout | null> {
    return jsonRow<LedgerPayout>(this.db, sql`select id, order_id, vendor_id, transfer_reference, status from public.vendor_payouts where transfer_reference = ${reference} for update`);
  }

  async setPayout(id: string, status: string, error: string | null): Promise<void> {
    await this.db.execute(sql`update public.vendor_payouts set status = ${status}, last_error = coalesce(${error}, last_error) where id = ${id}`);
  }

  /** Pending payouts of an order wait for an admin (a dispute or chargeback is open). */
  async holdPendingPayouts(orderId: string, reason: string): Promise<number> {
    const rows = await jsonReturning(
      this.db,
      sql`update public.vendor_payouts set status = 'on_hold', hold_reason = ${reason} where order_id = ${orderId} and status = 'pending' returning id`,
    );
    return rows.length;
  }

  /** The newest refund attempt on a payment that is still open (or the last failed one). */
  refundForTransaction(reference: string): Promise<LedgerRefund | null> {
    return jsonRow<LedgerRefund>(
      this.db,
      sql`select id, order_id, transaction_reference, status from public.paystack_refunds
          where transaction_reference = ${reference} order by attempt desc limit 1 for update`,
    );
  }

  async setRefund(id: string, status: string, paystackRefundId: string | null): Promise<void> {
    await this.db.execute(sql`update public.paystack_refunds set status = ${status}, paystack_refund_id = coalesce(${paystackRefundId}, paystack_refund_id) where id = ${id}`);
  }

  /** What the reconciliation job looks at. */
  staleInitializedTransactions(olderThanMinutes: number, limit: number): Promise<{ reference: string }[]> {
    return jsonRows<{ reference: string }>(
      this.db,
      sql`select reference from public.paystack_transactions
          where status = 'initialized' and created_at < now() - make_interval(mins => ${olderThanMinutes})
          order by created_at limit ${limit}`,
    );
  }
  staleProcessingPayouts(olderThanMinutes: number, limit: number): Promise<{ transfer_reference: string }[]> {
    return jsonRows<{ transfer_reference: string }>(
      this.db,
      sql`select transfer_reference from public.vendor_payouts
          where status = 'processing' and updated_at < now() - make_interval(mins => ${olderThanMinutes})
          order by updated_at limit ${limit}`,
    );
  }

  /* ------------------------------------------------------------ order checkout (issue #95) */

  /** The open attempts of an order (the partial unique index allows at most one per purpose). */
  openAttempts(orderId: string): Promise<OpenAttempt[]> {
    return jsonRows<OpenAttempt>(
      this.db,
      sql`select id, reference, purpose, order_id, vendor_id, amount_kobo::text as amount_kobo, currency, status, created_at,
                 extract(epoch from (now() - created_at))::int as age_seconds, raw_last_event -> 'initialize' as authorization
          from public.paystack_transactions where order_id = ${orderId} and status = 'initialized' for update`,
    );
  }

  async insertAttempt(a: { reference: string; purpose: string; orderId: string; vendorId: string; payerUserId: string; amountKobo: number }): Promise<void> {
    await this.db.execute(sql`
      insert into public.paystack_transactions (reference, purpose, order_id, vendor_id, payer_user_id, amount_kobo)
      values (${a.reference}, ${a.purpose}, ${a.orderId}, ${a.vendorId}, ${a.payerUserId}, ${a.amountKobo})`);
  }

  async storeAuthorization(reference: string, authorization: { authorization_url: string; access_code: string }): Promise<void> {
    await this.db.execute(sql`
      update public.paystack_transactions set raw_last_event = jsonb_build_object('initialize', ${JSON.stringify(authorization)}::jsonb)
      where reference = ${reference}`);
  }

  /** A Paystack payment is open (started in the last hour) or done: a bank-transfer report must not be added on top. */
  async hasActiveAttempt(orderId: string): Promise<boolean> {
    const row = await jsonRow<{ n: number }>(
      this.db,
      sql`select count(*)::int as n from public.paystack_transactions
          where order_id = ${orderId} and (status = 'success' or (status = 'initialized' and created_at > now() - interval '1 hour'))`,
    );
    return (row?.n ?? 0) > 0;
  }

  async payerOf(reference: string): Promise<string | null> {
    const row = await jsonRow<{ payer_user_id: string | null }>(this.db, sql`select payer_user_id from public.paystack_transactions where reference = ${reference}`);
    return row?.payer_user_id ?? null;
  }

  async orderStatus(orderId: string): Promise<string | null> {
    const row = await jsonRow<{ status: string }>(this.db, sql`select status::text as status from public.orders where id = ${orderId}`);
    return row?.status ?? null;
  }
}
