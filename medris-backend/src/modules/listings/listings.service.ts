import type { DataContext, Identity } from "../../database/context.js";
import { ListingsRepository, type ListingFields, type ListingFilter } from "../../database/repositories/listings.repository.js";
import { AppError, badRequest, notFound } from "../../shared/errors/app-error.js";
import { PackagesRepository, type PackageFields, type PackageFilter } from "../../database/repositories/packages.repository.js";

type Tx = Parameters<Parameters<DataContext["asAnon"]>[0]>[0];

/**
 * Listings (products): the marketplace reads and the shop owner's editing. Runs as the caller, so the
 * table's row-level security and triggers still decide; the owner's writes are limited to the editor's
 * fields, and billing is decided here (FIX S13).
 */
export class ListingsService {
  constructor(private readonly db: () => DataContext) {}

  private read<T>(me: Identity | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    return me ? this.db().asUser(me, work) : this.db().asAnon(work);
  }

  private mine<T>(me: Identity, work: (repo: ListingsRepository, shopId: string) => Promise<T>): Promise<T> {
    return this.db().asUser(me, async (tx) => {
      const repo = new ListingsRepository(tx);
      const shopId = await repo.ownShop(me.userId);
      if (!shopId) throw notFound("You do not have a shop.");
      return work(repo, shopId);
    });
  }

  feed(me: Identity | null, f: ListingFilter): Promise<Record<string, unknown>[]> {
    return this.read(me, (tx) => new ListingsRepository(tx).feed(f));
  }

  detail(me: Identity | null, productId: string): Promise<Record<string, unknown> | null> {
    return this.read(me, (tx) => new ListingsRepository(tx).detail(me?.userId ?? null, productId));
  }

  myListings(me: Identity, o: { includeRemoved: boolean; q: string | null; activeOnly: boolean }): Promise<Record<string, unknown>[]> {
    return this.mine(me, (repo, shop) => repo.mine(shop, o));
  }

  myListing(me: Identity, productId: string): Promise<Record<string, unknown> | null> {
    return this.mine(me, (repo, shop) => repo.mineOne(shop, productId));
  }

  async byReference(me: Identity, reference: string): Promise<{ id: string | null }> {
    return { id: await this.mine(me, (repo, shop) => repo.byReference(shop, reference)) };
  }

  /** A new listing. A monthly one starts paused until its fee is paid (the payment check activates it). */
  create(me: Identity, fields: ListingFields, billingModel: "commission" | "monthly", reference: string | null): Promise<Record<string, unknown>> {
    return this.mine(me, (repo, shop) => repo.create(shop, fields, billingModel, reference));
  }

  async update(me: Identity, productId: string, fields: ListingFields): Promise<Record<string, unknown>> {
    const row = await this.mine(me, (repo, shop) => repo.update(shop, productId, fields));
    if (!row) throw notFound("Product not found.");
    return row;
  }

  /** Pause, discard or reactivate. A monthly listing whose paid period ended answers 409 with `needsPayment` (the app then starts the payment). */
  async setStatus(me: Identity, productId: string, status: "active" | "paused" | "removed", cancelBilling: boolean): Promise<{ updated: number }> {
    const r = await this.mine(me, (repo, shop) => repo.setStatus(shop, productId, status, cancelBilling));
    if (r.needsPayment) throw new AppError(409, "conflict", "This monthly listing needs its fee paid before it can go live again.", { needsPayment: true });
    return { updated: r.updated };
  }

  async clearReference(me: Identity, productId: string): Promise<{ updated: number }> {
    return { updated: await this.mine(me, (repo, shop) => repo.clearReference(shop, productId)) };
  }

  async remove(me: Identity, productId: string): Promise<{ removed: number }> {
    return { removed: await this.mine(me, (repo, shop) => repo.remove(shop, productId)) };
  }

  private myShop<T>(me: Identity, work: (repo: PackagesRepository, shopId: string) => Promise<T>): Promise<T> {
    return this.db().asUser(me, async (tx) => {
      const repo = new PackagesRepository(tx);
      const shopId = await repo.ownShop(me.userId);
      if (!shopId) throw notFound("You do not have a shop.");
      return work(repo, shopId);
    });
  }

  packageFeed(me: Identity | null, f: PackageFilter): Promise<Record<string, unknown>[]> {
    return this.read(me, (tx) => new PackagesRepository(tx).feed(f));
  }

  packageDetail(me: Identity | null, packageId: string): Promise<Record<string, unknown> | null> {
    return this.read(me, (tx) => new PackagesRepository(tx).detail(me?.userId ?? null, packageId));
  }

  myPackages(me: Identity): Promise<Record<string, unknown>[]> {
    return this.myShop(me, (repo, shop) => repo.mine(shop));
  }

  /** A new package with its items (the shop's own products only). A monthly one starts paused until paid. */
  createPackage(me: Identity, f: PackageFields, items: { product_id: string; quantity: number }[], billingModel: "commission" | "monthly"): Promise<Record<string, unknown>> {
    return this.myShop(me, async (repo, shop) => {
      if (!(await repo.ownProducts(shop, items.map((i) => i.product_id)))) throw badRequest("A package can only contain your own products.");
      return repo.create(shop, f, items, billingModel);
    });
  }

  updatePackage(me: Identity, packageId: string, f: PackageFields, items: { product_id: string; quantity: number }[] | null): Promise<Record<string, unknown>> {
    return this.myShop(me, async (repo, shop) => {
      if (items && !(await repo.ownProducts(shop, items.map((i) => i.product_id)))) throw badRequest("A package can only contain your own products.");
      const row = await repo.update(shop, packageId, f, items);
      if (!row) throw notFound("Package not found.");
      return row;
    });
  }

  async setPackageStatus(me: Identity, packageId: string, status: "active" | "paused" | "removed"): Promise<{ updated: number }> {
    const r = await this.myShop(me, (repo, shop) => repo.setStatus(shop, packageId, status));
    if (r.needsPayment) throw new AppError(409, "conflict", "This monthly listing needs its fee paid before it can go live again.", { needsPayment: true });
    return { updated: r.updated };
  }

  async removePackage(me: Identity, packageId: string): Promise<{ removed: number }> {
    return { removed: await this.myShop(me, (repo, shop) => repo.remove(shop, packageId)) };
  }
}
