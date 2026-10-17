import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./admin-vendors.routes.js";

/** Admin vendor tools - see admin-vendors.routes.ts for the contract. */
export const adminVendorsController = controller()
  .route(routes.locked, async ({ services, identity }) => ok(await services.adminVendors.locked(identity)))
  .route(routes.payouts, async ({ services, identity }) => ok(await services.adminVendors.payouts(identity)))
  .route(routes.transactions, async ({ services, identity }) => ok(await services.adminVendors.transactions(identity)))
  .route(routes.setStatus, async ({ services, identity, input }) => ok(await services.adminVendors.setStatus(identity, input.params.vendorId, input.body.status)))
  .route(routes.reject, async ({ services, identity, input }) => ok(await services.adminVendors.reject(identity, input.params.vendorId, input.body.reason)))
  .route(routes.setStorefront, async ({ services, identity, input }) => ok(await services.adminVendors.setStorefront(identity, input.params.vendorId, input.body.active)))
  .route(routes.forceUnlock, async ({ services, identity, input }) => ok(await services.adminVendors.forceUnlock(identity, input.params.vendorId)))
  .route(routes.recycle, async ({ services, identity, input }) => ok(await services.adminVendors.delete(identity, input.params.vendorId)))
  .route(routes.restore, async ({ services, identity, input }) => ok(await services.adminVendors.restore(identity, input.params.vendorId)))
  .route(routes.erase, async ({ services, identity, input }) => ok(await services.adminVendors.deletePermanently(identity, input.params.vendorId)))
  .route(routes.reviewStudent, async ({ services, identity, input }) =>
    ok(await services.adminVendors.reviewStudent(identity, input.params.vendorId, input.body.status, input.body.note ?? null)),
  );
