import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRows } from "../json.js";
import { favorites, packageFavorites } from "../schema/index.js";

/** Saved products (favorites) and saved packages (package_favorites) of one buyer. */
export class FavoritesRepository {
  constructor(private readonly db: Executor) {}

  async productIds(buyerId: string): Promise<string[]> {
    const rows = await this.db.select({ id: favorites.productId }).from(favorites).where(eq(favorites.buyerId, buyerId));
    return rows.map((r) => r.id);
  }

  async packageIds(buyerId: string): Promise<string[]> {
    const rows = await this.db.select({ id: packageFavorites.packageId }).from(packageFavorites).where(eq(packageFavorites.buyerId, buyerId));
    return rows.map((r) => r.id);
  }

  /** Idempotent: saving an already-saved product does nothing. */
  async addProduct(buyerId: string, productId: string): Promise<boolean> {
    const existing = await this.db
      .select({ id: favorites.id })
      .from(favorites)
      .where(and(eq(favorites.buyerId, buyerId), eq(favorites.productId, productId)))
      .limit(1);
    if (existing.length) return false;
    await this.db.insert(favorites).values({ buyerId, productId });
    return true;
  }

  async removeProduct(buyerId: string, productId: string): Promise<number> {
    const rows = await this.db
      .delete(favorites)
      .where(and(eq(favorites.buyerId, buyerId), eq(favorites.productId, productId)))
      .returning({ id: favorites.id });
    return rows.length;
  }

  async addPackage(buyerId: string, packageId: string): Promise<boolean> {
    const existing = await this.db
      .select({ id: packageFavorites.id })
      .from(packageFavorites)
      .where(and(eq(packageFavorites.buyerId, buyerId), eq(packageFavorites.packageId, packageId)))
      .limit(1);
    if (existing.length) return false;
    await this.db.insert(packageFavorites).values({ buyerId, packageId });
    return true;
  }

  async removePackage(buyerId: string, packageId: string): Promise<number> {
    const rows = await this.db
      .delete(packageFavorites)
      .where(and(eq(packageFavorites.buyerId, buyerId), eq(packageFavorites.packageId, packageId)))
      .returning({ id: packageFavorites.id });
    return rows.length;
  }

  /**
   * The wishlist page: `from("favorites").select("product:products(id, name, listing_type, sale_price, rental_rate,
   * rental_rate_unit, photos, quantity_available, condition, is_service, service_price_unit, status,
   * vendor:vendors(id, business_name, verification_status, is_active, logo_url))").eq("buyer_id", me).order("created_at", desc)`.
   * A product (or shop) the caller may no longer see comes back as null, as before. Run as the user.
   */
  savedProducts(buyerId: string): Promise<{ product: Record<string, unknown> | null }[]> {
    return jsonRows(
      this.db,
      sql`select (select json_build_object('id', p.id, 'name', p.name, 'listing_type', p.listing_type, 'sale_price', p.sale_price, 'rental_rate', p.rental_rate,
                                           'rental_rate_unit', p.rental_rate_unit, 'photos', p.photos, 'quantity_available', p.quantity_available,
                                           'condition', p.condition, 'is_service', p.is_service, 'service_price_unit', p.service_price_unit, 'status', p.status,
                                           'vendor', (select json_build_object('id', v.id, 'business_name', v.business_name, 'verification_status', v.verification_status,
                                                                               'is_active', v.is_active, 'logo_url', v.logo_url)
                                                      from public.vendors v where v.id = p.vendor_id))
                  from public.products p where p.id = f.product_id) as product
          from public.favorites f where f.buyer_id = ${buyerId} order by f.created_at desc`,
    );
  }

  /**
   * The wishlist page: `from("package_favorites").select("package:vendor_packages(id, vendor_id, name, description, price,
   * photos, created_at, status, vendor:vendors!inner(id,business_name,logo_url,delivery_fee,verification_status,is_active),
   * items:package_items(quantity, product:products(id,name,photos)))").eq("buyer_id", me).order("created_at", desc)`.
   * The package is null when the caller may not see it or its shop (the inner join). Run as the user.
   */
  savedPackages(buyerId: string): Promise<{ package: Record<string, unknown> | null }[]> {
    return jsonRows(
      this.db,
      sql`select (select json_build_object('id', vp.id, 'vendor_id', vp.vendor_id, 'name', vp.name, 'description', vp.description, 'price', vp.price,
                                           'photos', vp.photos, 'created_at', vp.created_at, 'status', vp.status,
                                           'vendor', json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url,
                                                                       'delivery_fee', v.delivery_fee, 'verification_status', v.verification_status, 'is_active', v.is_active),
                                           'items', coalesce((select json_agg(json_build_object('quantity', pi.quantity,
                                                                    'product', (select json_build_object('id', pr.id, 'name', pr.name, 'photos', pr.photos)
                                                                                from public.products pr where pr.id = pi.product_id)))
                                                              from public.package_items pi where pi.package_id = vp.id), '[]'::json))
                  from public.vendor_packages vp join public.vendors v on v.id = vp.vendor_id
                  where vp.id = pf.package_id) as package
          from public.package_favorites pf where pf.buyer_id = ${buyerId} order by pf.created_at desc`,
    );
  }
}
