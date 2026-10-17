import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { AppServices } from "../container.js";
import { sessionCookieName } from "../modules/auth/session-cookie.js";
import type { RouteDefinition } from "../shared/http/route.js";
import { registerSecuritySchemes } from "../shared/openapi/security.js";
import { legacyDefinitions } from "./legacy.js";
import { v1Definitions } from "./v1.js";

export const OPENAPI_PATH = "/api/v1/openapi.json";
export const DOCS_PATH = "/api/v1/docs";
/** Common guesses for where the docs live; they redirect to DOCS_PATH. */
export const DOCS_ALIASES = ["/docs", "/api-docs", "/swagger", "/api/docs"];

const TAGS = [
  { name: "Health", description: "Probes for load balancers and deploy checks." },
  { name: "Auth", description: "Who is calling; backend sign-in (off until AUTH_BACKEND_SESSIONS=true)." },
  { name: "Account", description: "The signed-in user." },
  { name: "Catalogue", description: "Public reference data." },
  { name: "Cart", description: "The signed-in buyer's cart." },
  { name: "Favorites", description: "Saved products and packages." },
  { name: "Follows", description: "Followed shops." },
  { name: "Notifications", description: "In-app notifications." },
  { name: "Engagement", description: "Counts, ratings and statistics shown on listings and shops." },
  { name: "Suggestions", description: "The suggestion box (to a shop or to Levromart)." },
  { name: "Assistant", description: "Levi's saved conversations: search, sharing, reactions." },
  { name: "Admin: accounts", description: "Appeals, suspensions, admin roles and password resets (admins)." },
  { name: "Products", description: "Product varieties, the admin inventory and where a shop's products sell." },
  { name: "Conversations", description: "Buyer-shop chat: conversations, editing messages, reactions, pins, chat lists, admin views." },
  { name: "Calls", description: "In-app voice calls: starting, ringing, answering, ending." },
  { name: "Presence", description: "Online now and last seen." },
  { name: "Points", description: "Vendor points, the leaderboard, Vendor of the Week and referral codes." },
  { name: "Service offers", description: "Negotiated service bookings: proposing, countering, accepting, reporting and confirming payment." },
  { name: "Shops", description: "A vendor's own shop: applying, the storefront switch, billing model, student checks." },
  { name: "Admin: vendors", description: "Approving, rejecting, pausing, recycling and restoring shops; payouts and transactions." },
  { name: "Campus", description: "Schools for campus listings." },
  { name: "Order actions", description: "After checkout: status changes, confirmation, notes, edits, quantity suggestions." },
  { name: "Checkout", description: "Placing orders: one product, a rental, a cart, a package." },
  { name: "Payment claims", description: "Direct bank-transfer payments: reporting, confirming, disputing; disputes about orders." },
  { name: "Commission & billing", description: "Commission owed, deadlines and reminders; ₦1,000 monthly listings." },
  { name: "Scheduled jobs", description: "The database's scheduled jobs (pg_cron), for the backend's scheduler after the switch." },
  { name: "Blocks", description: "Blocking people in chat." },
  { name: "Admin dashboard", description: "The admin dashboard's counts and logs." },
  { name: "Support", description: "Support requests." },
  { name: "Carousel", description: "The home page's banners." },
  { name: "Requests", description: "Buyers' requests and shops' offers." },
  { name: "Listings", description: "Marketplace listings and the shop owner's editing." },
  { name: "Files", description: "Private files in Supabase Storage, brokered by the backend." },
  { name: "Live updates", description: "The WebSocket that replaces Supabase Realtime (row changes, typing, presence, call signalling)." },
  { name: "Original endpoints", description: "Endpoints from before /api/v1, kept byte-compatible for the app." },
];

function register(registry: OpenAPIRegistry, prefix: string, definitions: RouteDefinition[]): void {
  for (const { middleware: _middleware, ...route } of definitions) registry.registerPath({ ...route, path: `${prefix}${route.path}` });
}

/** The OpenAPI 3.1 document, generated from every controller's route definitions (so it cannot drift from the code). */
export function buildOpenApiDocument(services: AppServices) {
  const registry = new OpenAPIRegistry();
  registerSecuritySchemes(registry, sessionCookieName(services.config));
  register(registry, "/api/v1", v1Definitions);
  register(registry, "/api", legacyDefinitions);
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Medris API", version: "1.0.0" },
    servers: [{ url: "/", description: "This deployment" }],
    tags: TAGS,
  });
}

/**
 * Swagger UI at /api/v1/docs/ and the OpenAPI document at /api/v1/openapi.json.
 * Off in production unless API_DOCS_ENABLED=true. Swagger UI's files are served
 * from the swagger-ui-dist package (no CDN).
 */
export function apiDocs(services: AppServices): Router {
  const router = Router();
  if (!services.config.docs.enabled) return router;

  let document: ReturnType<typeof buildOpenApiDocument> | undefined;
  router.use([OPENAPI_PATH, DOCS_PATH], helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }));
  router.get(OPENAPI_PATH, (_req, res) => {
    document ??= buildOpenApiDocument(services);
    res.setHeader("Cache-Control", "no-store");
    res.json(document);
  });
  const ui = { customSiteTitle: "Medris API", swaggerOptions: { url: OPENAPI_PATH, persistAuthorization: false } };
  router.use(DOCS_PATH, swaggerUi.serveFiles(undefined, ui), swaggerUi.setup(undefined, ui));
  for (const alias of DOCS_ALIASES) router.get(alias, (_req, res) => res.redirect(302, `${DOCS_PATH}/`));
  return router;
}
