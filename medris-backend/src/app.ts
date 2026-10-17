import express, { type ErrorRequestHandler, type Express, type Request } from "express";
import { corsMiddleware } from "./config/cors.js";
import { createServices, type AppServices } from "./container.js";
import { setDataContextProvider } from "./database/index.js";
import { publicErrorMessage } from "./lib/http.js";
import { requestContext } from "./middleware/request-context.js";
import { sharePreviewHandler } from "./modules/accounts/accounts.controller.js";
import { setAccessTokenVerifier } from "./modules/auth/caller.js";
import { apiDocs } from "./routes/docs.js";
import { legacyApi } from "./routes/legacy.js";
import { v1Router } from "./routes/v1.js";
import { v1ErrorResponse } from "./shared/errors/handler.js";

export interface CreateAppOptions {
  /** Replace any service (tests: a PGlite database, a fixed token verifier, a silent logger). */
  services?: Partial<AppServices>;
}

/** Whether a request is for /api/v1 (judged on the original URL, whatever router it is in). */
const isV1 = (req: Request) => {
  const path = req.originalUrl.split("?")[0] ?? "";
  return path === "/api/v1" || path.startsWith("/api/v1/");
};

/**
 * The Medris (Levromart) API, an Express application.
 *
 *   /api/v1/*   the backend's own API (see routes/v1.ts)
 *   /api/v1/docs, /api/v1/openapi.json   Swagger UI and the OpenAPI document (API_DOCS_ENABLED)
 *   /api/*      every original endpoint at its original path and shape
 *   /, /s/:id, /p/:id, /k/:id   link previews for shared storefronts/products/packages
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const services = createServices(options.services);
  if (options.services?.data) setDataContextProvider(options.services.data);
  // The original endpoints verify the body's accessToken with the same verifier as /api/v1.
  setAccessTokenVerifier(services.accessTokens);

  const app = express();
  app.disable("x-powered-by");
  // Responses carry user data and set their own Cache-Control; no automatic ETag/304 handling.
  app.set("etag", false);
  // Behind Vercel's proxy: req.protocol and the host come from X-Forwarded-*.
  app.set("trust proxy", true);

  app.use(requestContext(services));

  // Same origin in production: no CORS headers. CORS_ALLOWED_ORIGINS opts other origins in.
  const cors = corsMiddleware(services.config);
  if (cors) app.use("/api", cors);

  app.use(apiDocs(services));
  app.use("/api/v1", v1Router(services));
  app.use("/api", legacyApi());

  // Link previews. vercel.json rewrites "/?storefront=|product=|package=..." and the
  // short links /s/<id>, /p/<id>, /k/<id> to /api/delete-account (handled there).
  // These routes answer the same URLs when a request arrives without the rewrite
  // applied to its URL (local server, other hosts).
  app.get("/", (req, res) => sharePreviewHandler(req, res));
  app.get("/s/:id", (req, res) => sharePreviewHandler(req, res, { storefront: req.params.id }));
  app.get("/p/:id", (req, res) => sharePreviewHandler(req, res, { product: req.params.id }));
  app.get("/k/:id", (req, res) => sharePreviewHandler(req, res, { package: req.params.id }));

  app.use((req, res) => {
    if (isV1(req)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: { code: "not_found", message: "Not found." }, requestId: res.locals.requestId });
      return;
    }
    res.status(404).json({ error: "Not found" });
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (isV1(req)) return v1ErrorResponse(req, res, err, res.locals.logger);
    (res.locals.logger ?? services.logger).error("unhandled error", { err, path: req.originalUrl.split("?")[0] });
    if (!res.headersSent) res.status(500).json({ error: publicErrorMessage(err) || "Server error" });
  };
  app.use(onError);

  return app;
}
