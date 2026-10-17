import type { StudentVerificationInput } from "../../database/repositories/shop-records.repository.js";
import type { ShopChanges } from "../../database/repositories/shop-rows.repository.js";
import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./shops.routes.js";

/** A vendor's own shop - see shops.routes.ts for the contract. */
export const shopsController = controller()
  .route(routes.submitApplication, async ({ services, identity, input }) => created(await services.shops.apply(identity, input.body)))
  .route(routes.setStorefront, async ({ services, identity, input }) => ok(await services.shops.setStorefront(identity, input.body.active)))
  .route(routes.setBillingModel, async ({ services, identity, input }) => ok(await services.shops.setBillingModel(identity, input.body.billingModel)))
  .route(routes.submitFaceCheck, async ({ services, identity, input }) => ok(await services.shops.submitFaceCheck(identity, input.body)))
  .route(routes.myShop, async ({ services, user }) => ok(await services.shops.mine(user())))
  .route(routes.updateMyShop, async ({ services, user, input }) => ok(await services.shops.updateMine(user(), input.body as ShopChanges)))
  .route(routes.setPayout, async ({ services, user, input }) => ok(await services.shops.setPayout(user(), input.body)))
  .route(routes.removeApplication, async ({ services, user, input }) => ok(await services.shops.removeApplication(user(), input.params.vendorId)))
  .route(routes.listShops, async ({ services, identity, input }) =>
    ok(
      await services.shops.shops(identity, {
        ids: input.query.ids ?? null,
        sectorId: input.query.sectorId ?? null,
        q: input.query.q ?? null,
        studentVerified: input.query.studentVerified,
        anyStatus: input.query.anyStatus,
        orderBy: input.query.orderBy,
        limit: input.query.limit,
        offset: input.query.offset,
      }),
    ),
  )
  .route(routes.getShop, async ({ services, identity, input }) => ok(await services.shops.shop(identity, input.params.vendorId, input.query)))
  .route(routes.adminShops, async ({ services, user, input }) => ok(await services.shops.adminShops(user(), input.query.deleted, input.query.status ?? null)))
  .route(routes.variants, async ({ services, identity, input }) => ok(await services.shops.variants(identity, input.query.productIds)))
  .route(routes.studentVerification, async ({ services, user, input }) => ok(await services.shops.studentVerification(user(), input.params.vendorId)))
  .route(routes.studentVerificationStatuses, async ({ services, user }) => ok(await services.shops.studentVerificationStatuses(user())))
  .route(routes.submitStudentVerification, async ({ services, user, input }) => ok(await services.shops.submitStudentVerification(user(), input.body as StudentVerificationInput)))
  .route(routes.recordStudentOcr, async ({ services, user, input }) => ok(await services.shops.recordStudentOcr(user(), input.body)))
  .route(routes.mySubmissions, async ({ services, user, input }) => ok(await services.shops.mySubmissions(user(), input.query.kind ?? null)))
  .route(routes.pendingSubmissions, async ({ services, user }) => ok(await services.shops.pendingSubmissions(user())))
  .route(routes.pendingSubmission, async ({ services, user, input }) => ok(await services.shops.pendingSubmission(user(), input.params.kind, input.params.listingId)))
  .route(routes.latestSubmissions, async ({ services, user }) => ok(await services.shops.latestSubmissions(user())));
