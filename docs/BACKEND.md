# Backend (medris-backend)

Node.js + TypeScript + [Express 5](https://expressjs.com), a plain Node server (`npm start`). **Not deployed yet:** production
still runs the original `api/*.js` functions on Vercel (see `docs/DEPLOYMENT.md`); `src/vercel.ts` is kept for a
possible Vercel deployment but nothing uses it today. It owns the API, request validation, authorisation, every database read and write it makes, and the
integrations with Paystack, Resend, Web Push, Gemini, Cloudflare R2 and Supabase Auth/Storage.

**API reference:** run the backend (`npm run dev:backend`) and open **http://localhost:8787/api/v1/docs** (Swagger UI) or
`/api/v1/openapi.json` (OpenAPI 3.1). Both are generated from the code (section 3).

Related: [DATABASE.md](DATABASE.md) (connection, migrations, portability) · [AUTH.md](AUTH.md) ·
[STORAGE.md](STORAGE.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [SUPABASE_AUDIT.md](SUPABASE_AUDIT.md).

## 1. Principles

- **Three layers.** Controllers handle HTTP only, services hold the rules, repositories hold every query
  (section 3). A lint rule enforces it.
- **One way to the database.** All SQL goes through `src/database/` (Drizzle on node-postgres). The backend makes no
  Supabase REST (PostgREST) calls any more.
- **Same security model, enforced twice.** Every request runs in a transaction that carries the caller's identity
  exactly as Supabase's REST API did (role `authenticated`/`anon`, `request.jwt.claims`), so all 149 row-level
  security policies and the `SECURITY DEFINER` functions keep deciding access. On top of that the API checks
  ownership in code (every cart statement filters by `buyer_id`, roles are checked before admin actions).
- **Business rules stay where they are.** Order, payment, commission and points rules are PostgreSQL functions; the
  backend calls them (`database/rpc.ts`) instead of re-implementing them.
- **Nothing breaks on deploy.** The original endpoints keep their URLs, request bodies, status codes and response
  shapes. New functionality lives under `/api/v1` and is switched on per feature from the frontend.

## 2. Layout

```text
medris-backend/
├── src/
│   ├── app.ts                  createApp(): middleware, /api/v1, original /api routes, link previews, error handling
│   ├── server.ts               long-running server: config validation, structured logs, graceful shutdown
│   ├── vercel.ts               Vercel handler (+ restores /api/v1 paths rewritten by vercel.json)
│   ├── container.ts            AppServices: config, logger, data(), token verifier, sessions, Google, rate limiter,
│   │                           and one service per /api/v1 feature (res.locals.services.cart, ...)
│   ├── config/
│   │   ├── app-config.ts       Zod-validated configuration (loadConfig); production-required variables
│   │   ├── env.ts              requireEnv/optionalEnv used by the original endpoint modules
│   │   ├── database.ts         node-postgres pool settings (TLS mode, pool size, timeouts)
│   │   ├── cors.ts             CORS policy (off unless CORS_ALLOWED_ORIGINS is set)
│   │   └── static-files.ts     where link previews/share cards read the built app
│   ├── database/
│   │   ├── client.ts           pg Pool + Drizzle; driver-independent Db type
│   │   ├── context.ts          DataContext: asUser / asAnon / asService / asAuthReader
│   │   ├── index.ts            process-wide DataContext (lazy; DATABASE_URL)
│   │   ├── rpc.ts              callFunction(): database functions called like PostgREST's rpc()
│   │   ├── json.ts             jsonRows(): rows serialised by PostgreSQL (same JSON as PostgREST)
│   │   ├── errors.ts           SQLSTATE -> API error mapping
│   │   ├── schema/             Drizzle table definitions (only columns the code uses)
│   │   ├── repositories/       one class per area; all SQL lives here
│   │   ├── migrations/         every database change, NNNN_name.sql, applied by scripts/migrate.ts (DATABASE.md §3)
│   │   └── portability/        supabase-compat.sql: auth.uid() + API roles for non-Supabase PostgreSQL
│   ├── middleware/             request-context (request id, access log), auth (bearer/cookie, roles, CSRF),
│   │                           rate-limit, cron-auth (shared secrets, constant-time)
│   ├── modules/                one folder per feature (section 3):
│   │                             <m>.controller.ts  HTTP only     <m>.routes.ts   the contract (OpenAPI)
│   │                             <m>.service.ts     the rules     <m>.schemas.ts  Zod request/response schemas
│   │   ├── auth/               token verification, sessions, password check, Google OIDC, account linking
│   │   ├── users/              GET /api/v1/me
│   │   ├── catalogue/  cart/  favorites/  follows/  notifications/  health/     (/api/v1)
│   │   └── accounts/  auth-otp/  cron/  levi/  notify/  orders/  payments/  share-images/  vendor-payments/
│   │                           (the original endpoints)
│   ├── integrations/           paystack, email (Resend), web-push, gemini, r2, supabase-auth (admin API),
│   │                           storage/ (R2, Supabase Storage, Cloudinary adapters behind one interface)
│   ├── routes/                 v1.ts (the /api/v1 router), legacy.ts (the original endpoints), docs.ts (Swagger UI)
│   ├── shared/                 http/ (controller + route definitions on Express, body reader, cookies),
│   │                           openapi/ (Zod with .openapi(), response/error schemas, security schemes, docs for
│   │                           original endpoints), errors/ (AppError + handler), validation/, legacy.ts, types/
│   ├── contracts/              api.ts + v1.ts: request/response types shared with the frontend (type-only)
│   ├── lib/                    logger (JSON + redaction), rate-limit store, http helpers, format helpers
│   └── types/                  ambient module declarations
├── tests/                      Vitest: v1/ (incl. openapi, services, contracts), legacy/, support/, fixtures/
├── scripts/dev-database.ts     loads a development schema into a LOCAL database (refuses remote hosts)
├── scripts/migrate.ts          db:status / db:migrate / db:migration:new / db:migrations:check (migrations.ts: the runner)
├── drizzle.config.ts           drizzle-kit, used read-only for introspection
└── .env.example
```

## 3. Layers: controller → service → repository

Every feature module has the same four files. Reading one top to bottom tells you the whole story of an endpoint.

| File | Job | May use | May not |
|---|---|---|---|
| `cart.schemas.ts` | Zod schemas of bodies, queries, params and responses (with OpenAPI names/examples) | `z` from `shared/openapi/zod.ts` | anything else |
| `cart.routes.ts` | one `defineRoute()` per endpoint: method, path, middleware (`requireUser`, rate limit), schemas, documented responses and security | schemas, middleware | handlers |
| `cart.controller.ts` | binds each route to a one-line handler: read validated input, call the service, return `ok()`/`created()` | `input` (validated params/query/body), `services`, `user()`, `res` for cookies | repositories, `database/*`, Drizzle (lint error) |
| `cart.service.ts` | the rules: which role a query runs as (`asUser`/`asService`), ownership, not-found and conflict errors, defaults | repositories, `DataContext`, integrations | Drizzle, `sql`, `callFunction` (lint error) |
| `database/repositories/cart.repository.ts` | the SQL: Drizzle builder, `sql` templates, database functions (`callFunction`) | everything in `src/database` | HTTP |

```ts
// cart.routes.ts - the contract
export const setCartQuantity = defineRoute({
  method: "patch", path: "/cart/items/{id}", tags: ["Cart"], security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: IdParams, body: jsonBody(SetQuantityBody) },
  responses: { 200: dataResponse(SetQuantityResult, "Updated."), ...writeErrors, ...errorResponses(404) },
});

// cart.controller.ts - HTTP only (an Express router underneath)
.route(routes.setCartQuantity, async ({ services, user, input }) =>
  ok(await services.cart.setQuantity(user(), input.params.id, input.body.quantity)))

// cart.service.ts - the rule
async setQuantity(me, itemId, quantity) {
  const updated = await this.db().asUser(me, (tx) => new CartRepository(tx).setQuantity(me.userId, itemId, quantity));
  if (!updated) throw notFound("That item is no longer in your cart.");
  return { id: itemId, quantity };
}
```

- **Validation** happens before the handler: input that fails a schema becomes 400 `validation_failed` with
  `[{ path, message }]` (shared/http/route.ts: `controller().route(definition, handler)` mounts the definition on an
  Express `Router`, runs its middleware, validates, calls the handler and sends its reply). JSON bodies must be `application/json` (415 otherwise), at
  most 64 KB; an empty body counts as `{}` so missing fields are named (middleware/json-body.ts).
- **Services are plain classes** built once in `container.ts` from `data()`, so tests can call them directly against
  the test database (`tests/v1/services.test.ts`) or replace one (`createApp({ services: { cart: fake } })`).
- **Types stay in step**: `input` is typed from the route's schemas, handlers must reply with what the route's success
  response schema says (TypeScript checks it), and
  `tests/v1/contracts.test.ts` fails type-checking if `contracts/v1.ts` (used by the frontend) drifts from the schemas.
- **Lint**: `eslint.config.mjs` forbids Drizzle, `database/rpc|json|client|schema` outside `src/database`, and
  repositories/`database/index` in controllers and routers.

**Original endpoints** (`/api/notify`, `/api/chat`, ...) follow the same split - `*.controller.ts` (method check,
read body, call service, `respond()`), `*.service.ts`, repositories - but keep their hand-written request handling so
their responses stay byte-compatible. Their `*.routes.ts` describe them for the API docs only (registered with
the OpenAPI registry, never validating). Their controllers are plain Express `Router`s.

### API documentation (Swagger)

| URL | What |
|---|---|
| `/api/v1/docs` | Swagger UI: every endpoint, schemas, examples, *Try it out* |
| `/api/v1/openapi.json` | the OpenAPI 3.1 document (import into Postman/Insomnia, generate clients) |
| `/docs`, `/api-docs`, `/swagger`, `/api/docs` | redirect to `/api/v1/docs` |

Generated from the route definitions on first request, so it cannot drift from the code
(`tests/v1/openapi.test.ts` checks every served /api/v1 route is documented). **Authorize** offers `bearerAuth`
(paste a Supabase access token: in the app's browser console,
`(await supabase.auth.getSession()).data.session.access_token`), `sessionCookie`, `cronSecret`, `webhookSecret`,
`paystackSignature`. On by default except with `NODE_ENV=production`; set `API_DOCS_ENABLED=true|false` to override.
`npm run dev` always runs with `NODE_ENV=development` (even without a `.env`) and prints the links when it starts:

```text
  Medris backend   http://localhost:8787   (NODE_ENV=development)
  Config file      C:\Projects\Medris\medris-backend\.env loaded
  Swagger UI       http://localhost:8787/api/v1/docs
  OpenAPI JSON     http://localhost:8787/api/v1/openapi.json
  Health           http://localhost:8787/api/v1/health/ready
  Database         connected to aws-0-eu-west-1.pooler.supabase.com:6543 (85 ms, API roles ok)
```

The Database line is a real connection check at start-up; on failure it shows the driver's reason (wrong password,
unknown host, refused connection) without the password.

Without `NODE_ENV` the configuration assumes production (the safe default for a deployment), so `npm start` /
`node dist/server.js` keep the docs off unless `NODE_ENV=development` or `API_DOCS_ENABLED=true` is set.
Swagger UI's files come from the `swagger-ui-dist` package (swagger-ui-express), so the page works offline; `/api/v1/docs`
redirects to `/api/v1/docs/` so its relative asset paths resolve.

## 4. Request lifecycle

```text
request ─► requestContext   request id (X-Request-Id), request-scoped logger, one JSON access-log line
        ─► CORS             only when CORS_ALLOWED_ORIGINS lists the origin
        ─► docs     /api/v1/docs, /api/v1/openapi.json (when API_DOCS_ENABLED)
        ─► /api/v1 ─► helmet (security headers) ─► timeout (REQUEST_TIMEOUT_MS → 504)
        │            ─► health routes (no auth)
        │            ─► authenticate   Bearer Supabase token (verified locally) or backend session cookie
        │            ─► csrfProtection cookie-authenticated writes must come from a trusted origin
        │            ─► jsonBodyGuard  size limit, JSON parse, Content-Type
        │            ─► route middleware: requireUser / requireRole, rate limit
        │            ─► route validators (Zod: params, query, body)  → 400 validation_failed
        │            ─► controller ─► service ─► repository inside DataContext.asUser(identity) → PostgreSQL (RLS)
        │            ─► { data } or { error: { code, message, details? }, requestId }
        └► /api/*   original controllers → services → repositories (same contract as before)
errors  ─► one Express error handler: /api/v1 envelope, or { error: "message" } for the original endpoints
```

Express settings: `x-powered-by` off, automatic ETags off (responses set their own `Cache-Control`), `trust proxy`
on (Vercel's `X-Forwarded-*` give the real scheme and host for the CSRF origin check). Request bodies are read with
`shared/http/body.ts` (no body-parser): the original endpoints get the raw text (the Paystack signature is computed
over it), /api/v1 parses JSON in `jsonBodyGuard`. Express 5 passes errors thrown in async handlers and middleware to
the error handler, so handlers simply `throw` AppErrors.

## 5. Data access

**Tool: [Drizzle ORM](https://orm.drizzle.team) on node-postgres** (tests: the same code on PGlite).

Why Drizzle and not Prisma or a plain query builder:

| Need in this codebase | Drizzle | Prisma |
|---|---|---|
| Run *inside* a transaction that first sets `role` and `request.jwt.claims` (RLS) | `db.transaction(tx => …)` + `sql` in the same transaction | possible with interactive transactions + `$executeRaw`, but the client is built around its own query engine and connection handling |
| An existing schema of 71 tables, 311 functions and 149 policies that must not be re-modelled or migrated | describe only the columns you use; `drizzle-kit pull` can introspect | the schema file must describe every table it touches; `migrate` workflows want to own the schema |
| Call plpgsql functions and build PostgREST-shaped JSON (`json_build_object`, `to_json`) | first-class `sql` template, fully parameterised | raw SQL escape hatch |
| Vercel serverless, Supabase transaction pooler | thin, no engine binary, unnamed prepared statements | extra engine/adapter, larger cold start |
| Same repositories against an in-process test database | node-postgres and PGlite drivers share one API | no PGlite driver |

`src/database/context.ts` is the heart of it:

```ts
await data.asUser(identity, (tx) => new CartRepository(tx).listForBuyer(identity.userId)); // RLS as the user
await data.asAnon((tx) => new CatalogueRepository(tx).listSectors("sort_order"));         // signed-out visitor
await data.asService((tx) => new OrdersRepository(tx).dueForReminders(a, b));             // jobs/webhooks only
```

Each call is one transaction that starts with

```sql
select set_config('role', 'authenticated', true),
       set_config('request.jwt.claims', '<verified JWT claims>', true),
       set_config('request.jwt.claim.sub', '<user id>', true), …
```

All settings are transaction-local, so pooled connections never leak an identity (tested).

Rules for repositories: parameterised SQL only (Drizzle builder or the `sql` template - never string concatenation);
data returned to the browser is serialised by PostgreSQL (`jsonRows`) so timestamps and numbers look exactly as they
did through Supabase; ids from requests are validated before they reach SQL.

## 6. Endpoints

### `/api/v1` (new)

Full, current reference with schemas: `/api/v1/docs`. Responses: `{ "data": … }`; errors `{ "error": { "code", "message", "details"? }, "requestId" }`.
Authentication: `Authorization: Bearer <Supabase access token>` (or the backend session cookie when enabled).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health/live` | - | process is up |
| GET | `/health/ready` | - | database reachable, API roles usable (503 otherwise) |
| GET | `/auth/session` | optional | who the backend thinks you are |
| POST | `/auth/login` | - | password sign-in → session cookie *(only with AUTH_BACKEND_SESSIONS)* |
| POST | `/auth/logout`, `/auth/logout-all` | session | revoke this / every session *(sessions only)* |
| GET | `/auth/google/start`, `/auth/google/callback` | - | Google sign-in through the backend *(sessions only)* |
| GET | `/me` | user | profile (`public.users`) |
| GET | `/catalogue/sectors?order=sort_order\|name` | optional | every sector, all columns |
| GET | `/catalogue/categories?sectorId=` | optional | categories, by name |
| GET | `/cart` | user | items with variant, product and vendor (the cart page's shape) |
| GET | `/cart/count` | user | badge count |
| POST | `/cart/items` | user | `{ productId, quantity?, variantId? }` → `add_to_cart()` |
| PATCH | `/cart/items/:id` | user | `{ quantity }` |
| DELETE | `/cart/items/:id` · POST `/cart/items/delete` `{ ids }` · DELETE `/cart` | user | remove one / many / all |
| GET | `/favorites` | user | `{ productIds, packageIds }` |
| PUT/DELETE | `/favorites/products/:id`, `/favorites/packages/:id` | user | save / unsave (idempotent) |
| GET | `/follows` · `/follows/:vendorId` | user | followed shops + count · state |
| PUT | `/follows/:vendorId` | user | `{ following }` → `toggle_vendor_follow()` |
| DELETE | `/follows/:vendorId` | user | unfollow |
| GET | `/notifications?readSince=&limit=` | user | panel list (unread + recent read) |
| GET | `/notifications/unread-count?type=&after=` · `/notifications/recent-unread?limit=` | user | badges |
| POST | `/notifications/read` | user | `{ ids, read? }` or `{ all: true }` |

### Original endpoints (unchanged contracts)

`/api/delete-account` (+ `/api/register`, `/api/account-exists`, `/api/turn`, `/api/notif-icon`, link previews,
share cards), `/api/auth-otp`, `/api/chat` (Levi), `/api/notify`, `/api/initiate-payment`, `/api/verify-payment`,
`/api/paystack-webhook`, `/api/order-payout-action`, `/api/order-reminders`, `/api/order-notify`,
`/api/vendor-payments` (+ `/api/listing-payments`), `/api/daily-cron`. Their request/response types are in
`src/contracts/api.ts`.

What changed inside them: database access is SQL through repositories; the body's `accessToken` is verified locally;
status changes that used the user's own token (`transition_order_status`, `vendor_decline_order`,
`create_payment_intent`, `create_commission_payment_intent`, `add_to_cart`, `increment_chat_usage`) run through
`DataContext.asUser`, so the database applies the same checks. Behaviour differences are listed in
[DEPLOYMENT.md](DEPLOYMENT.md#behaviour-changes).

## 7. Security and reliability

| Concern | Implementation |
|---|---|
| Configuration | `loadConfig()` validates every variable with Zod and names (never prints) the bad ones; production builds fail if required variables are missing (`scripts/check-deploy-env.mjs`) |
| Database credentials | `DATABASE_URL` only on the server; TLS `require`/`verify-full`; optional least-privilege login role (migration 0001) |
| Pooling | per-instance node-postgres pool (`DATABASE_POOL_MAX`), idle/connection timeouts, Supabase transaction pooler compatible |
| Timeouts | `statement_timeout` per transaction, `REQUEST_TIMEOUT_MS` for /api/v1, 20 s client timeout in the browser |
| Input validation | Zod schemas on every /api/v1 body, query and path parameter (declared on the route, enforced before the handler); 64 KB JSON limit; JSON bodies need `Content-Type: application/json` |
| API docs | Swagger UI/OpenAPI off in production unless `API_DOCS_ENABLED=true`; they describe the API, never expose data or configuration |
| Authorisation | verified identity + RLS + explicit ownership filters; `requireRole` for role-gated routes |
| CSRF | cookie-authenticated writes need a trusted `Origin`; bearer tokens are not cookie-borne |
| Rate limiting | sign-in (10/min and 60/h per IP, 20/h per account), writes (60-240/min per user); per-instance memory store, pluggable |
| Errors | `AppError` codes; PostgreSQL errors mapped by SQLSTATE; 5xx messages never reach clients |
| Logging | JSON lines with request id, method, path, status, duration, user id; tokens, passwords, cookies, keys and JWTs redacted |
| Health | `/api/v1/health/live`, `/api/v1/health/ready` |
| Shutdown | `server.ts`: stop accepting, drain (SHUTDOWN_GRACE_MS), close the pool |
| Secrets in webhooks | constant-time comparison for cron/webhook secrets and call-decline tokens |
| Headers | `secureHeaders` on /api/v1 (nosniff, frame options, referrer policy…); `Cache-Control: no-store` on user data |

## 8. Moving another feature off direct Supabase calls

1. Find the call sites: `npm run audit:supabase -- --json` (table/RPC → file:line).
2. Read what each query really does (columns, filters, order, embedded rows) and which RLS policy protects it
   (manual section 8b).
3. Add a repository method in `src/database/repositories/` returning the same shape (use `jsonRows` for anything the
   browser renders).
4. In `src/modules/<feature>/`: schemas (`*.schemas.ts`), the route definition with `requireUser`/`requireRole` and a
   rate limit for writes (`*.routes.ts`), a service method that runs the repository in `data.asUser(identity, …)`
   (`*.service.ts`, registered in `container.ts`), and a one-line handler (`*.controller.ts`). Mount the controller
   in `routes/v1.ts`, add its tag to `routes/docs.ts`, add its types to `contracts/v1.ts` and a line to
   `tests/v1/contracts.test.ts`. It appears in `/api/v1/docs` automatically.
5. Add the endpoint to `medris-frontend/src/services/api/v1-endpoints.ts` and a `levroData` method in
   `src/bridge/data-gateway.ts` whose "off" path is the exact old query; add the feature name to `BACKEND_FEATURES`.
6. Change the call site to the `levroData` method (one line).
7. Tests: backend route tests on the test database (behaviour + authorisation), a gateway test asserting the "off"
   query chain, then `npm run check`.
8. Roll out with `VITE_BACKEND_FEATURES` (DEPLOYMENT.md), compare, and only then delete the fallback query.

## 9. Tests

`npm test -w medris-backend` (164 tests) runs everything against **PGlite** (PostgreSQL in-process; no installation).
`TEST_DATABASE_URL=postgres://…/medris_test npm run test:postgres -w medris-backend` runs the same suite against a real
PostgreSQL (the database name must end in `_test`; each test file uses its own scratch database). The test schema is
**production's real structure** - every table, function, trigger, grant and policy, exported into
`src/database/baseline/` (its README) - followed by the backend's own migrations; see `tests/support/test-db.ts`. So
tests exercise the real database functions and rules: seed data the way the app creates it (`tests/support/fixtures.ts`:
users through `auth.users` and the sign-up triggers, complete vendors, buyers with a phone). External services are
stubbed; nothing reaches the network. What the real schema revealed when the tests moved onto it:
[BASELINE_FINDINGS.md](BASELINE_FINDINGS.md).
