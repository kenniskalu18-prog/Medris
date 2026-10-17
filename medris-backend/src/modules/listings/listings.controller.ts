import { controller, created, ok } from "../../shared/http/route.js";
import type { ListingFields } from "../../database/repositories/listings.repository.js";
import type { PackageFields } from "../../database/repositories/packages.repository.js";
import * as routes from "./listings.routes.js";

/** Listings - see listings.routes.ts for the contract. */
export const listingsController = controller()
  .route(routes.feed, async ({ services, identity, input }) =>
    ok(
      await services.listings.feed(identity, {
        ids: input.query.ids ?? null,
        vendorId: input.query.vendorId ?? null,
        categoryIds: input.query.categoryIds ?? null,
        sectorId: input.query.sectorId ?? null,
        isService: input.query.isService ?? null,
        listingTypes: input.query.listingTypes ?? null,
        q: input.query.q ?? null,
        qAny: input.query.qAny ?? null,
        inStock: input.query.inStock,
        orderBy: input.query.orderBy,
        view: input.query.view,
        withVariants: input.query.withVariants,
        limit: input.query.limit,
        offset: input.query.offset,
      }),
    ),
  )
  .route(routes.myListings, async ({ services, user, input }) =>
    ok(await services.listings.myListings(user(), { includeRemoved: input.query.includeRemoved, activeOnly: input.query.activeOnly, q: input.query.q ?? null })),
  )
  .route(routes.byReference, async ({ services, user, input }) => ok(await services.listings.byReference(user(), input.params.reference)))
  .route(routes.myListing, async ({ services, user, input }) => ok(await services.listings.myListing(user(), input.params.productId)))
  .route(routes.create, async ({ services, user, input }) =>
    created(await services.listings.create(user(), input.body.fields as ListingFields, input.body.billingModel, input.body.reference ?? null)),
  )
  .route(routes.update, async ({ services, user, input }) => ok(await services.listings.update(user(), input.params.productId, input.body as ListingFields)))
  .route(routes.setStatus, async ({ services, user, input }) => ok(await services.listings.setStatus(user(), input.params.productId, input.body.status, input.body.cancelBilling)))
  .route(routes.clearReference, async ({ services, user, input }) => ok(await services.listings.clearReference(user(), input.params.productId)))
  .route(routes.remove, async ({ services, user, input }) => ok(await services.listings.remove(user(), input.params.productId)))
  .route(routes.packageFeed, async ({ services, identity, input }) =>
    ok(
      await services.listings.packageFeed(identity, {
        ids: input.query.ids ?? null,
        vendorId: input.query.vendorId ?? null,
        qAny: input.query.qAny ?? null,
        qItems: input.query.qItems ?? null,
        orderBy: input.query.orderBy,
        view: input.query.view,
        limit: input.query.limit,
      }),
    ),
  )
  .route(routes.packageDetail, async ({ services, identity, input }) => ok(await services.listings.packageDetail(identity, input.params.packageId)))
  .route(routes.myPackages, async ({ services, user }) => ok(await services.listings.myPackages(user())))
  .route(routes.createPackage, async ({ services, user, input }) =>
    created(await services.listings.createPackage(user(), input.body.fields as PackageFields, input.body.items, input.body.billingModel)),
  )
  .route(routes.updatePackage, async ({ services, user, input }) =>
    ok(await services.listings.updatePackage(user(), input.params.packageId, input.body.fields as PackageFields, input.body.items ?? null)),
  )
  .route(routes.setPackageStatus, async ({ services, user, input }) => ok(await services.listings.setPackageStatus(user(), input.params.packageId, input.body.status)))
  .route(routes.removePackage, async ({ services, user, input }) => ok(await services.listings.removePackage(user(), input.params.packageId)))
  .route(routes.detail, async ({ services, identity, input }) => ok(await services.listings.detail(identity, input.params.productId)));
