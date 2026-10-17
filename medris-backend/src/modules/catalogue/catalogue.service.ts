import type { CatalogueRow } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { CatalogueRepository } from "../../database/repositories/catalogue.repository.js";
import { SearchRepository, type ProductSearchHit } from "../../database/repositories/search.repository.js";
import { badRequest, forbidden, unauthenticated } from "../../shared/errors/app-error.js";
import type { ServicePriceHint } from "./catalogue.schemas.js";
import { isSqlBlank } from "../../lib/sql-text.js";

/** Catalogue reference data and product search. */
export class CatalogueService {
  constructor(private readonly db: () => DataContext) {}

  /** Read as the caller (or anon) so public-read policies apply. */
  sectors(caller: Identity | null, order: "sort_order" | "name"): Promise<CatalogueRow[]> {
    return this.db().asCaller(caller, (tx) => new CatalogueRepository(tx).listSectors(order));
  }

  categories(caller: Identity | null, sectorId?: string): Promise<CatalogueRow[]> {
    return this.db().asCaller(caller, (tx) => new CatalogueRepository(tx).listCategories({ sectorId }));
  }

  /**
   * Replaces: public.search_products_full_v2(text, integer) - best matches first.
   * Runs as the caller, as the original (not SECURITY DEFINER) did.
   */
  search(caller: Identity | null, query: string | null, limit: number): Promise<ProductSearchHit[]> {
    return this.db().asCaller(caller, (tx) => new SearchRepository(tx).products(query, limit));
  }

  /** Replaces: public.search_product_ids(text) - the ids and scores of the best 500 matches. */
  async searchIds(caller: Identity | null, query: string | null): Promise<{ id: string; relevance: number }[]> {
    const hits = await this.search(caller, query, 500);
    return hits.map((h) => ({ id: h.id, relevance: h.relevance }));
  }

  /** Replaces: public.create_vendor_sector(text) - an approved shop (or an admin) adds a sector; an existing one of that name is reused. */
  async createSector(me: Identity | null, name: string | null | undefined): Promise<{ id: string }> {
    if (isSqlBlank(name)) throw badRequest("Sector name is required.");
    return this.asApproved(me, "Only approved vendor accounts can create a new sector.", async (repo) => ({
      id: (await repo.sectorNamed(name)) ?? (await repo.insertSector(name)),
    }));
  }

  /** Replaces: public.create_vendor_category(text, uuid, uuid) - a category under a group of a sector; an existing one of that name is reused. */
  async createCategory(me: Identity | null, input: { name?: string | null; sectorId?: string | null; parentCategoryId?: string | null }): Promise<{ id: string }> {
    const name = input.name;
    if (isSqlBlank(name)) throw badRequest("Category name is required.");
    return this.asApproved(me, "Only approved vendor accounts can create a new category.", async (repo) => {
      const sectorId = input.sectorId ?? null;
      if (!sectorId || !(await repo.sectorExists(sectorId))) throw badRequest("Pick a valid sector first.");
      const parentId = input.parentCategoryId ?? null;
      if (!parentId || !(await repo.categoryInSector(parentId, sectorId))) throw badRequest("Choose a valid category group first.");
      return { id: (await repo.subcategoryNamed(parentId, sectorId, name)) ?? (await repo.insertCategory(name, parentId, sectorId)) };
    });
  }

  /** Replaces: public.get_or_create_custom_sector(text) - the sector a vendor typed when applying or editing their shop. */
  async customSector(me: Identity | null, name: string | null | undefined): Promise<{ id: string }> {
    if (!me) throw unauthenticated("Authentication required");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new CatalogueRepository(tx);
      if (await new AccessRepository(tx).isAdmin(me.userId)) throw badRequest("Admins do not need a vendor sector");
      const clean = await repo.cleanSectorName(name ?? null);
      if (clean === "") throw badRequest("Enter your business sector");
      return { id: await repo.customSector(clean) };
    });
  }

  /** Replaces: public.get_service_price_hint(uuid) - what completed bookings of a service listing cost. */
  servicePriceHint(listingId: string): Promise<ServicePriceHint[]> {
    return this.db().asService((tx) => new CatalogueRepository(tx).servicePriceHint(listingId));
  }

  /** On the caller's behalf (the new row's triggers see them), once they are known to be an admin or an approved shop. */
  private asApproved<T>(me: Identity | null, refusal: string, work: (repo: CatalogueRepository) => Promise<T>): Promise<T> {
    if (!me) throw forbidden(refusal);
    return this.db().onBehalfOf(me, async (tx) => {
      const access = new AccessRepository(tx);
      if (!(await access.isAdmin(me.userId)) && !(await access.hasApprovedShop(me.userId))) throw forbidden(refusal);
      return work(new CatalogueRepository(tx));
    });
  }
}
