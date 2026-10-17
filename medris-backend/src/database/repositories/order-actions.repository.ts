import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonRow, jsonRows } from "../json.js";

/** The order fields the order functions check. */
export interface OrderRow {
  id: string;
  buyer_id: string;
  vendor_id: string;
  status: string;
  order_type: string;
  delivery_method: string | null;
  payment_timing: string | null;
  package_id: string | null;
  awaiting_confirmation_since: string | null;
  quantity_proposal: { items?: { id: string; suggested: number | string }[] } | null;
  vendor_user_id: string | null;
  vendor_name: string | null;
}

/** Order lines with what the edit and quantity functions need. */
export interface LineRow {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  name: string;
  quantity_available: number | null;
}

/**
 * What happens to an order after checkout: status changes, confirmation, notes, edits by the buyer,
 * quantity suggestions by the vendor, and the buyer's contact for the vendor.
 */
export class OrderActionsRepository {
  constructor(private readonly db: Executor) {}

  /** The order (locked unless `lock` is false), with its shop's owner and name. */
  async order(orderId: string, lock = true): Promise<OrderRow | null> {
    const [row] = rowsOf<{ row: OrderRow }>(
      await this.db.execute(sql`
        select json_build_object(
          'id', o.id, 'buyer_id', o.buyer_id, 'vendor_id', o.vendor_id, 'status', o.status::text, 'order_type', o.order_type::text,
          'delivery_method', o.delivery_method::text, 'payment_timing', o.payment_timing::text, 'package_id', o.package_id,
          'awaiting_confirmation_since', o.awaiting_confirmation_since, 'quantity_proposal', o.quantity_proposal,
          'vendor_user_id', (select v.user_id from public.vendors v where v.id = o.vendor_id),
          'vendor_name', (select v.business_name from public.vendors v where v.id = o.vendor_id)) as row
        from public.orders o where o.id = ${orderId} ${lock ? sql`for update of o` : sql``}`),
    );
    return row?.row ?? null;
  }

  /** Fails like PostgreSQL does for a value that is not an order_status. */
  async castStatus(status: string): Promise<void> {
    await this.db.execute(sql`select ${status}::public.order_status`);
  }

  /** A paid payment of one of these types. */
  async hasPaid(orderId: string, types: string[]): Promise<boolean> {
    const row = await jsonRow(
      this.db,
      sql`select 1 as x from public.payments where order_id = ${orderId} and payment_type::text = any(${`{${types.join(",")}}`}::text[]) and status = 'paid' limit 1`,
    );
    return row !== null;
  }

  async anyPaid(orderId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.payments where order_id = ${orderId} and status = 'paid' limit 1`)) !== null;
  }

  /** The new status; handed over and returned orders start the buyer's confirmation clock. */
  async setStatus(orderId: string, status: string): Promise<void> {
    await this.db.execute(sql`update public.orders set status = ${status}::public.order_status where id = ${orderId}`);
    if (status === "handed_over" || status === "returned") {
      await this.db.execute(sql`update public.orders set awaiting_confirmation_since = now() where id = ${orderId}`);
    }
  }

  async complete(orderId: string): Promise<void> {
    await this.db.execute(sql`
      update public.orders set status = 'completed'::public.order_status, completed_at = coalesce(completed_at, now()), awaiting_confirmation_since = null
      where id = ${orderId}`);
  }

  async decline(orderId: string, reason: string | null): Promise<void> {
    await this.db.execute(sql`update public.orders set status = 'cancelled', cancellation_reason = ${reason}, cancelled_at = now() where id = ${orderId}`);
  }

  /* ---------------------------------------------------------------------- notes */

  async notesBy(orderId: string, senderId: string): Promise<number> {
    return (await jsonRow<{ n: number }>(this.db, sql`select count(*)::int as n from public.order_notes where order_id = ${orderId} and sender_id = ${senderId}`))!.n;
  }

  async addNote(orderId: string, senderId: string, body: string): Promise<string> {
    const [row] = rowsOf<{ id: string }>(await this.db.execute(sql`insert into public.order_notes (order_id, sender_id, body) values (${orderId}, ${senderId}, ${body}) returning id`));
    return row!.id;
  }

  /* ---------------------------------------------------------------- buyer's edit */

  /** The lines of an order with their products (products locked). */
  async linesForEdit(orderId: string): Promise<LineRow[]> {
    return rowsOf<{ row: LineRow }>(
      await this.db.execute(sql`
        select json_build_object('id', oi.id, 'product_id', oi.product_id, 'quantity', oi.quantity, 'unit_price', oi.unit_price,
                                 'name', p.name, 'quantity_available', p.quantity_available) as row
        from public.order_items oi join public.products p on p.id = oi.product_id
        where oi.order_id = ${orderId}
        for update of p`),
    ).map((r) => r.row);
  }

  /**
   * The requested quantity for a line, as edit_pending_order() read it from the submitted list (the
   * first entry with this order_item_id; 0 when there is none). Conversions happen in PostgreSQL, so a
   * malformed id or quantity fails with the same message.
   */
  async requestedQuantity(items: unknown, lineId: string): Promise<number> {
    const row = await jsonRow<{ qty: number }>(
      this.db,
      sql`select case when r is null then 0 else coalesce((r->>'quantity')::integer, 0) end as qty
          from (select (select x from jsonb_array_elements(${JSON.stringify(items)}::jsonb) x where (x->>'order_item_id')::uuid = ${lineId}::uuid limit 1) as r) t`,
    );
    return row!.qty;
  }

  async takeStock(productId: string, delta: number): Promise<void> {
    if (delta > 0) await this.db.execute(sql`update public.products set quantity_available = quantity_available - ${delta}::int where id = ${productId}`);
    else if (delta < 0) await this.db.execute(sql`update public.products set quantity_available = least(quantity_total, quantity_available + ${Math.abs(delta)}::int) where id = ${productId}`);
  }

  async setLineQuantity(lineId: string, quantity: number): Promise<void> {
    if (quantity === 0) await this.db.execute(sql`delete from public.order_items where id = ${lineId}`);
    else await this.db.execute(sql`update public.order_items set quantity = ${quantity}::int where id = ${lineId}`);
  }

  /** A submitted line with a quantity that is not (or no longer) part of the order. */
  async hasForeignLine(orderId: string, items: unknown): Promise<boolean> {
    const row = await jsonRow<{ x: boolean }>(
      this.db,
      sql`select exists (
            select 1 from jsonb_array_elements(${JSON.stringify(items)}::jsonb) x
            where not exists (select 1 from public.order_items oi where oi.id = (x->>'order_item_id')::uuid and oi.order_id = ${orderId})
              and coalesce((x->>'quantity')::integer,0) > 0) as x`,
    );
    return row!.x;
  }

  async hasLines(orderId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.order_items where order_id = ${orderId} limit 1`)) !== null;
  }

  /** Σ quantity × unit price of the given lines, in exact arithmetic. */
  async itemsTotal(lines: { quantity: number; unit_price: number }[]): Promise<string> {
    if (lines.length === 0) return "0";
    const values = lines.map((l) => sql`(${l.quantity}::int * ${String(l.unit_price)}::numeric)`);
    return (await jsonRow<{ t: string }>(this.db, sql`select (0::numeric + ${sql.join(values, sql` + `)})::text as t`))!.t;
  }

  /** The buyer's details and the new total (items + delivery fee); delivery details only on delivery orders. */
  async saveEdit(orderId: string, itemsTotal: string, note: string | null, address: string | null, phone: string | null): Promise<void> {
    await this.db.execute(sql`
      update public.orders
      set buyer_note = nullif(trim(coalesce(${note}::text, '')), ''),
          delivery_address = case when delivery_method = 'delivery' then nullif(trim(coalesce(${address}::text, delivery_address)), '') else delivery_address end,
          delivery_phone = case when delivery_method = 'delivery' then nullif(trim(coalesce(${phone}::text, delivery_phone)), '') else delivery_phone end,
          total_amount = ${itemsTotal}::numeric + coalesce(delivery_fee, 0)
      where id = ${orderId}`);
  }

  /* --------------------------------------------------------- quantity suggestion */

  /** The order's lines by product name (the order the suggestion lists them in). */
  linesByName(orderId: string): Promise<{ id: string; quantity: number; name: string }[]> {
    return jsonRows(
      this.db,
      sql`select oi.id, oi.quantity, p.name from public.order_items oi join public.products p on p.id = oi.product_id
          where oi.order_id = ${orderId} order by p.name, oi.id`,
    );
  }

  /** The suggested quantity for a line (the first entry with this id), or null when none was given. */
  async suggestedQuantity(items: unknown, lineId: string): Promise<number | null> {
    const row = await jsonRow<{ qty: number | null }>(
      this.db,
      sql`select (select (e->>'quantity')::int from jsonb_array_elements(${JSON.stringify(items)}::jsonb) e where (e->>'id')::uuid = ${lineId}::uuid limit 1) as qty`,
    );
    return row!.qty;
  }

  async saveProposal(orderId: string, lines: unknown[], note: string | null): Promise<void> {
    await this.db.execute(sql`
      update public.orders set quantity_proposal = jsonb_build_object('items', ${JSON.stringify(lines)}::jsonb, 'note', ${note}::text, 'proposed_at', now())
      where id = ${orderId}`);
  }

  async clearProposal(orderId: string): Promise<void> {
    await this.db.execute(sql`update public.orders set quantity_proposal = null where id = ${orderId}`);
  }

  /** A line's quantity (locked), if it is still part of the order. */
  async lockLine(orderId: string, lineId: string): Promise<number | null> {
    const [row] = rowsOf<{ quantity: number }>(
      await this.db.execute(sql`select quantity from public.order_items where id = ${lineId}::uuid and order_id = ${orderId} for update`),
    );
    return row?.quantity ?? null;
  }

  /** The accepted suggestion: new total, and the deposit recomputed (all of it when paying up front). */
  async reprice(orderId: string): Promise<void> {
    await this.db.execute(sql`
      with t as (
        select coalesce(sum(oi.unit_price * oi.quantity), 0) + coalesce((select delivery_fee from public.orders where id = ${orderId}), 0) as total
        from public.order_items oi where oi.order_id = ${orderId})
      update public.orders set quantity_proposal = null, total_amount = t.total,
             deposit_amount = case when payment_timing = 'pay_before' then t.total else round(t.total * coalesce(payment_deposit_percent, 20) / 100, 2) end
      from t where id = ${orderId}`);
  }

  async displayName(userId: string): Promise<string | null> {
    return (await jsonRow<{ n: string | null }>(this.db, sql`select coalesce(nullif(trim(name), ''), 'The customer') as n from public.users where id = ${userId}`))?.n ?? null;
  }

  /** A notification row written directly (these functions did not go through create_notification()). Returns its id. */
  async notify(n: {
    userId: string | null;
    type: string;
    title: string;
    body: string;
    targetParams: Record<string, unknown>;
    actorId?: string | null;
    actorName?: string | null;
    vendorId?: string | null;
    category?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, vendor_id, notification_category ${n.metadata ? sql`, metadata` : sql``})
        values (${n.userId}::uuid, ${n.type}, ${n.title}, ${n.body}, 'orderDetail', ${JSON.stringify(n.targetParams)}::jsonb, ${n.actorId ?? null}::uuid, ${n.actorName ?? null},
                ${n.vendorId ?? null}::uuid, ${n.category ?? null} ${n.metadata ? sql`, ${JSON.stringify(n.metadata)}::jsonb` : sql``})
        returning id`),
    );
    return row!.id;
  }

  /* ---------------------------------------------------------------- reminders */

  /** The caller's order that is still waiting for the vendor. */
  pendingOrderOf(orderId: string, buyerId: string): Promise<{ id: string; vendor_id: string } | null> {
    return jsonRow(this.db, sql`select id, vendor_id from public.orders where id = ${orderId} and buyer_id = ${buyerId} and status = 'pending'`);
  }

  async liveVendorOwner(vendorId: string): Promise<string | null> {
    return (await jsonRow<{ user_id: string }>(this.db, sql`select user_id from public.vendors where id = ${vendorId} and deleted_at is null limit 1`))?.user_id ?? null;
  }

  /** set_order_buyer_location(): only the buyer's pending delivery orders. True when the order was one. */
  async setBuyerLocation(orderId: string, buyerId: string, lat: number, lng: number): Promise<boolean> {
    const rows = rowsOf(
      await this.db.execute(sql`
        update public.orders set buyer_lat = ${lat}::double precision, buyer_lng = ${lng}::double precision
        where id = ${orderId} and buyer_id = ${buyerId} and delivery_method = 'delivery' and status = 'pending'
        returning id`),
    );
    return rows.length > 0;
  }

  /* ------------------------------------------------------------- buyer contact */

  /** get_order_buyer_contact(): the buyer's name once the order is accepted (always for admins); the phone only for admins. */
  buyerContact(orderId: string, userId: string | null, admin: boolean): Promise<{ name: string | null; phone: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select case when o.status::text in ('pending','cancelled') and not ${admin} then null else u.name end as name,
                 case when ${admin} then u.phone else null end as phone
          from public.orders o join public.vendors v on v.id = o.vendor_id join public.users u on u.id = o.buyer_id
          where o.id = ${orderId} and (v.user_id = ${userId}::uuid or ${admin})`,
    );
  }

  /** get_orders_buyer_names(): the same rule for several orders. */
  buyerNames(orderIds: string[], userId: string | null, admin: boolean): Promise<{ order_id: string; name: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select o.id as order_id, case when o.status::text in ('pending','cancelled') and not ${admin} then null else u.name end as name
          from public.orders o join public.vendors v on v.id = o.vendor_id join public.users u on u.id = o.buyer_id
          where o.id = any(${uuidArray(orderIds)}) and (v.user_id = ${userId}::uuid or ${admin})`,
    );
  }

  /**
   * `from("order_notes").select("id,sender_id,body,created_at").eq("order_id", id).order("created_at").limit(60)`,
   * as the user: only the order's buyer and the shop's owner see its notes (row-level security).
   */
  notes(orderId: string): Promise<{ id: string; sender_id: string; body: string; created_at: string }[]> {
    return jsonRows(this.db, sql`select id, sender_id, body, created_at from public.order_notes where order_id = ${orderId} order by created_at asc limit 60`);
  }

  /** `from("payments").select("id,status,amount" | "payment_type,status").eq("order_id", id)` (as the user: the order's buyer, its shop and admins). */
  payments(orderId: string): Promise<{ id: string; payment_type: string; status: string; amount: number }[]> {
    return jsonRows(this.db, sql`select id, payment_type, status, amount from public.payments where order_id = ${orderId}`);
  }
}
