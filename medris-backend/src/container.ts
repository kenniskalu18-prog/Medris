import { loadConfig, type AppConfig } from "./config/app-config.js";
import type { DataContext } from "./database/context.js";
import { getDataContext } from "./database/index.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { SupabaseAccessTokenVerifier, type AccessTokenVerifier } from "./modules/auth/access-token.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { createGoogleSignIn, type GoogleSignIn } from "./modules/auth/google-oidc.js";
import { createSessionService, type SessionService } from "./modules/auth/session.service.js";
import { CartService } from "./modules/cart/cart.service.js";
import { CatalogueService } from "./modules/catalogue/catalogue.service.js";
import { FavoritesService } from "./modules/favorites/favorites.service.js";
import { FollowsService } from "./modules/follows/follows.service.js";
import { HealthService } from "./modules/health/health.service.js";
import { NotificationsService } from "./modules/notifications/notifications.service.js";
import { UsersService } from "./modules/users/users.service.js";
import { FilesService } from "./modules/files/files.service.js";
import { LiveService } from "./modules/live/live.service.js";
import { ListingsService } from "./modules/listings/listings.service.js";
import { RequestsService } from "./modules/requests/requests.service.js";
import { CarouselService } from "./modules/carousel/carousel.service.js";
import { SupportService } from "./modules/support/support.service.js";
import { AdminDashboardService } from "./modules/admin-dashboard/admin-dashboard.service.js";
import { BlocksService } from "./modules/blocks/blocks.service.js";
import { ScheduledJobsService } from "./modules/scheduled-jobs/scheduled-jobs.service.js";
import { CommissionService } from "./modules/commission/commission.service.js";
import { PaymentClaimsService } from "./modules/payment-claims/payment-claims.service.js";
import { CheckoutService } from "./modules/checkout/checkout.service.js";
import { OrderActionsService } from "./modules/order-actions/order-actions.service.js";
import { CampusService } from "./modules/campus/campus.service.js";
import { AdminVendorsService } from "./modules/admin-vendors/admin-vendors.service.js";
import { ShopsService } from "./modules/shops/shops.service.js";
import { ServiceOffersService } from "./modules/service-offers/service-offers.service.js";
import { PointsService } from "./modules/points/points.service.js";
import { PresenceService } from "./modules/presence/presence.service.js";
import { CallsService } from "./modules/calls/calls.service.js";
import { ConversationsService } from "./modules/conversations/conversations.service.js";
import { ProductsService } from "./modules/products/products.service.js";
import { AdminUsersService } from "./modules/admin-users/admin-users.service.js";
import { AccountService } from "./modules/account/account.service.js";
import { AssistantService } from "./modules/assistant/assistant.service.js";
import { SuggestionsService } from "./modules/suggestions/suggestions.service.js";
import { EngagementService } from "./modules/engagement/engagement.service.js";

/**
 * The application's services, created once per process and handed to every
 * request (res.locals.services). Tests pass overrides - a PGlite-backed
 * DataContext, a fixed token verifier - instead of reaching for globals.
 *
 * Layers: controllers (HTTP) -> services (rules, which role a query runs as)
 * -> repositories (SQL). Feature services below are built from the
 * infrastructure above them, so an overridden `data` reaches all of them.
 */
export interface AppServices {
  config: AppConfig;
  logger: Logger;
  /** The database. Throws a 503 error when DATABASE_URL is not configured. */
  data(): DataContext;
  accessTokens: AccessTokenVerifier;
  sessions: SessionService;
  google: GoogleSignIn | null;
  rateLimiter: RateLimiter;

  // Feature services (/api/v1)
  health: HealthService;
  auth: AuthService;
  users: UsersService;
  catalogue: CatalogueService;
  cart: CartService;
  favorites: FavoritesService;
  follows: FollowsService;
  notifications: NotificationsService;
  files: FilesService;
  live: LiveService;
  listings: ListingsService;
  requests: RequestsService;
  carousel: CarouselService;
  support: SupportService;
  adminDashboard: AdminDashboardService;
  blocks: BlocksService;
  scheduledJobs: ScheduledJobsService;
  commission: CommissionService;
  paymentClaims: PaymentClaimsService;
  checkout: CheckoutService;
  orderActions: OrderActionsService;
  campus: CampusService;
  adminVendors: AdminVendorsService;
  shops: ShopsService;
  serviceOffers: ServiceOffersService;
  points: PointsService;
  presence: PresenceService;
  calls: CallsService;
  conversations: ConversationsService;
  products: ProductsService;
  adminUsers: AdminUsersService;
  account: AccountService;
  assistant: AssistantService;
  suggestions: SuggestionsService;
  engagement: EngagementService;
}

export function createServices(overrides: Partial<AppServices> = {}): AppServices {
  const config = overrides.config ?? loadConfig();
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, base: { service: "medris-backend" } });
  const data = overrides.data ?? (() => getDataContext(config));
  const accessTokens =
    overrides.accessTokens ??
    new SupabaseAccessTokenVerifier({
      supabaseUrl: config.supabase.url,
      anonKey: config.supabase.anonKey,
      jwtSecret: config.supabase.jwtSecret,
      issuer: config.supabase.jwtIssuer,
      audience: config.supabase.jwtAudience,
    });
  const sessions = overrides.sessions ?? createSessionService(config, data);
  const google = overrides.google !== undefined ? overrides.google : createGoogleSignIn(config);
  const rateLimiter = overrides.rateLimiter ?? new RateLimiter();

  return {
    config,
    logger,
    data,
    accessTokens,
    sessions,
    google,
    rateLimiter,
    health: overrides.health ?? new HealthService(config, data),
    auth: overrides.auth ?? new AuthService({ config, data, sessions, google, rateLimiter }),
    users: overrides.users ?? new UsersService(data),
    catalogue: overrides.catalogue ?? new CatalogueService(data),
    cart: overrides.cart ?? new CartService(data),
    favorites: overrides.favorites ?? new FavoritesService(data),
    follows: overrides.follows ?? new FollowsService(data),
    notifications: overrides.notifications ?? new NotificationsService(data),
    files: overrides.files ?? new FilesService(data),
    live: overrides.live ?? new LiveService(data, (token) => accessTokens.verify(token)),
    listings: overrides.listings ?? new ListingsService(data),
    requests: overrides.requests ?? new RequestsService(data),
    carousel: overrides.carousel ?? new CarouselService(data),
    support: overrides.support ?? new SupportService(data),
    adminDashboard: overrides.adminDashboard ?? new AdminDashboardService(data),
    blocks: overrides.blocks ?? new BlocksService(data),
    scheduledJobs: overrides.scheduledJobs ?? new ScheduledJobsService(data),
    commission: overrides.commission ?? new CommissionService(data),
    paymentClaims: overrides.paymentClaims ?? new PaymentClaimsService(data),
    checkout: overrides.checkout ?? new CheckoutService(data),
    orderActions: overrides.orderActions ?? new OrderActionsService(data),
    campus: overrides.campus ?? new CampusService(data),
    adminVendors: overrides.adminVendors ?? new AdminVendorsService(data),
    shops: overrides.shops ?? new ShopsService(data),
    serviceOffers: overrides.serviceOffers ?? new ServiceOffersService(data),
    points: overrides.points ?? new PointsService(data),
    presence: overrides.presence ?? new PresenceService(data),
    calls: overrides.calls ?? new CallsService(data),
    conversations: overrides.conversations ?? new ConversationsService(data),
    products: overrides.products ?? new ProductsService(data),
    adminUsers: overrides.adminUsers ?? new AdminUsersService(data),
    account: overrides.account ?? new AccountService(data),
    assistant: overrides.assistant ?? new AssistantService(data),
    suggestions: overrides.suggestions ?? new SuggestionsService(data),
    engagement: overrides.engagement ?? new EngagementService(data),
  };
}
