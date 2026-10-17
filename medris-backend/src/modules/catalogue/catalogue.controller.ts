import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./catalogue.routes.js";

/** /api/v1/catalogue - see catalogue.routes.ts for the contract. */
export const catalogueController = controller()
  .route(routes.listSectors, async ({ services, identity, input }) => ok(await services.catalogue.sectors(identity, input.query.order)))
  .route(routes.listCategories, async ({ services, identity, input }) => ok(await services.catalogue.categories(identity, input.query.sectorId)))
  .route(routes.searchProducts, async ({ services, identity, input }) => ok(await services.catalogue.search(identity, input.query.q, input.query.limit)))
  .route(routes.searchProductIds, async ({ services, identity, input }) => ok(await services.catalogue.searchIds(identity, input.query.q)))
  .route(routes.createSector, async ({ services, identity, input }) => ok(await services.catalogue.createSector(identity, input.body.name)))
  .route(routes.createCustomSector, async ({ services, identity, input }) => ok(await services.catalogue.customSector(identity, input.body.name)))
  .route(routes.createCategory, async ({ services, identity, input }) => ok(await services.catalogue.createCategory(identity, input.body)))
  .route(routes.servicePriceHint, async ({ services, input }) => ok(await services.catalogue.servicePriceHint(input.params.listingId)));
