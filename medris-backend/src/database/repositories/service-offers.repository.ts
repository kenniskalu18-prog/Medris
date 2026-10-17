import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

export interface OfferRow {
  id: string;
  listing_id: string;
  buyer_id: string;
  vendor_id: string;
  description: string;
  /** numeric(12,2), as JSON renders it. */
  current_price: number;
  current_offer_by: "buyer" | "vendor";
  status: string;
  round_count: number;
  order_id: string | null;
  expired: boolean;
  /** The shop owner's user id. */
  vendor_user_id: string | null;
  product_name: string | null;
}

/**
 * Negotiated service bookings: a buyer proposes a price for a service listing, the two sides counter
 * up to 7 rounds, an accepted price becomes an order to pay the vendor directly, and the vendor
 * confirms or disputes the buyer's reported payment.
 */
export class ServiceOffersRepository {
  constructor(private readonly db: Executor) {}

  /** to_char(round(x, 2), 'FM999G999G999G990.00'): how the functions write amounts in notifications. */
  async money(amount: number | string): Promise<string> {
    const row = await jsonRow<{ m: string }>(this.db, sql`select to_char(round(${String(amount)}::numeric, 2), 'FM999G999G999G990.00') as m`);
    return row!.m;
  }

  /** An active service of a verified, active shop that is billed by commission (only those can be negotiated). */
  negotiableListing(listingId: string): Promise<{ id: string; name: string; vendor_id: string; vendor_user_id: string | null } | null> {
    return jsonRow(
      this.db,
      sql`select p.id, p.name, p.vendor_id, v.user_id as vendor_user_id
          from public.products p join public.vendors v on v.id = p.vendor_id
          where p.id = ${listingId} and p.is_service = true and p.status = 'active' and p.billing_model = 'commission'
            and v.verification_status = 'verified' and v.is_active = true`,
    );
  }

  async userName(userId: string): Promise<string | null> {
    return (await jsonRow<{ name: string | null }>(this.db, sql`select name from public.users where id = ${userId}`))?.name ?? null;
  }

  async create(listingId: string, buyerId: string, vendorId: string, description: string, price: number): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.service_offers (listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, round_count, expires_at)
        values (${listingId}, ${buyerId}, ${vendorId}, trim(${description}::text), round(${String(price)}::numeric, 2), 'buyer', 'pending', 1, now() + interval '72 hours')
        returning id`),
    );
    return row!.id;
  }

  /** The offer (locked), with the shop owner and the listing's name. */
  lock(offerId: string): Promise<OfferRow | null> {
    return this.fetch(sql`so.id = ${offerId}`);
  }

  /** The offer behind an order (locked). */
  lockByOrder(orderId: string): Promise<OfferRow | null> {
    return this.fetch(sql`so.id = (select so2.id from public.service_offers so2 join public.orders o on o.id = so2.order_id where o.id = ${orderId} limit 1)`);
  }

  private async fetch(where: ReturnType<typeof sql>): Promise<OfferRow | null> {
    const [row] = rowsOf<{ row: OfferRow }>(
      await this.db.execute(sql`
        select json_build_object(
          'id', so.id, 'listing_id', so.listing_id, 'buyer_id', so.buyer_id, 'vendor_id', so.vendor_id, 'description', so.description,
          'current_price', so.current_price, 'current_offer_by', so.current_offer_by, 'status', so.status, 'round_count', so.round_count,
          'order_id', so.order_id, 'expired', so.expires_at <= now(),
          'vendor_user_id', (select user_id from public.vendors where id = so.vendor_id),
          'product_name', (select name from public.products where id = so.listing_id)) as row
        from public.service_offers so where ${where} for update of so`),
    );
    return row?.row ?? null;
  }

  /** abs(current_price - expected) > 0.01, in exact decimal arithmetic. */
  async priceDiffers(offerId: string, expected: number, column: "current_price" = "current_price"): Promise<boolean> {
    const row = await jsonRow<{ d: boolean }>(
      this.db,
      sql`select abs(${sql.identifier(column)} - ${String(expected)}::numeric) > 0.01 as d from public.service_offers where id = ${offerId}`,
    );
    return row?.d ?? false;
  }

  /** The accepted price as an order: a confirmed sale, picked up, paid up front to the vendor. */
  async createOrder(offer: OfferRow): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.orders (buyer_id, vendor_id, order_type, status, total_amount, deposit_amount, delivery_method, delivery_address, delivery_phone,
                                   buyer_note, payment_timing, payment_deposit_percent, service_offer_id, commission_exempt)
        select buyer_id, vendor_id, 'sale', 'confirmed', current_price, 0, 'pickup', null, null, description, 'pay_before', 100, id, false
        from public.service_offers where id = ${offer.id}
        returning id`),
    );
    const orderId = row!.id;
    // The order triggers set a pay-before order's deposit to its total; a service order has none.
    await this.db.execute(sql`update public.orders set deposit_amount = 0 where id = ${orderId}`);
    await this.db.execute(sql`
      insert into public.order_items (order_id, product_id, quantity, unit_price)
      select ${orderId}, listing_id, 1, current_price from public.service_offers where id = ${offer.id}`);
    return orderId;
  }

  async markAccepted(offerId: string, orderId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'awaiting_payment', accepted_at = now(), order_id = ${orderId}, expires_at = now() + interval '48 hours' where id = ${offerId}`);
  }

  async markDeclined(offerId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'declined', expires_at = now() where id = ${offerId}`);
  }

  /** The other side's turn, one more round, 72 more hours. Returns the rounded new price. */
  async counter(offerId: string, price: number): Promise<number> {
    const [row] = rowsOf<{ row: { price: number } }>(
      await this.db.execute(sql`
        update public.service_offers
        set current_price = round(${String(price)}::numeric, 2),
            current_offer_by = case when current_offer_by = 'buyer' then 'vendor' else 'buyer' end,
            status = 'countered', round_count = round_count + 1, expires_at = now() + interval '72 hours'
        where id = ${offerId}
        returning json_build_object('price', round(${String(price)}::numeric, 2)) as row`),
    );
    return row!.row.price;
  }

  /* --------------------------------------------------------------------- payment */

  /** abs(amount - agreed price) > 0.01 for the order's offer. */
  async amountDiffers(offerId: string, amount: number): Promise<boolean> {
    return this.priceDiffers(offerId, amount);
  }

  async shop(vendorId: string): Promise<{ user_id: string | null; business_name: string | null } | null> {
    return jsonRow(this.db, sql`select user_id, business_name from public.vendors where id = ${vendorId}`);
  }

  /** The pending payment the buyer reported for this order (locked), if any. */
  async reportedPayment(orderId: string): Promise<string | null> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        select id from public.payments
        where order_id = ${orderId} and payment_type = 'sale_price' and status = 'pending' and provider_reference = 'service_offer_report'
        order by created_at desc limit 1 for update`),
    );
    return row?.id ?? null;
  }

  async recordReportedPayment(orderId: string, amount: number, existing: string | null): Promise<string> {
    if (existing) {
      // FIX (BASELINE_FINDINGS B9): the original also set provider_reference (to the value it already
      // has), which fires trg_mark_order_payment_unresolved_from_claim; for an offer already reported
      // that trigger sets service_offers.expires_at to null, which the column refuses, so reporting a
      // second time always failed. Leaving the column out of the update keeps the trigger quiet; this
      // function makes the same order changes itself.
      await this.db.execute(sql`update public.payments set amount = ${String(amount)}::numeric, method = 'transfer' where id = ${existing}`);
      return existing;
    }
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.payments (order_id, payment_type, amount, method, status, provider_reference)
        values (${orderId}, 'sale_price', ${String(amount)}::numeric, 'transfer', 'pending', 'service_offer_report') returning id`),
    );
    return row!.id;
  }

  /** The buyer reported paying: the offer waits for the vendor, the order is "payment unresolved". */
  async markReported(offerId: string, orderId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'payment_reported', payment_reported_at = coalesce(payment_reported_at, now()), updated_at = now() where id = ${offerId}`);
    await this.db.execute(sql`
      update public.orders set status = 'payment_unresolved'::public.order_status, payment_unresolved_at = coalesce(payment_unresolved_at, now()),
                               payment_escalated_at = null, awaiting_confirmation_since = null
      where id = ${orderId}`);
  }

  async ownsShop(vendorId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.vendors v where v.id = ${vendorId} and v.user_id = ${userId}`)) !== null;
  }

  /** The vendor confirmed: payment paid, order completed (unless cancelled), any open dispute resolved, offer completed. */
  async confirm(offer: OfferRow, paymentId: string): Promise<void> {
    await this.db.execute(sql`update public.payments set status = 'paid', paid_at = coalesce(paid_at, now()), provider_reference = 'service_offer_confirmed' where id = ${paymentId}`);
    await this.db.execute(sql`
      update public.orders set status = 'completed', completed_at = coalesce(completed_at, now()), awaiting_confirmation_since = null,
                               payment_unresolved_at = null, payment_escalated_at = null
      where id = ${offer.order_id} and status <> 'cancelled'`);
    const dispute = await this.openDispute(offer.order_id);
    if (dispute) {
      await this.db.execute(sql`
        update public.disputes
        set status = 'resolved',
            admin_notes = coalesce(admin_notes, '') || case when coalesce(admin_notes, '') = '' then '' else E'\\n' end || 'Vendor confirmed the reported service payment.'
        where id = ${dispute}`);
    }
    await this.db.execute(sql`update public.service_offers set status = 'completed', completed_at = now(), updated_at = now() where id = ${offer.id}`);
  }

  async openDispute(orderId: string | null): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from public.disputes where order_id = ${orderId}::uuid and status = 'open' order by created_at desc limit 1`);
    return row?.id ?? null;
  }

  async raiseDispute(orderId: string | null): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`insert into public.disputes (order_id, raised_by, reason) values (${orderId}::uuid, 'vendor', 'Vendor disputes the reported service payment.') returning id`),
    );
    return row!.id;
  }

  async markDisputed(offer: OfferRow): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'disputed', updated_at = now() where id = ${offer.id}`);
    await this.db.execute(sql`update public.orders set status = 'disputed' where id = ${offer.order_id}::uuid and status <> 'completed'`);
  }

  /**
   * `select("id,listing_id,buyer_id,vendor_id,description,current_price,current_offer_by,status,round_count,created_at,updated_at,expires_at,
   * accepted_at,payment_reported_at,completed_at,order_id").eq("listing_id", id).order("updated_at", desc).limit(20)` (as the user: own offers only).
   */
  forListing(listingId: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, round_count, created_at, updated_at, expires_at,
                 accepted_at, payment_reported_at, completed_at, order_id
          from public.service_offers where listing_id = ${listingId} order by updated_at desc limit 20`,
    );
  }

  /** `select(...).eq("id", id).maybeSingle()` - the same columns, for one offer (as the user). */
  one(offerId: string): Promise<Record<string, unknown> | null> {
    return jsonRow(
      this.db,
      sql`select id, listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, round_count, created_at, updated_at, expires_at,
                 accepted_at, payment_reported_at, completed_at, order_id
          from public.service_offers where id = ${offerId}`,
    );
  }
}
