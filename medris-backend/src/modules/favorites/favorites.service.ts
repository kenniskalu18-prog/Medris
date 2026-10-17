import type { FavoritesResponse } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { FavoritesRepository } from "../../database/repositories/favorites.repository.js";

export type FavoriteKind = "product" | "package";

/** Saved products and packages (wishlist). Runs as the user, so RLS applies (and stops admins saving packages). */
export class FavoritesService {
  constructor(private readonly db: () => DataContext) {}

  list(me: Identity): Promise<FavoritesResponse> {
    return this.db().asUser(me, async (tx) => {
      const repo = new FavoritesRepository(tx);
      return { productIds: await repo.productIds(me.userId), packageIds: await repo.packageIds(me.userId) };
    });
  }

  async save(me: Identity, kind: FavoriteKind, id: string): Promise<{ saved: true; created: boolean }> {
    const created = await this.db().asUser(me, (tx) => {
      const repo = new FavoritesRepository(tx);
      return kind === "product" ? repo.addProduct(me.userId, id) : repo.addPackage(me.userId, id);
    });
    return { saved: true, created };
  }

  async unsave(me: Identity, kind: FavoriteKind, id: string): Promise<{ saved: false; removed: number }> {
    const removed = await this.db().asUser(me, (tx) => {
      const repo = new FavoritesRepository(tx);
      return kind === "product" ? repo.removeProduct(me.userId, id) : repo.removePackage(me.userId, id);
    });
    return { saved: false, removed };
  }

  /** The wishlist page's saved products, newest first, with their shop. Replaces the app's select on favorites; runs as the user. */
  savedProducts(me: Identity): Promise<{ product: Record<string, unknown> | null }[]> {
    return this.db().asUser(me, (tx) => new FavoritesRepository(tx).savedProducts(me.userId));
  }

  /** The wishlist page's saved packages, newest first, with their shop and items. Replaces the app's select on package_favorites. */
  savedPackages(me: Identity): Promise<{ package: Record<string, unknown> | null }[]> {
    return this.db().asUser(me, (tx) => new FavoritesRepository(tx).savedPackages(me.userId));
  }
}
