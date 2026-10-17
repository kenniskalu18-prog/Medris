import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./products.routes.js";

/** Product varieties, inventory and sales by area - see products.routes.ts for the contract. */
export const productsController = controller()
  .route(routes.productVariants, async ({ services, identity, input }) => ok(await services.products.variants(identity, input.params.productId)))
  .route(routes.saveProductVariants, async ({ services, identity, input }) =>
    ok(await services.products.saveVariants(identity, input.params.productId, input.body.variants)),
  )
  .route(routes.adminInventory, async ({ services, identity }) => ok(await services.products.inventory(identity)))
  .route(routes.adminDeleteInventoryProduct, async ({ services, identity, input }) =>
    ok(await services.products.deleteInventoryProduct(identity, input.params.productId)),
  )
  .route(routes.vendorProductRegions, async ({ services, identity, input }) => ok(await services.products.productRegions(identity, input.params.vendorId)));
