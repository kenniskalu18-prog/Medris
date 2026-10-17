import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { textArray } from "../arrays.js";
import { jsonRow, jsonRows } from "../json.js";

/** Which orders a list shows. */
export interface OrderListFilter {
  /** buyer: the caller's purchases; vendor: the shop's sales; either: both (the live-update check). */
  side: "buyer" | "vendor" | "either";
  vendorId: string | null;
  statuses: string[] | null;
  payoutStatus: string | null;
  /** Only orders escalated for payment (payment_escalated_at set). */
  escalated: boolean;
  createdFrom: string | null;
  createdTo: string | null;
  orderBy: "created_at" | "payout_released_at" | "payment_escalated_at";
  limit: number;
}

/**
 * Orders as the app's screens read them (order lists, the order page, counts). Run as the user: only the
 * order's buyer, the shop's owner and admins see an order (row-level security), and the same applies to its
 * items, payments, review and disputes. Each embedded part is what PostgREST's embedding returned.
 */
export class OrderViewsRepository {
  constructor(private readonly db: Executor) {}

  private static payments = sql`coalesce((select json_agg(to_json(p)) from public.payments p where p.order_id = o.id), '[]'::json)`;

  /**
   * The order page: `select("*, vendor:vendors(...), items:order_items(*, variant:product_variants(name), product:products(...)),
   * payments(*), review:reviews(id), disputes(...), package:vendor_packages(name)")` - also every narrower
   * select of one order the app made (its status fields, parties, delivery method, the shop's bank details...).
   */
  detail(orderId: string): Promise<Record<string, unknown> | null> {
    return jsonRow(
      this.db,
      sql`select o.*,
                 (select json_build_object('id', v.id, 'business_name', v.business_name, 'phone', v.phone, 'whatsapp_number', v.whatsapp_number,
                                           'whatsapp_visible', v.whatsapp_visible, 'address', v.address, 'city', v.city, 'opening_hours', v.opening_hours,
                                           'user_id', v.user_id, 'lat', v.lat, 'lng', v.lng, 'logo_url', v.logo_url, 'avg_rating', v.avg_rating,
                                           'review_count', v.review_count, 'verification_status', v.verification_status, 'bank_code', v.bank_code,
                                           'bank_name', v.bank_name, 'account_number', v.account_number, 'account_name', v.account_name)
                  from public.vendors v where v.id = o.vendor_id) as vendor,
                 (select json_build_object('name', u.name) from public.users u where u.id = o.buyer_id) as buyer,
                 coalesce((select json_agg(to_jsonb(oi)
                                           || jsonb_build_object('variant', (select json_build_object('name', pv.name) from public.product_variants pv where pv.id = oi.variant_id),
                                                                 'product', (select json_build_object('id', p.id, 'name', p.name, 'photos', p.photos, 'is_service', p.is_service,
                                                                                                      'quantity_available', p.quantity_available, 'track_quantity', p.track_quantity)
                                                                             from public.products p where p.id = oi.product_id)))
                           from public.order_items oi where oi.order_id = o.id), '[]'::json) as items,
                 ${OrderViewsRepository.payments} as payments,
                 (select json_build_object('id', r.id) from public.reviews r where r.order_id = o.id) as review,
                 coalesce((select json_agg(json_build_object('id', d.id, 'reason', d.reason, 'status', d.status, 'admin_notes', d.admin_notes,
                                                             'vendor_response', d.vendor_response, 'created_at', d.created_at, 'raised_by', d.raised_by, 'attachments', d.attachments))
                           from public.disputes d where d.order_id = o.id), '[]'::json) as disputes,
                 (select json_build_object('name', vp.name) from public.vendor_packages vp where vp.id = o.package_id) as package
          from public.orders o where o.id = ${orderId}`,
    );
  }

  /**
   * The order lists (purchases, sales, earnings, sold items, Levi's "my orders", escalated payments...):
   * `select("*, buyer:users(name), vendor:vendors(...), items:order_items(*, product:products(...)), payments(...)")`
   * with the screen's filters.
   */
  list(me: string, f: OrderListFilter): Promise<Record<string, unknown>[]> {
    const where: SQL[] = [];
    if (f.side === "buyer") where.push(sql`o.buyer_id = ${me}`);
    else if (f.side === "vendor") where.push(sql`o.vendor_id = ${f.vendorId}`);
    else where.push(f.vendorId ? sql`(o.buyer_id = ${me} or o.vendor_id = ${f.vendorId})` : sql`o.buyer_id = ${me}`);
    if (f.statuses?.length) where.push(sql`o.status::text = any(${textArray(f.statuses)})`);
    if (f.payoutStatus) where.push(sql`o.payout_status = ${f.payoutStatus}`);
    if (f.escalated) where.push(sql`o.payment_escalated_at is not null`);
    if (f.payoutStatus === "released") where.push(sql`o.payout_released_at is not null`);
    if (f.createdFrom) where.push(sql`o.created_at >= ${f.createdFrom}::timestamptz`);
    if (f.createdTo) where.push(sql`o.created_at <= ${f.createdTo}::timestamptz`);
    const order =
      f.orderBy === "payout_released_at" ? sql`o.payout_released_at desc` : f.orderBy === "payment_escalated_at" ? sql`o.payment_escalated_at asc` : sql`o.created_at desc`;
    return jsonRows(
      this.db,
      sql`select o.*,
                 (select json_build_object('name', u.name) from public.users u where u.id = o.buyer_id) as buyer,
                 (select json_build_object('id', v.id, 'business_name', v.business_name, 'city', v.city, 'logo_url', v.logo_url)
                  from public.vendors v where v.id = o.vendor_id) as vendor,
                 coalesce((select json_agg(to_jsonb(oi) || jsonb_build_object('product', (select json_build_object('id', p.id, 'is_service', p.is_service, 'name', p.name, 'photos', p.photos)
                                                                                         from public.products p where p.id = oi.product_id)))
                           from public.order_items oi where oi.order_id = o.id), '[]'::json) as items,
                 ${OrderViewsRepository.payments} as payments
          from public.orders o
          where ${sql.join(where, sql` and `)}
          order by ${order} limit ${f.limit}`,
    );
  }

  /**
   * The badges and profile numbers: the caller's open and all purchases, and per status; the shop's open sales
   * and today's. (`select("id", { count: "exact", head: true })` and `select("status")` queries.)
   */
  async counts(me: string, vendorId: string | null, since: string | null): Promise<Record<string, unknown>> {
    const open = sql`('pending', 'confirmed', 'payment_unresolved')`;
    return (await jsonRow(
      this.db,
      sql`select
            (select count(*)::int from public.orders where buyer_id = ${me} and status::text in ${open}) as buyer_open,
            (select count(*)::int from public.orders where buyer_id = ${me}) as buyer_total,
            (select coalesce(json_object_agg(s, n), '{}'::json) from (select status::text as s, count(*)::int as n from public.orders
               where buyer_id = ${me} and status::text in ${open} group by status) x) as buyer_by_status,
            (select count(*)::int from public.orders where vendor_id = ${vendorId}::uuid and status::text in ${open}) as vendor_open,
            (select count(*)::int from public.orders where vendor_id = ${vendorId}::uuid and created_at >= coalesce(${since}::timestamptz, 'infinity')) as vendor_since`,
    ))!;
  }

  /** `select("id", { count: "exact", head: true }).eq("buyer_id", b).eq("vendor_id", v).eq("status", "completed")` - whether they have done business. */
  async completedBetween(buyerId: string, vendorId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.orders where buyer_id = ${buyerId} and vendor_id = ${vendorId} and status = 'completed' limit 1`)) !== null;
  }
}
