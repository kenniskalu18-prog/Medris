import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRows } from "../json.js";

export interface NewEquipmentRequest {
  title: string;
  description: string | null;
  category_id: string | null;
  city: string | null;
  needed_from: string | null;
  needed_to: string | null;
  request_type: "rent" | "buy";
  photos: string[];
  campus_id: string | null;
}

/**
 * Buyers' requests ("I need a generator for Saturday") and shops' offers on them, as the app's table
 * queries used them. Run as the user: row-level security (open requests for everyone; one's own; offers
 * only for the buyer and the offering shop) and the triggers (buyer's name and photo, notifications) decide.
 */
export class EquipmentRequestsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * `select("*, offers:request_offers(id, vendor_id, message, price, status, created_at, vendor:vendors(business_name, avg_rating,
   * phone, whatsapp_number, delivery_fee))").eq("buyer_id", me).order("created_at", desc)`
   */
  mine(me: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select r.*,
                 coalesce((select json_agg(json_build_object('id', o.id, 'vendor_id', o.vendor_id, 'message', o.message, 'price', o.price, 'status', o.status, 'created_at', o.created_at,
                                                             'vendor', (select json_build_object('business_name', v.business_name, 'avg_rating', v.avg_rating, 'phone', v.phone,
                                                                                                 'whatsapp_number', v.whatsapp_number, 'delivery_fee', v.delivery_fee)
                                                                        from public.vendors v where v.id = o.vendor_id)))
                           from public.request_offers o where o.request_id = r.id), '[]'::json) as offers
          from public.equipment_requests r where r.buyer_id = ${me} order by r.created_at desc`,
    );
  }

  /** `select("*, offers:request_offers(id, vendor_id, status)").eq("status", "open").order("created_at", desc)` - offers the caller may see. */
  open(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select r.*,
                 coalesce((select json_agg(json_build_object('id', o.id, 'vendor_id', o.vendor_id, 'status', o.status)) from public.request_offers o where o.request_id = r.id), '[]'::json) as offers
          from public.equipment_requests r where r.status = 'open' order by r.created_at desc`,
    );
  }

  /** `insert({ buyer_id: me, ... })` - the buyer's name and photo come from their profile (trigger). */
  async create(me: string, r: NewEquipmentRequest): Promise<string> {
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.equipment_requests (buyer_id, title, description, category_id, city, needed_from, needed_to, request_type, photos, campus_id)
          values (${me}, ${r.title}, ${r.description}, ${r.category_id}::uuid, ${r.city}, ${r.needed_from}::date, ${r.needed_to}::date, ${r.request_type},
                  ${JSON.stringify(r.photos)}::jsonb, ${r.campus_id})
          returning id`,
    );
    return row!.id;
  }

  /** `update({ status: "cancelled" }).eq("id", id).eq("buyer_id", me).eq("status", "open")` - how many changed. */
  async cancel(me: string, requestId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.equipment_requests set status = 'cancelled' where id = ${requestId} and buyer_id = ${me} and status = 'open' returning id`)).length;
  }

  /** `from("request_offers").insert({ request_id, vendor_id, message, price })` - only the shop's owner, on an open request. */
  async offer(requestId: string, vendorId: string, message: string | null, price: number | null): Promise<string> {
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.request_offers (request_id, vendor_id, message, price) values (${requestId}, ${vendorId}, ${message}, ${price}::numeric) returning id`,
    );
    return row!.id;
  }
}
