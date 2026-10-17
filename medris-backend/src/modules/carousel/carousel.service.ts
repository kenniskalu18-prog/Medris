import type { DataContext, Identity } from "../../database/context.js";
import { CarouselRepository, type CarouselSlideInput } from "../../database/repositories/carousel.repository.js";

/** The home page's banners. Runs as the caller: everyone sees active banners; only admins see hidden ones and change them. */
export class CarouselService {
  constructor(private readonly db: () => DataContext) {}

  slides(me: Identity | null, includeInactive: boolean): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new CarouselRepository(tx).slides(!includeInactive);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  async add(me: Identity, slides: CarouselSlideInput[]): Promise<{ added: number }> {
    return { added: await this.db().asUser(me, (tx) => new CarouselRepository(tx).add(me.userId, slides)) };
  }

  async update(me: Identity, id: string, fields: Parameters<CarouselRepository["update"]>[1]): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new CarouselRepository(tx).update(id, fields)) };
  }

  /** New order of the banners (the drag-and-drop list), in one transaction. */
  async reorder(me: Identity, order: { id: string; sort_order: number }[]): Promise<{ updated: number }> {
    return this.db().asUser(me, async (tx) => {
      const repo = new CarouselRepository(tx);
      let updated = 0;
      for (const row of order) updated += await repo.update(row.id, { sort_order: row.sort_order });
      return { updated };
    });
  }

  remove(me: Identity, id: string): Promise<{ removed: boolean; storage_path: string | null }> {
    return this.db().asUser(me, (tx) => new CarouselRepository(tx).remove(id));
  }
}
