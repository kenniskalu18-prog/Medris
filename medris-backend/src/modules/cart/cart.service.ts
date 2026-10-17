import type { CartItem } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { CartRepository } from "../../database/repositories/cart.repository.js";
import { notFound } from "../../shared/errors/app-error.js";

/**
 * The signed-in buyer's cart. Everything runs as the buyer (RLS applies) and
 * every statement also filters on the buyer's id.
 */
export class CartService {
  constructor(private readonly db: () => DataContext) {}

  list(me: Identity): Promise<CartItem[]> {
    return this.db().asUser(me, (tx) => new CartRepository(tx).listForBuyer(me.userId));
  }

  async count(me: Identity): Promise<{ count: number }> {
    const count = await this.db().asUser(me, (tx) => new CartRepository(tx).countForBuyer(me.userId));
    return { count };
  }

  async add(me: Identity, input: { productId: string; quantity: number; variantId?: string | null }): Promise<{ result: unknown }> {
    // add_to_cart() ran with the function owner's rights after its own checks: on the buyer's behalf.
    const result = await this.db().onBehalfOf(me, (tx) => new CartRepository(tx).add(me.userId, input.productId, input.quantity, input.variantId ?? null));
    return { result };
  }

  async setQuantity(me: Identity, itemId: string, quantity: number): Promise<{ id: string; quantity: number }> {
    const updated = await this.db().asUser(me, (tx) => new CartRepository(tx).setQuantity(me.userId, itemId, quantity));
    if (!updated) throw notFound("That item is no longer in your cart.");
    return { id: itemId, quantity };
  }

  async remove(me: Identity, itemIds: string[]): Promise<{ removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new CartRepository(tx).remove(me.userId, itemIds));
    return { removed };
  }

  async clear(me: Identity): Promise<{ removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new CartRepository(tx).clear(me.userId));
    return { removed };
  }

  /** Removes every line of one product (Levi's "remove X from my cart"). */
  async removeProduct(me: Identity, productId: string): Promise<{ removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new CartRepository(tx).removeProduct(me.userId, productId));
    return { removed };
  }
}
