import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRows } from "../json.js";

/**
 * The read queries behind Levi's tools, one method per query the original
 * code sent to Supabase's REST API (same columns, filters, order and limits;
 * embedded rows as nested JSON). Levi runs them as service_role and scopes
 * every "my_*" query to the verified caller's id itself.
 */
type Row = Record<string, unknown>;

const VENDOR_CARD = sql`json_build_object('id', v.id, 'business_name', v.business_name, 'city', v.city, 'sector_id', v.sector_id, 'avg_rating', v.avg_rating,
  'review_count', v.review_count, 'lat', v.lat, 'lng', v.lng, 'verification_status', v.verification_status, 'is_active', v.is_active)`;

export class LeviRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Counts today's Levi message; true while within the daily limit.
   * Replaces: public.increment_chat_usage(uuid, integer)
   */
  async incrementChatUsage(userId: string, limit: number): Promise<boolean> {
    const [row] = await jsonReturning<{ count: number }>(
      this.db,
      sql`insert into public.chat_usage (user_id, day, count) values (${userId}, current_date, 1)
          on conflict (user_id, day) do update set count = public.chat_usage.count + 1
          returning count`,
    );
    return row!.count <= limit;
  }

  /**
   * Adds today's text-to-speech characters; true while within the daily limit.
   * Replaces: public.increment_tts_usage(uuid, integer, integer)
   */
  async incrementTtsUsage(userId: string, chars: number, dailyLimit: number): Promise<boolean> {
    const [row] = await jsonReturning<{ chars: number }>(
      this.db,
      sql`insert into public.tts_usage (user_id, day, chars) values (${userId}, current_date, ${chars})
          on conflict (user_id, day) do update set chars = public.tts_usage.chars + ${chars}
          returning chars`,
    );
    return row!.chars <= dailyLimit;
  }

  sectors(): Promise<Row[]> {
    return jsonRows(this.db, sql`select id, name, sort_order from public.sectors order by sort_order asc`);
  }

  categories(): Promise<Row[]> {
    return jsonRows(this.db, sql`select id, name, sector_id, parent_category_id from public.categories order by name asc limit 1000`);
  }

  verifiedVendors(): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select id, business_name, city, sector_id, avg_rating, review_count, lat, lng, verification_status, is_active
      from public.vendors where verification_status = 'verified' and is_active = true limit 600`);
  }

  /** Active products of verified, active vendors (`vendor:vendors!inner(...)` with filters on the vendor). */
  activeProducts(): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select p.id, p.name, p.description, p.created_at, p.listing_type, p.sale_price, p.discount_price, p.rental_rate, p.rental_rate_unit,
        p.quantity_available, p.is_service, p.service_price_unit, p.view_count, p.category_id, ${VENDOR_CARD} as vendor
      from public.products p join public.vendors v on v.id = p.vendor_id
      where p.status = 'active' and v.verification_status = 'verified' and v.is_active = true
      order by p.created_at desc limit 700`);
  }

  activePackages(): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select k.id, k.vendor_id, k.name, k.description, k.price, k.photos, k.created_at,
        json_build_object('id', v.id, 'business_name', v.business_name, 'city', v.city, 'avg_rating', v.avg_rating, 'review_count', v.review_count,
          'lat', v.lat, 'lng', v.lng, 'verification_status', v.verification_status, 'is_active', v.is_active) as vendor
      from public.vendor_packages k join public.vendors v on v.id = k.vendor_id
      where k.status = 'active' and v.verification_status = 'verified' and v.is_active = true
      order by k.created_at desc limit 500`);
  }

  /** One product by id with its vendor (any status, as before). */
  product(productId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select p.id, p.name, p.description, p.created_at, p.listing_type, p.sale_price, p.discount_price, p.rental_rate, p.rental_rate_unit,
        p.quantity_available, p.is_service, p.service_price_unit, p.view_count, p.category_id,
        (select ${VENDOR_CARD} from public.vendors v where v.id = p.vendor_id) as vendor
      from public.products p where p.id = ${productId}`);
  }

  vendor(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select id, business_name, city, address, phone, whatsapp_number, avg_rating, review_count, verification_status, is_active, lat, lng,
        sector_id, business_hours, allow_after_hours_messages
      from public.vendors where id = ${vendorId}`);
  }

  myVendor(userId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select id, business_name, city, address, phone, avg_rating, review_count, is_active, verification_status, commission_pct, business_hours,
        allow_after_hours_messages, lat, lng, sector_id
      from public.vendors where user_id = ${userId} and deleted_at is null`);
  }

  myProfile(userId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`select id, name, email, phone, city, address, avatar_url, role, ai_data_consent, created_at from public.users where id = ${userId}`);
  }

  myWishlist(userId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select f.id, f.created_at,
        (select json_build_object('id', p.id, 'name', p.name, 'sale_price', p.sale_price, 'discount_price', p.discount_price, 'rental_rate', p.rental_rate,
                                  'listing_type', p.listing_type, 'quantity_available', p.quantity_available, 'status', p.status,
                                  'vendor', (select json_build_object('id', v.id, 'business_name', v.business_name) from public.vendors v where v.id = p.vendor_id))
         from public.products p where p.id = f.product_id) as product
      from public.favorites f where f.buyer_id = ${userId} order by f.created_at desc limit 100`);
  }

  vendorProducts(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select id, name, status, listing_type, sale_price, discount_price, rental_rate, rental_rate_unit, quantity_total, quantity_available,
        view_count, created_at, is_service, category_id
      from public.products where vendor_id = ${vendorId} order by created_at desc limit 500`);
  }

  private orderItems = sql`(select coalesce(json_agg(json_build_object('quantity', oi.quantity, 'unit_price', oi.unit_price,
      'product', (select json_build_object('id', p.id, 'name', p.name) from public.products p where p.id = oi.product_id))), '[]'::json)
    from public.order_items oi where oi.order_id = o.id)`;

  /**
   * Orders have no updated_at column; the original query asked for one, so
   * Supabase rejected it and Levi always saw no orders. The time of the last
   * status change is returned under that name instead.
   */
  vendorOrders(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select o.id, o.status, o.order_type, o.total_amount, o.created_at, o.status_changed_at as updated_at, o.package_id, ${this.orderItems} as items
      from public.orders o where o.vendor_id = ${vendorId} order by o.created_at desc limit 200`);
  }

  myOrders(userId: string, status: string | null, limit: number): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select o.id, o.status, o.order_type, o.total_amount, o.created_at, o.status_changed_at as updated_at,
        (select json_build_object('id', v.id, 'business_name', v.business_name) from public.vendors v where v.id = o.vendor_id) as vendor,
        ${this.orderItems} as items
      from public.orders o
      where o.buyer_id = ${userId} ${status ? sql`and o.status::text = ${status}` : sql``}
      order by o.created_at desc limit ${limit}`);
  }

  myCart(userId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select ci.id, ci.quantity,
        (select json_build_object('id', p.id, 'name', p.name, 'listing_type', p.listing_type, 'sale_price', p.sale_price, 'discount_price', p.discount_price,
                                  'rental_rate', p.rental_rate, 'quantity_available', p.quantity_available, 'status', p.status,
                                  'vendor', (select json_build_object('id', v.id, 'business_name', v.business_name) from public.vendors v where v.id = p.vendor_id))
         from public.products p where p.id = ci.product_id) as product
      from public.cart_items ci where ci.buyer_id = ${userId}`);
  }

  conversations(owner: { vendorId?: string; buyerId?: string }): Promise<Row[]> {
    const where = owner.vendorId ? sql`c.vendor_id = ${owner.vendorId}` : sql`c.buyer_id = ${owner.buyerId ?? null}`;
    return jsonRows(this.db, sql`
      select c.id, c.buyer_id, c.vendor_id,
        (select json_build_object('id', u.id, 'name', u.name) from public.users u where u.id = c.buyer_id) as buyer,
        (select json_build_object('id', v.id, 'business_name', v.business_name) from public.vendors v where v.id = c.vendor_id) as vendor
      from public.conversations c where ${where} limit 100`);
  }

  messagesIn(conversationIds: string[]): Promise<Row[]> {
    if (!conversationIds.length) return Promise.resolve([]);
    return jsonRows(this.db, sql`
      select conversation_id, sender_id, body, created_at, read_at from public.messages
      where conversation_id in (${sql.join(conversationIds.map((id) => sql`${id}`), sql`, `)})
      order by created_at desc limit 300`);
  }

  vendorOrderSummaries(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`select id, status, total_amount, created_at from public.orders where vendor_id = ${vendorId} order by created_at desc limit 500`);
  }

  vendorProductStats(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select id, name, status, view_count, quantity_available, created_at from public.products where vendor_id = ${vendorId} order by view_count desc limit 500`);
  }

  vendorOrderItems(vendorId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select oi.product_id, oi.quantity, oi.unit_price, json_build_object('status', o.status, 'vendor_id', o.vendor_id) as order
      from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.vendor_id = ${vendorId} limit 1000`);
  }

  favoritesOf(productIds: string[]): Promise<Row[]> {
    if (!productIds.length) return Promise.resolve([]);
    return jsonRows(this.db, sql`select product_id from public.favorites where product_id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})`);
  }

  /** An active product of a verified, active vendor (for "add to cart"). */
  purchasableProduct(productId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select p.id, p.name, p.listing_type, p.sale_price, p.quantity_available, p.is_service,
        json_build_object('id', v.id, 'business_name', v.business_name, 'verification_status', v.verification_status, 'is_active', v.is_active) as vendor
      from public.products p join public.vendors v on v.id = p.vendor_id
      where p.id = ${productId} and p.status = 'active' and v.verification_status = 'verified' and v.is_active = true`);
  }

  cartIds(userId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`select id from public.cart_items where buyer_id = ${userId}`);
  }

  cartLine(userId: string, productId: string): Promise<Row[]> {
    return jsonRows(this.db, sql`
      select ci.id, (select json_build_object('name', p.name) from public.products p where p.id = ci.product_id) as product
      from public.cart_items ci where ci.buyer_id = ${userId} and ci.product_id = ${productId}`);
  }

  async deleteCartLine(userId: string, id: string): Promise<void> {
    await this.db.execute(sql`delete from public.cart_items where id = ${id} and buyer_id = ${userId}`);
  }
}
