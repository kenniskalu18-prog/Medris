import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { ProductsRepository, type InventoryItem, type ProductRegionRow, type VariantRow } from "../../database/repositories/products.repository.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";
import type { InventoryDeletion } from "./products.schemas.js";

/** Product varieties, the admin inventory and a shop's sales by area. */
export class ProductsService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.get_owned_product_variants(uuid) - the shop owner (or an admin) reads a product's varieties for editing. */
  async variants(me: Identity | null, productId: string): Promise<VariantRow[]> {
    if (!me) throw forbidden("You must be signed in.");
    return this.db().asService(async (tx) => {
      const repo = new ProductsRepository(tx);
      const access = new AccessRepository(tx);
      const vendorId = await repo.vendorOf(productId);
      const allowed = vendorId !== null && ((await access.ownsVendor(me.userId, vendorId)) || (await access.isAdmin(me.userId)));
      if (!allowed) throw forbidden("You do not have permission to view this product.");
      return repo.variants(productId);
    });
  }

  /**
   * Replaces: public.save_product_variants(uuid, jsonb) - the product's full list of varieties, in one go:
   * submitted ids of this product are updated, anything else is added (keeping a submitted id), and
   * varieties left out are deleted. Returns the saved list.
   */
  async saveVariants(me: Identity | null, productId: string, variants: unknown): Promise<VariantRow[]> {
    if (!me) throw forbidden("You must be signed in.");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ProductsRepository(tx);
      const access = new AccessRepository(tx);
      const vendorId = await repo.vendorOf(productId);
      if (!vendorId) throw notFound("Product not found.");
      if (!(await access.ownsVendor(me.userId, vendorId)) && !(await access.isAdmin(me.userId))) {
        throw forbidden("You do not have permission to edit this product.");
      }
      if (!Array.isArray(variants)) throw badRequest("Invalid varieties payload.");

      await repo.enterBatchVariantSave();
      const kept: string[] = [];
      for (const item of variants) {
        const v = await repo.parseVariant(item);
        const name = v.name;
        if (name === null) throw badRequest("Every variety needs a variety name.");
        const sale = v.sale_price === null ? null : Number(v.sale_price);
        if (sale === null || sale <= 0) throw badRequest(`Enter a valid sale price for ${name}.`);
        if (v.discount_price !== null) {
          const discount = Number(v.discount_price);
          if (discount <= 0 || discount >= sale) throw badRequest(`Discount price for ${name} must be lower than its regular price.`);
        }
        if (v.quantity_available < 0) throw badRequest(`Quantity for ${name} cannot be negative.`);

        if (v.id !== null && (await repo.variantBelongs(v.id, productId))) {
          await repo.updateVariant(productId, { ...v, id: v.id, name });
          kept.push(v.id);
        } else {
          kept.push(await repo.insertVariant(productId, { ...v, name }));
        }
      }
      await repo.deleteVariantsExcept(productId, kept);
      return repo.variants(productId);
    });
  }

  /** Replaces: public.admin_get_inventory() - every product admins have not removed, by name. */
  async inventory(me: Identity | null): Promise<InventoryItem[]> {
    return this.asAdmin(me, "Only admins can view inventory.", (repo) => repo.inventory());
  }

  /**
   * Replaces: public.admin_delete_inventory_product(uuid) - deleted for good when nobody ordered it,
   * otherwise hidden ('removed') so order history keeps it. The admin gets a notification either way.
   */
  async deleteInventoryProduct(me: Identity | null, productId: string): Promise<InventoryDeletion> {
    return this.asAdmin(me, "Only admins can delete inventory products.", async (repo, notifier) => {
      const product = await repo.lockInventoryProduct(productId);
      if (!product) throw notFound("Product not found in inventory.");
      const name = product.name ?? "Unnamed product";
      const notify = (title: string, body: string) =>
        notifier.createQuietly({ userId: me!.userId, type: "admin_inventory_product_deleted", title, body, targetView: "adminInventory", targetParams: {}, actorId: me!.userId });
      if (!(await repo.hasOrders(productId))) {
        await repo.deleteProduct(productId);
        await notify("Inventory product deleted", `Product “${name}” was permanently deleted from inventory.`);
        return { deleted: true, permanent: true, product_id: productId, product_name: name };
      }
      await repo.adminRemove(productId, me!.userId);
      await notify("Inventory product removed", `Product “${name}” was removed from the inventory view while preserving order history.`);
      return { deleted: true, permanent: false, preserved_order_history: true, product_id: productId, product_name: name };
    });
  }

  /** Replaces: public.get_vendor_product_regions(uuid) - the shop owner (or an admin) sees where each product sells. */
  async productRegions(me: Identity | null, vendorId: string): Promise<ProductRegionRow[]> {
    return this.db().asService(async (tx) => {
      const access = new AccessRepository(tx);
      if (!(await access.ownsVendor(me?.userId, vendorId)) && !(await access.isAdmin(me?.userId))) {
        throw forbidden("Not authorized to view this vendor's data");
      }
      return new ProductsRepository(tx).productRegions(vendorId);
    });
  }

  /** On the admin's behalf (triggers and notifications see them), after the admin check. */
  private asAdmin<T>(me: Identity | null, refusal: string, work: (repo: ProductsRepository, notify: NotificationWriter) => Promise<T>): Promise<T> {
    if (!me) return Promise.reject(forbidden(refusal));
    return this.db().onBehalfOf(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me.userId))) throw forbidden(refusal);
      return work(new ProductsRepository(tx), new NotificationWriter(tx));
    });
  }
}
