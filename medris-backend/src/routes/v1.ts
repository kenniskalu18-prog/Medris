import { Router } from "express";
import helmet from "helmet";
import type { AppServices } from "../container.js";
import { authenticate, csrfProtection } from "../middleware/auth.js";
import { jsonBodyGuard } from "../middleware/json-body.js";
import { requestTimeout } from "../middleware/timeout.js";
import { authController } from "../modules/auth/auth.controller.js";
import { cartController } from "../modules/cart/cart.controller.js";
import { catalogueController } from "../modules/catalogue/catalogue.controller.js";
import { favoritesController } from "../modules/favorites/favorites.controller.js";
import { followsController } from "../modules/follows/follows.controller.js";
import { healthController } from "../modules/health/health.controller.js";
import { notificationsController } from "../modules/notifications/notifications.controller.js";
import { usersController } from "../modules/users/users.controller.js";
import { filesController } from "../modules/files/files.controller.js";
import { listingsController } from "../modules/listings/listings.controller.js";
import { requestsController } from "../modules/requests/requests.controller.js";
import { carouselController } from "../modules/carousel/carousel.controller.js";
import { supportController } from "../modules/support/support.controller.js";
import { adminDashboardController } from "../modules/admin-dashboard/admin-dashboard.controller.js";
import { blocksController } from "../modules/blocks/blocks.controller.js";
import { scheduledJobsController } from "../modules/scheduled-jobs/scheduled-jobs.controller.js";
import { commissionController } from "../modules/commission/commission.controller.js";
import { paymentClaimsController } from "../modules/payment-claims/payment-claims.controller.js";
import { checkoutController } from "../modules/checkout/checkout.controller.js";
import { orderActionsController } from "../modules/order-actions/order-actions.controller.js";
import { campusController } from "../modules/campus/campus.controller.js";
import { adminVendorsController } from "../modules/admin-vendors/admin-vendors.controller.js";
import { shopsController } from "../modules/shops/shops.controller.js";
import { serviceOffersController } from "../modules/service-offers/service-offers.controller.js";
import { pointsController } from "../modules/points/points.controller.js";
import { presenceController } from "../modules/presence/presence.controller.js";
import { callsController } from "../modules/calls/calls.controller.js";
import { conversationsController } from "../modules/conversations/conversations.controller.js";
import { productsController } from "../modules/products/products.controller.js";
import { adminUsersController } from "../modules/admin-users/admin-users.controller.js";
import { accountController } from "../modules/account/account.controller.js";
import { assistantController } from "../modules/assistant/assistant.controller.js";
import { suggestionsController } from "../modules/suggestions/suggestions.controller.js";
import { liveController } from "../modules/live/live.controller.js";
import { engagementController } from "../modules/engagement/engagement.controller.js";
import { AppError } from "../shared/errors/app-error.js";
import { v1ErrorResponse } from "../shared/errors/handler.js";
import type { RouteDefinition } from "../shared/http/route.js";

/** Every /api/v1 controller, in mounting order. Health comes first so probes never need a token. */
const publicControllers = [healthController, liveController];
const controllers = [authController, usersController, catalogueController, cartController, favoritesController, followsController, notificationsController, engagementController, suggestionsController, assistantController, accountController, adminUsersController, productsController, conversationsController, callsController, presenceController, pointsController, serviceOffersController, shopsController, adminVendorsController, campusController, orderActionsController, checkoutController, paymentClaimsController, commissionController, scheduledJobsController, blocksController, adminDashboardController, supportController, carouselController, requestsController, listingsController, filesController];

/** Route definitions of /api/v1 (paths relative to /api/v1), for the OpenAPI document. */
export const v1Definitions: RouteDefinition[] = [...publicControllers, ...controllers].flatMap((c) => c.definitions);

/** Security headers for API responses (no CSP: they are JSON, not pages). */
export const apiSecurityHeaders = helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false });

/**
 * /api/v1: the backend's own API (validated input, consistent JSON envelopes,
 * authorisation in code + RLS in the database). Mounted under /api/v1 by
 * createApp(); every route here is relative to that prefix.
 *
 * Each module is a controller (HTTP) -> service (rules) -> repository (SQL);
 * the route definitions double as the OpenAPI document (/api/v1/docs).
 *
 * Order: security headers and the request timeout apply to everything;
 * health checks come before authentication so a probe never needs a token.
 */
export function v1Router(services: AppServices): Router {
  const v1 = Router();
  v1.use(apiSecurityHeaders);
  v1.use(
    requestTimeout(services.config.requestTimeoutMs, (res) =>
      v1ErrorResponse(res.req, res, new AppError(504, "request_timeout", "The request took too long. Please try again."), res.locals.logger),
    ),
  );
  for (const c of publicControllers) v1.use(c.router);
  v1.use(authenticate);
  v1.use(csrfProtection);
  v1.use(jsonBodyGuard);
  for (const c of controllers) v1.use(c.router);
  return v1;
}
