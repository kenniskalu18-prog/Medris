import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./cart.routes.js";

/** /api/v1/cart - see cart.routes.ts for the contract and cart.service.ts for the rules. */
export const cartController = controller()
  .route(routes.listCart, async ({ services, user }) => ok(await services.cart.list(user())))
  .route(routes.countCart, async ({ services, user }) => ok(await services.cart.count(user())))
  .route(routes.addToCart, async ({ services, user, input }) => created(await services.cart.add(user(), input.body)))
  .route(routes.deleteCartItems, async ({ services, user, input }) => ok(await services.cart.remove(user(), input.body.ids)))
  .route(routes.setCartQuantity, async ({ services, user, input }) => ok(await services.cart.setQuantity(user(), input.params.id, input.body.quantity)))
  .route(routes.removeCartItem, async ({ services, user, input }) => ok(await services.cart.remove(user(), [input.params.id])))
  .route(routes.clearCart, async ({ services, user }) => ok(await services.cart.clear(user())))
  .route(routes.removeCartProduct, async ({ services, user, input }) => ok(await services.cart.removeProduct(user(), input.params.productId)));
