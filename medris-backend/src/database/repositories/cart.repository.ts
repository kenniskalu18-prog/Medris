import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { CartItem } from "../../contracts/v1.js";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow } from "../json.js";
import { badRequest } from "../../shared/errors/app-error.js";
import { AccessRepository } from "./access.repository.js";
import { cartItems } from "../schema/index.js";

/**
 * cart_items for one buyer. Every statement filters on buyer_id in addition
 * to the table's RLS policy (buyer_id = auth.uid()), so a bug in one layer
 * cannot expose or change another buyer's cart.
 */
export class CartRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The cart page's query: items oldest first, each with its variant, product
   * and the product's vendor (same fields the page selected before).
   * Products or vendors that are no longer visible come back as null, as with
   * the previous embedded select, and the page treats them as unavailable.
   */
  async listForBuyer(buyerId: string): Promise<CartItem[]> {
    const result = await this.db.execute(sql`
      select coalesce(json_agg(x.item order by x.created_at), '[]'::json) as items
      from (
        select ci.created_at,
          json_build_object(
            'id', ci.id,
            'variant_id', ci.variant_id,
            'quantity', ci.quantity,
            'created_at', ci.created_at,
            'variant', (select to_json(pv) from public.product_variants pv where pv.id = ci.variant_id),
            'product', (
              select json_build_object(
                'id', p.id, 'name', p.name, 'listing_type', p.listing_type, 'is_service', p.is_service,
                'sale_price', p.sale_price, 'discount_price', p.discount_price, 'rental_rate', p.rental_rate,
                'photos', p.photos, 'quantity_available', p.quantity_available, 'status', p.status,
                'delivery_fee', p.delivery_fee, 'delivery_fee_mode', p.delivery_fee_mode, 'delivery_fee_per_km', p.delivery_fee_per_km,
                'vendor', (
                  select json_build_object(
                    'id', v.id, 'business_name', v.business_name, 'previous_business_name', v.previous_business_name,
                    'name_changed_at', v.name_changed_at, 'is_active', v.is_active, 'verification_status', v.verification_status,
                    'delivery_fee', v.delivery_fee, 'delivery_fee_mode', v.delivery_fee_mode, 'delivery_fee_per_km', v.delivery_fee_per_km,
                    'lat', v.lat, 'lng', v.lng)
                  from public.vendors v where v.id = p.vendor_id)
              )
              from public.products p where p.id = ci.product_id)
          ) as item
        from public.cart_items ci
        where ci.buyer_id = ${buyerId}
      ) x`);
    return rowsOf<{ items: CartItem[] }>(result)[0]?.items ?? [];
  }

  async countForBuyer(buyerId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(cartItems).where(eq(cartItems.buyerId, buyerId));
    return Number(row?.n ?? 0);
  }

  /**
   * Replaces: public.add_to_cart(uuid, integer, uuid)
   * Adds a product (or one of its varieties) to the buyer's cart, merging with the same line. Only
   * products on sale (not services or rentals) of verified, active shops; never one's own shop; not
   * for admins. Run it on the buyer's behalf (DataContext.onBehalfOf). Returns null, as the function did.
   */
  async add(buyerId: string, productId: string, quantity: number | null, variantId: string | null = null): Promise<null> {
    if (await new AccessRepository(this.db).isAdmin(buyerId)) throw badRequest("Admin accounts cannot make purchases on Levromart.");
    const qty = quantity == null || quantity < 1 ? 1 : quantity;
    const product = await jsonRow<{ listing_type: string; vendor_user_id: string | null }>(
      this.db,
      sql`select p.listing_type::text as listing_type, v.user_id as vendor_user_id
          from public.products p join public.vendors v on v.id = p.vendor_id
          where p.id = ${productId} and p.status = 'active' and p.is_service = false and v.verification_status = 'verified' and v.is_active = true`,
    );
    if (!product) throw badRequest("This product is not available to add to cart right now.");
    if (product.vendor_user_id === buyerId) throw badRequest("You can't buy from your own shop.");
    if (product.listing_type === "rent") throw badRequest("Rentals need dates picked on the product page, they can't be added to a cart.");
    if (variantId) {
      const variant = await jsonRow<{ product_id: string }>(this.db, sql`select product_id from public.product_variants where id = ${variantId}`);
      if (variant?.product_id !== productId) throw badRequest("invalid product variety");
    }
    const same = sql`buyer_id = ${buyerId} and product_id = ${productId} and variant_id is not distinct from ${variantId}::uuid`;
    const merged = rowsOf(await this.db.execute(sql`update public.cart_items set quantity = cart_items.quantity + ${qty}::int where ${same} returning id`));
    if (merged.length === 0) {
      await this.db.execute(sql`insert into public.cart_items (buyer_id, product_id, variant_id, quantity) values (${buyerId}, ${productId}, ${variantId}::uuid, ${qty}::int)`);
    }
    return null;
  }

  async setQuantity(buyerId: string, itemId: string, quantity: number): Promise<boolean> {
    const rows = await this.db
      .update(cartItems)
      .set({ quantity })
      .where(and(eq(cartItems.id, itemId), eq(cartItems.buyerId, buyerId)))
      .returning({ id: cartItems.id });
    return rows.length > 0;
  }

  async remove(buyerId: string, itemIds: string[]): Promise<number> {
    if (!itemIds.length) return 0;
    const rows = await this.db
      .delete(cartItems)
      .where(and(eq(cartItems.buyerId, buyerId), inArray(cartItems.id, itemIds)))
      .returning({ id: cartItems.id });
    return rows.length;
  }

  async clear(buyerId: string): Promise<number> {
    const rows = await this.db.delete(cartItems).where(eq(cartItems.buyerId, buyerId)).returning({ id: cartItems.id });
    return rows.length;
  }

  /** `delete().eq("buyer_id", me).eq("product_id", id)` - every line of that product (any variety). */
  async removeProduct(buyerId: string, productId: string): Promise<number> {
    const rows = await this.db
      .delete(cartItems)
      .where(and(eq(cartItems.buyerId, buyerId), eq(cartItems.productId, productId)))
      .returning({ id: cartItems.id });
    return rows.length;
  }
}
