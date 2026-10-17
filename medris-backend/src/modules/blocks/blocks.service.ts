import type { DataContext, Identity } from "../../database/context.js";
import { BlocksRepository } from "../../database/repositories/blocks.repository.js";

/** Blocking people (chat). Runs as the user, so blocked_users' row-level security still decides. */
export class BlocksService {
  constructor(private readonly db: () => DataContext) {}

  list(me: Identity): Promise<{ blockedIds: string[] }> {
    return this.db().asUser(me, async (tx) => ({ blockedIds: await new BlocksRepository(tx).blockedIds(me.userId) }));
  }

  state(me: Identity, userId: string): Promise<{ blocked: boolean }> {
    return this.db().asUser(me, async (tx) => ({ blocked: await new BlocksRepository(tx).isBlocked(me.userId, userId) }));
  }

  /** Blocking oneself, or someone already blocked, is refused by the database, as before. */
  async block(me: Identity, userId: string): Promise<{ blocked: true }> {
    await this.db().asUser(me, (tx) => new BlocksRepository(tx).block(me.userId, userId));
    return { blocked: true };
  }

  async unblock(me: Identity, userId: string): Promise<{ blocked: false; removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new BlocksRepository(tx).unblock(me.userId, userId));
    return { blocked: false, removed };
  }
}
