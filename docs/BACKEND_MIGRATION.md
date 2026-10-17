# Moving the backend off Supabase

The plan to take every job Supabase does for Levromart into `medris-backend`, prove each one works, and then switch
Supabase's part off. The **14 Oct 2026** decisions this plan is built on:

| Decision | Choice |
|---|---|
| End state | All business logic, permissions, live updates and scheduled jobs run in our backend; the browser talks only to it. Supabase keeps what the backend cannot replace: the **PostgreSQL host**, **file hosting** (Storage, brokered by `/api/v1/files`) and **Auth** (accounts and passwords; the backend signs in through it). Moving the database later is a dump/restore - [DATABASE.md §5](DATABASE.md#5-moving-postgresql-to-another-provider). |
| Sign-in | Moves **last**, after everything else, with existing passwords and Google links kept ([AUTH.md §4](AUTH.md#4-migration-plan-each-step-needs-your-approval)). |
| Order | **Low-risk areas first**; money flows (orders, payments, commission) last. |
| Hosting | **Heroku Basic dyno** (always on: needed for live updates and scheduled jobs). Vercel keeps serving the frontend. |

Related: [SUPABASE_AUDIT.md](SUPABASE_AUDIT.md) (what depends on Supabase), [BACKEND.md](BACKEND.md) (how the backend is
built; §8 is the per-feature recipe this plan extends), [AUTH.md](AUTH.md), [STORAGE.md](STORAGE.md),
[DATABASE.md](DATABASE.md).

## 1. Where we start

Re-count at any time with `npm run audit:supabase`. On 14 Oct 2026 (asset version 128):

| What the browser does with Supabase directly | Size | Notes |
|---|---|---|
| Table queries (`sb.from(...)`) | 456 call sites, 48 tables | protected only by row-level security |
| Database function calls (`sb.rpc(...)`) | 229 call sites, 151 functions | the business rules |
| Storage | 27 call sites, 9 buckets | vendor documents, chat attachments, receipts, dispute evidence… |
| Realtime | 12 channels | messages, notifications, orders, payments, comments, points; call/presence broadcast |
| Sign-in | 34 call sites | password, phone alias, Google, reset, sessions |

Inside the database: **311 functions** (265 `SECURITY DEFINER`), **69 triggers**, **149 RLS policies**, **8 pg_cron
jobs**, 3 functions calling `/api/notify` over `pg_net` with an embedded secret.

Already done (this branch): the backend talks to the database over plain SQL, verifies tokens itself, and serves
**cart, favourites, follows, notifications and catalogue reference data** - built and tested, but **switched off**
(`VITE_BACKEND_FEATURES` empty), and not deployed.

**Closed on 14 Oct 2026:** the source of the functions, policies and triggers used to exist only in the live database.
It is now exported into `medris-backend/src/database/baseline/` (293 functions, 72 triggers, 155 policies, 74 tables,
grants, Storage, Realtime, cron), and every test runs on it. Moving the tests onto it surfaced real problems, some live
in production today: [BASELINE_FINDINGS.md](BASELINE_FINDINGS.md).

## 2. What "done" means

1. The browser never talks to Supabase: no `sb.from`, `sb.rpc`, `sb.storage`, `sb.channel` or `sb.auth`;
   `supabase-js` is removed from the frontend; `npm run audit:supabase` reports zero for the frontend.
2. Every business rule lives in backend TypeScript (`modules/<area>/*.service.ts`) with tests, in git, reviewed
   through pull requests. Database functions that only held business logic are dropped (by migration, after approval).
3. What stays in PostgreSQL on purpose, because it is plain PostgreSQL and protects the data whoever writes it:
   constraints, unique indexes, `updated_at` stamps and pure integrity guards (e.g. "a vendor cannot buy from
   themselves"). These are ordinary database features, not Supabase.
4. Live updates, file storage and scheduled jobs run in the backend (sections 5.3-5.5).
5. Users sign in through the backend; Supabase Auth is off; `public.users` no longer references `auth.users`.
6. The only Supabase setting the app uses is `DATABASE_URL`.

## 3. Phases

Each phase ends with a check that must pass before the next starts. Nothing reaches users until a feature switch is
turned on, and every switch can be turned off again.

### Phase 0 - foundations (about 1-2 weeks)

| # | Step | Who |
|---|---|---|
| 0.1 | Run `supabase/export.sh` against production (read-only, structure only; it finds and removes the webhook secret by itself). Needs only the **database password** (Supabase → Project Settings → Database; it is not in Vercel). | engineer, with the DB password |
| 0.2 | Commit the redacted export as the **baseline** (`medris-backend/src/database/baseline/`): the real tables, functions, triggers, grants, policies, Storage and Realtime settings, in git for the first time. The repository is public, so the pull request first checks the files for anything secret (the script removes the webhook secret and common key formats; also search for `secret`, `key`, `token`, `password`). Publishing function and policy source is fine: security must not depend on it being hidden. | PR |
| 0.3 | Build the test database from the baseline instead of the stand-ins, so every test runs against the real functions and policies (PGlite where it can, the PostgreSQL 17 CI job otherwise). | PR |
| 0.4 | **Parity test kit** (section 4): run the old database function and the new TypeScript code on identical data and compare. | PR |
| 0.5 | **Ratchet in CI**: `audit:supabase` fails a pull request that adds a direct Supabase call (counts may only go down). This stops new work, including the React conversion, from adding to the pile. | PR |
| 0.6 | Deploy the backend to **Heroku (Basic dyno)**: `DATABASE_URL` (session pooler, port 5432), health checks, logs, error alerts. Vercel rewrites `/api/v1/*` to it, so the browser keeps calling its own domain (cookies keep working). | engineer |
| 0.7 | Apply migration `0001` (least-privilege `medris_api` role) after approval, so the backend does not run as `postgres`. | approval |

Exit: `/api/v1/health/ready` green on Heroku from the production frontend; CI runs on the real schema; the ratchet is on.

### Phase 1 - prove the method on what is already built (about 1 week)

Turn on `catalogue, favorites, follows, notifications, cart` one at a time: first in your own browser on production
(`levroData.useBackend("favorites")`), then on a preview build, then for everyone (`VITE_BACKEND_FEATURES`). Watch
errors and response times for a few days each; then delete the fallback query. Nothing in this phase moves logic
yet - it proves the pipeline (Heroku, rewrites, monitoring, rollback) on low-risk features.

Exit: five features on for everyone for a week with no regressions; fallbacks removed.

### Phase 2 - area by area (the bulk: about 8-12 weeks)

Each area follows the recipe in section 4 and ends with its switch on in production. Order, by risk:

| # | Area | Functions called from the browser (calls) | Goes with |
|---|---|---|---|
| 2.1 | Catalogue & search: products, packages, variants, reviews, comments, likes, engagement settings, view counts | 14 (27) | - |
| 2.2 | Follows & social (rest), suggestions, Levi conversations, notifications (rest) | 15 (20) | realtime (notifications) |
| 2.3 | Points, referrals, leaderboard | 12 (16) | realtime (points) |
| 2.4 | Requests, offers, service offers | 6 (6) | - |
| 2.5 | Messaging & calls | 23 (36) | **realtime replacement** (5.3) |
| 2.6 | Vendors, admin & accounts: applications, campus/student verification, storefront, suspensions, appeals, legal consent, manual password resets | 44 (60) | **storage replacement** (5.4) |
| 2.7 | Orders & checkout | 13 (18) | realtime (orders) |
| 2.8 | Payments & disputes | 13 (19) | realtime (payments), storage (evidence, receipts) |
| 2.9 | Commission & vendor billing | 11 (27) | scheduled jobs (5.5) |

Areas 2.7-2.9 move money. They get the strictest parity tests (every state transition, every role, every failure
path) and a longer side-by-side period with the switch on for staff accounts first.

The **database functions only the database calls** (triggers, cron, helpers) move with the area that owns them; e.g.
`record_order_completion_commission` (trigger) moves with 2.9, `notify_*` triggers move with their area as an
explicit "create notification" step inside the same transaction.

### Phase 3 - sign-in (about 2-3 weeks including rollout)

[AUTH.md](AUTH.md) phases 2-4, already built and tested (backend sessions, password check against the existing
hashes, Google sign-in): turn on in preview, run both in parallel, then make the backend the identity store. Users
keep their passwords and Google sign-in; everyone signs in once more. Needs explicit approval: it touches every live
user.

### Phase 4 - switch Supabase's part off (about 1 week)

Remove `supabase-js` from the frontend; drop the functions whose logic moved (migration, approval); drop the
`anon`/`authenticated` grants on tables the browser no longer needs; turn off the Data API in the Supabase settings
and remove the tables from the Realtime publication; remove the Storage buckets after their files have moved; delete the `SUPABASE_*` variables that are
no longer read. What remains: a PostgreSQL database on Supabase that only the backend connects to.

**Total: roughly 3-4 months for one engineer**, most of it in phase 2. The order lets you stop after any area with a
working app.

## 4. The recipe for one area

Extends [BACKEND.md §8](BACKEND.md#8-moving-another-feature-off-direct-supabase-calls).

1. **List** the area's call sites (`npm run audit:supabase -- --json`), the functions and triggers it uses and the
   policies that guard its tables (from the baseline).
2. **Write the tests first, against the old behaviour.** For each operation, cases for: the happy path, every role
   (owner, other user, vendor, admin, signed out), every refusal message, every state a record can be in, and the side
   effects (notifications, counters, stock, commission rows). Run them against the **existing database function** on
   the baseline schema - they must pass before any new code exists. These tests are the contract.
3. **Parity checks** for anything with branching logic: seed identical data, run the old function in one transaction
   and the new service in another, compare the result and every row it changed. Any difference is either a bug in the
   new code or a bug in the old one; the latter is fixed deliberately, recorded in the pull request, never silently.
4. **Write the TypeScript**: repository (SQL) → service (the rules, authorisation, one transaction) → controller.
   Authorisation is decided in the service from the verified user; RLS stays on underneath as a second lock until
   phase 4.
5. **Switch the call sites** to `levroData` (feature switch, old query kept as the "off" path).
6. **Roll out**: your browser → preview → staff accounts → everyone; watch logs and error rates.
7. **Clean up** after a week without issues: delete the fallback; add a migration that drops the now-unused database
   functions/triggers (approval); the ratchet locks the lower count in.

An area is done when its switch is on for everyone, its fallback is deleted, and `audit:supabase` shows none of its
call sites.

## 5. The Supabase services, one by one

### 5.1 Data access (PostgREST)

Replaced area by area by `/api/v1` endpoints (section 4). The browser's 456 table queries become a much smaller set
of purpose-built endpoints (one per screen need), which is also faster on slow networks.

### 5.2 Business logic (database functions and triggers)

Functions: moved into services (all 161 the app calls, the 8 jobs, the 22 helpers - [PORTING.md](PORTING.md)). A
function's logic moves together with **every** caller (browser, other functions, triggers, cron) or the old function
stays as the single implementation until they all have moved.

Triggers (72) **stay in PostgreSQL**: they are rules on the data, so they run for the backend's writes exactly as for
the browser's, and they move with the database to any PostgreSQL host. Four run when Supabase Auth creates an account
or a session (Auth stays), and one sends email/push for new notifications through `pg_net` (it becomes an outbox only
if the database ever leaves Supabase).

### 5.3 Realtime (12 channels)

**Built:** the WebSocket `/api/v1/live` ([LIVE.md](LIVE.md)). Row changes reach it through migration 0004's NOTIFY
trigger and are re-read as each subscriber (row-level security decides, as in Realtime); typing, presence and call
signalling are rooms restricted to their two people (fix S14); package comments now update live (fix B15). All 12
channels are mapped in [TABLE_QUERIES.md](TABLE_QUERIES.md). Per channel at the switch: point the subscription at
`/api/v1/live` behind the area's feature flag, the same way as data.

### 5.4 Storage (9 buckets)

**Step 1 (built): the backend decides, Supabase keeps the files.** The 30 `sb.storage` calls (27 named buckets + 3 with
the bucket in a variable) map to `/api/v1/files`: `upload-links` (a one-file upload link; the browser PUTs the file
straight to Storage), `signed-urls`, `delete` and `list` (public buckets only). Before acting with the service key the
backend checks the caller with `StorageAccessRepository`, the storage.objects policies ported rule by rule (including:
overwriting needs the bucket's update rule, which only avatars, vendor-logos, homepage-carousel and receipts have;
chat attachments can never be deleted). `tests/parity/storage-access.parity.test.ts` runs every bucket x caller x path
x operation against the real policies. Two differences the frontend switch must handle: a refused file gives 403 for
the whole request (Storage silently skipped it in `remove`, and returned a per-file error in `createSignedUrls`). No
file is moved or deleted.

**Step 2 (later, optional):** private files (vendor documents, chat attachments, receipts, dispute evidence, support attachments) move to a
**private Cloudflare R2 bucket** (public images are already on R2): the backend checks who may see a file and returns a
short-lived signed URL, replacing the 32 Storage policies. New uploads go to R2 from the day an area switches over;
existing files are copied by a one-off job **under an approved data-migration plan** (counts and checksums compared,
originals kept until verified) - see [STORAGE.md](STORAGE.md).

### 5.5 Scheduled jobs and webhooks (pg_cron, pg_net)

The 8 pg_cron jobs become jobs in the backend (a scheduler on the Basic dyno, with a database lock so a job never
runs twice), each calling the area's service. The three `pg_net` calls to `/api/notify` become an **outbox** table
written in the same transaction and sent by the backend - which also removes the webhook secret from the function
source. A job moves with its area; until then pg_cron keeps running it.

### 5.6 Sign-in

Phase 3.

### 5.7 The `api/` functions on Vercel

The 12 original functions (payments, Paystack webhook, notify, Levi, uploads, cron…) already share their data layer
with the backend. They move to Heroku with the area they belong to (payments with 2.8, Levi with 2.2, cron with 5.5);
Vercel's rewrite sends their paths to Heroku, so external URLs (e.g. the Paystack webhook) do not change. Vercel then
serves only the frontend.

## 6. Working alongside the React conversion

The founder's React work and this plan touch the same screens. To avoid doing things twice:

- React screens get their data through `window.levroData` / `src/services/api`, never `sb` directly; the CI ratchet
  (0.5) enforces it.
- When a screen is converted before its area has moved, it keeps calling the same gateway method; when the area moves,
  the screen follows automatically.
- Agree each week which areas each of you is on, so a screen is not converted and re-wired in the same week.

## 7. Safety rules for the whole migration

These are the project's standing rules, restated for this work:

- Production is only ever read for the export. No test, parity check or rehearsal runs against production; they run on
  local/CI databases built from the baseline. Never copy production data to a laptop.
- Every database change is a migration file reviewed in a pull request and applied by the engineer after approval;
  nothing is dropped until its replacement has run for everyone for at least a week.
- Every switch can be turned off; every phase has a rollback (switch off, or redeploy the previous version).
- Sign-in changes, file moves and drops of functions/policies each need explicit approval.
- Secrets live in Heroku/Vercel settings only - never in the repository (it is public), the baseline export, or logs.

## 8. Progress

Update this table in the pull request that completes each step.

| Area / service | Tests on baseline | Backend code | Switch: preview | Switch: everyone | Fallback deleted | Old functions dropped |
|---|---|---|---|---|---|---|
| Phase 0: export (0.1), baseline (0.2), tests on the real schema (0.3) | **done** | - | - | - | - | - |
| Phase 0: parity kit (0.4), ratchet (0.5), Heroku (0.6), role 0001 (0.7) | parity kit + tracker (`docs/PORTING.md`) done | - | - | - | - | - |
| Cart, favourites, follows, notifications, catalogue reference | yes (real schema) | yes | - | - | - | - |
| 2.1 Catalogue & search | parity (`catalogue.parity`) | yes (fix B8) | - | - | - | - |
| 2.2 Follows & social, suggestions, Levi, notifications | parity | yes | - | - | - | - |
| 2.3 Points & referrals | parity (`points.parity`) | yes | - | - | - | - |
| 2.4 Requests & offers | parity (`service-offers.parity`) | service bookings yes (fix B9); equipment requests: table endpoints | - | - | - | - |
| 2.5 Messaging & calls (+ realtime) | parity (`conversations.parity`, `live.parity`) | functions yes (fix S4); realtime on `/api/v1/live` (fix S14) | - | - | - | - |
| 2.6 Vendors, admin & accounts (+ storage) | parity (`shops.parity`, `account-data.parity`, `storage-access.parity`) | functions yes (fix B10, S2); storage brokered by `/api/v1/files` (files stay in Supabase) | - | - | - | - |
| 2.7 Orders & checkout | parity (`order-actions.parity`, `checkout.parity`) | yes | - | - | - | - |
| 2.8 Payments & disputes | parity (`payment-claims.parity`) | yes (fix B2, S4) | - | - | - | - |
| 2.9 Commission & billing (+ jobs) | parity (`commission.parity`, `scheduled-jobs.parity`) | yes (fix B11); all 8 pg_cron jobs ported (`/api/v1/jobs`), pg_cron keeps running them until the switch | - | - | - | - |
| Helpers and policy checks (called only by other functions or by RLS) | parity (`helpers.parity`) | yes, 22 + 3 | - | - | - | - |
| The browser's direct table queries (456, `docs/TABLE_QUERIES.md`) | parity (`tables-*.parity`, browser query vs endpoint as the same user) | all 456 have an endpoint (fixes S5-S13, B12-B14) | - | - | - | - |
| File storage (30 `sb.storage` calls, 9 buckets, `docs/TABLE_QUERIES.md`) | parity (`storage-access.parity`: every bucket, caller, path and operation vs the real policies) | all 30 mapped to `/api/v1/files`; files stay in Supabase Storage | - | - | - | - |
| Live updates (12 `sb.channel` subscriptions) | parity (`live.parity`: each channel vs the same row read as the same user; `live-socket` over a real WebSocket) | all 12 on `/api/v1/live` (fixes B15, S14); needs migration 0004 | - | - | - | - |
| Phase 3 Sign-in | - | built, off | - | - | - | - |
| Phase 4 Switch-off | - | - | - | - | - | - |
