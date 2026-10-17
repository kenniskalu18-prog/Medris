import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./favorites.routes.js";

/** /api/v1/favorites - see favorites.routes.ts for the contract. */
export const favoritesController = controller()
  .route(routes.listFavorites, async ({ services, user }) => ok(await services.favorites.list(user())))
  .route(routes.saveProduct, async ({ services, user, input }) => ok(await services.favorites.save(user(), "product", input.params.id)))
  .route(routes.unsaveProduct, async ({ services, user, input }) => ok(await services.favorites.unsave(user(), "product", input.params.id)))
  .route(routes.savePackage, async ({ services, user, input }) => ok(await services.favorites.save(user(), "package", input.params.id)))
  .route(routes.unsavePackage, async ({ services, user, input }) => ok(await services.favorites.unsave(user(), "package", input.params.id)))
  .route(routes.savedProducts, async ({ services, user }) => ok(await services.favorites.savedProducts(user())))
  .route(routes.savedPackages, async ({ services, user }) => ok(await services.favorites.savedPackages(user())));
