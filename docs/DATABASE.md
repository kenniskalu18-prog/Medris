# Database

The data lives in PostgreSQL 17, hosted by Supabase (project `ovklnoroyxobijgvsyfp`). The backend connects to it
directly with a standard connection string and nothing Supabase-specific in the code path. Schema reference: the
Backend Build Manual (`docs/LEVROMART_BACKEND_BUILD_MANUAL.pdf`) and `supabase/`.

## 1. Connecting

`DATABASE_URL` (server only) is a normal PostgreSQL URL. On Vercel use Supabase's **transaction pooler**:

```
Supabase dashboard → Project Settings → Database → Connection pooling → Transaction (port 6543)
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
DATABASE_POOL_MAX=3          # per function instance
DATABASE_SSL_MODE=require    # or verify-full with DATABASE_SSL_CA (Supabase's CA certificate)
```

For a long-running Node server the session pooler (port 5432) or a direct connection also works.

Check a deployment with `GET /api/v1/health/ready`: it reports whether the database answers and whether the login
role can switch to `anon`, `authenticated` and `service_role` (all three must be `true`).

## 2. How row-level security is preserved

Supabase's REST API never connected as the user; it connected as one role and, per request, ran
`set local role authenticated` and set `request.jwt.claims` to the verified JWT. `auth.uid()` reads that setting.
`DataContext` (`medris-backend/src/database/context.ts`) does exactly the same inside each transaction, so:

- all 149 RLS policies apply unchanged to `/api/v1` and to every user-initiated call in the original endpoints;
- every `SECURITY DEFINER` function sees the same `auth.uid()` and refuses the same callers;
- `service_role` (bypasses RLS) is used only for jobs, webhooks and code that has already authorised the caller -
  the same places the old code used the service-role key.

This was **not assumed**: `tests/v1/data-context.test.ts` shows that a query missing its own filter still only returns
the caller's rows, that the identity does not survive the transaction on a pooled connection, and that a failed
request rolls back. The suite passes on PGlite and on PostgreSQL 16.

### Least-privilege login role (migration 0001, not applied)

Today `DATABASE_URL` can use the `postgres` user. `src/database/migrations/0001_backend_api_role.sql` creates
`medris_api`: a login role with no table privileges of its own that can only switch to the three API roles, plus
read access to the few `auth.users` / `auth.identities` columns needed by backend sign-in. Tested in
`tests/v1/least-privilege.test.ts`. If Supabase refuses one of its grants (it manages those roles), keep `postgres`.

## 3. Changing the database (migrations)

Every change to the database - tables, columns, indexes, functions/RPCs, triggers, RLS policies, grants, cron jobs - is
a numbered SQL file in **`medris-backend/src/database/migrations/`**, reviewed in a pull request and applied with the
migration tool. Each database records what it has received in `medris_migrations.applied` (version, checksum, who,
when), so `npm run db:status` answers "is this change live?" for any database. Nothing is applied on start-up or by a
Vercel deploy.

### From idea to production

1. **Create the file:** `npm run db:migration:new -w medris-backend -- "add order index"` writes the next number
   (e.g. `0003_add_order_index.sql`) from a template with *Why / Effect / Roll back / Approved*.
2. **Write the SQL.** The runner wraps each file in a transaction together with its tracking row, so a failing file
   leaves nothing behind - do not add `BEGIN`/`COMMIT`. Statements PostgreSQL refuses inside a transaction
   (`CREATE INDEX CONCURRENTLY`, `VACUUM`) go in a file of their own that starts with `-- migrate:no-transaction`.
   Functions follow the existing convention: `create or replace function ... security definer set search_path = public`,
   check `auth.uid()` first, grant execute only to the roles that call it (manual section 13).
3. **Try it locally** (Docker database, section 4): `npm run db:migrate -w medris-backend -- --apply`, then `npm test`
   (the test databases are built from the baseline plus every migration).
4. **Open a pull request.** CI (`.github/workflows/ci.yml`) checks the file names and numbering, refuses files with their
   own transaction, runs the backend tests on PGlite and on PostgreSQL 17 with all migrations applied through the
   runner, and fails if a migration that is already on `main` was edited, renamed or deleted.
5. **After approval and merge, apply it to production** (below), then deploy code that depends on it.

### Applying to production (needs approval)

Use a session-mode connection (Supabase **session pooler** or direct connection, port **5432**); the transaction pooler
(6543) used by the app cannot hold the migration lock and is refused.

```bash
export MIGRATE_DATABASE_URL='postgresql://postgres.ovklnoroyxobijgvsyfp:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
npm run db:status  -w medris-backend         # applied / pending / changed
npm run db:migrate -w medris-backend         # dry run: lists what would be applied, changes nothing
npm run db:migrate -w medris-backend -- --apply --confirm aws-0-<region>.pooler.supabase.com
```

- `--apply` against anything that is not a local database also needs `--confirm <host>` repeating the target's host
  name, so a command meant for a laptop can never change production.
- `--only 0003,0005` limits the dry run or the apply to those pending files, so an approved file can go out while an
  earlier one is still waiting for approval (the earlier one stays pending and runs later).
- Pending files run in order under an advisory lock (one runner at a time), each with `lock_timeout = 10s` so a
  migration waiting on a busy table fails instead of blocking the app. The first file that fails is rolled back and
  the run stops; files before it stay applied.
- For anything risky, take a backup first (run the *Weekly database backup* workflow by hand).
- The first `--apply` creates schema `medris_migrations` with the table `applied`. It is not exposed through Supabase's
  REST API and `public`/`anon`/`authenticated` have no access to it.
- Keeping the standby project? Apply the same files to it the same way.

### Rules

- **Never edit, rename or delete a migration once it is on `main`** - write a new one. `db:status` reports an edited
  file as `changed` and refuses to apply anything; CI fails the pull request. Only for a merged file that has provably
  never been applied anywhere, the pull-request label `migration-edit` skips that CI check.
- One concern per file, with its roll-back SQL in the header.
- Two pull requests that pick the same number: CI fails on the second (duplicate version) - renumber it.
- **No more changes from the Supabase SQL editor or an AI tool's "apply migration".** If an emergency fix is made that
  way, add the same SQL as a migration straight away (idempotent: `if not exists`, `create or replace`) and apply it,
  so the record matches the database.

### Where things stand

| Files | State |
|---|---|
| `supabase/01_tables.sql` ... `supabase/14_*.sql` | History: applied to production by hand before this process (09-14 through Supabase's MCP tool, which keeps its own `supabase_migrations` table - left untouched). Reference only, never re-run. |
| `0001_backend_api_role.sql` | adds role `medris_api` (least-privilege connections) - pending, needs approval |
| `0002_backend_auth_sessions.sql` | adds empty table `backend_sessions` (for `AUTH_BACKEND_SESSIONS=true`) - pending, needs approval |
| `0003_backend_read_last_sign_in.sql` | lets `medris_api` read `auth.users.last_sign_in_at` (chat "last seen" in the backend) - pending, needs approval |
| `0004_backend_live_notify.sql` | a NOTIFY trigger on the 22 live tables, so the backend's `/api/v1/live` can push row changes (changes no data) - pending, needs approval |

The four clean-up migrations from manual section 11 (duplicate indexes, duplicate sectors, retiring `inventory` and
search v1) and the grant that went with the `inventory` move were **removed** on 17 Oct 2026: none of them is needed
to move the backend, and one deleted rows. They are in git history if the clean-up is wanted after the switch
([CLEANUP.md](CLEANUP.md)).

The authoritative state of any database is `npm run db:status` against it.

Drizzle table definitions (`src/database/schema/`) list only the columns the code uses; they describe the schema, they
do not change it. To see the full live schema as Drizzle code: `DATABASE_URL=... npm run db:introspect -w medris-backend`
(read-only; writes `drizzle/introspected/`). `drizzle-kit push`/`migrate` are deliberately not used.

## 4. Local development database

```bash
docker compose up -d db                          # PostgreSQL 17 on localhost:5432 (medris_dev + medris_test)
# medris-backend/.env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/medris_dev
DATABASE_SSL_MODE=disable
npm run db:dev -w medris-backend -- --seed       # baseline schema + every migration + a buyer, a vendor and a product
npm run dev:backend
```

`db:dev` refuses any host that is not local. Its schema is the one the tests use: production's real structure from
`medris-backend/src/database/baseline/` (on a local stand-in for the Supabase platform), then every migration. Never
copy production data to a laptop.

**Keeping the baseline current.** When production changed outside the migration process, run `./supabase/export.sh`
(structure only, read-only; it removes the webhook secret by itself) and `npm run db:baseline:update -w
medris-backend`, then review the diff ([baseline README](../medris-backend/src/database/baseline/README.md)).

Tests: `npm test` (PGlite, nothing to install) or `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/medris_test
npm run test:postgres -w medris-backend`.

## 5. Moving PostgreSQL to another provider

The application code needs only `DATABASE_URL`. What the *database* needs on the new host:

1. **PostgreSQL 17** with `pg_trgm`, `btree_gist`, `pgcrypto`, `uuid-ossp`; ideally `pg_cron` and `pg_net`
   (otherwise see step 6).
2. **The Supabase compatibility layer**: `medris-backend/src/database/portability/supabase-compat.sql` - roles `anon`,
   `authenticated`, `service_role` and `auth.uid()/role()/jwt()` defined exactly as Supabase defines them. With this,
   every policy and function works unchanged because the backend sets the same session settings.
3. **auth.users / auth.identities** with the same ids (from the weekly backup), because `public.users.id` references
   them. Password hashes are bcrypt and portable (AUTH.md).
4. Restore the `public` schema (structure, then data) from a fresh `supabase/export.sh` + `pg_dump`.
5. Point `DATABASE_URL` at the new host; check `/api/v1/health/ready`.
6. Things that are Supabase services rather than PostgreSQL - plan them separately: Auth (AUTH.md), Realtime (still
   used by the browser), Storage (STORAGE.md), `pg_net` webhooks (keep `pg_net`, or an outbox table polled by a
   worker), `pg_cron` (keep, or a scheduler calling the same SQL functions).

| Target | Notes |
|---|---|
| **Neon** | PostgreSQL 17, `pg_trgm`/`btree_gist`/`pgcrypto` available; use the pooled connection string; no `pg_cron`/`pg_net` → step 6 |
| **AWS RDS / Aurora PostgreSQL** | `pg_cron` available; `pg_net` not → outbox/worker; `DATABASE_SSL_MODE=verify-full` with the RDS CA bundle; RDS Proxy for serverless |
| **Self-hosted** | install the extensions you need (including `pg_cron`, `pg_net`); put PgBouncer (transaction mode) in front for serverless |

Rehearse on a copy first (manual section 12): restore, run the backend against it, compare table counts and spot-check
order totals before switching.
