# Database baseline: production's structure

The exact structure of the live database (project `ovklnoroyxobijgvsyfp`), exported on **14 Oct 2026** with
`supabase/export.sh`. No data, no users, no secrets. Every local, test and CI database is built from these files, then
the migrations in `../migrations/` are applied on top - the same order production goes through.

| File | Contents |
|---|---|
| `00-platform-standin.sql` | **Local/test only.** Minimal stand-ins for what Supabase provides outside `public`: the API roles, `auth.users` / `identities` / `sessions` and `auth.uid()`, the `extensions` schema, `storage.buckets` / `objects` with `storage.foldername()`, `net.http_post()` (records calls in `net.http_requests` instead of sending them), `cron.schedule()` (records jobs, runs nothing), the `supabase_realtime` publication. **Never run it against Supabase.** |
| `01-public-schema.sql` | `pg_dump --schema-only` of `public`: 74 tables (row-level security on all), 293 functions, 72 triggers, 155 policies, indexes, and every GRANT. |
| `02-storage.sql` | The 11 Storage buckets (settings only) and their 33 access policies. |
| `03-auth-triggers.sql` | The 4 triggers on `auth.users` / `auth.sessions` (profile creation at sign-up, referral at sign-up, login log). |
| `04-realtime.sql` | The 22 tables Realtime streams to the browser. |
| `05-cron-jobs.sql` | The 9 pg_cron jobs. |

Loading order and session reset: `scripts/baseline.ts` (`baselineSql()`); used by `tests/support/test-db.ts` and
`npm run db:dev`.

## Rules

- **Do not edit these files by hand** (except `00-platform-standin.sql`). A change to the database is a migration in
  `../migrations/`; the baseline only changes when it is refreshed from production.
- **Refresh** when production changed outside the migration process (e.g. something was run in the Supabase SQL editor):
  `./supabase/export.sh` (from the repository root; asks for the database password), then
  `npm run db:baseline:update -w medris-backend`, review `git diff`, run `npm test`. The update script refuses an export
  that did not finish cleanly or that still contains anything that looks like a key.
- The webhook secret that three functions send to `/api/notify` is replaced by `<WEBHOOK_SECRET>` (export.sh does it).
  The repository is public: never commit an export that still contains it.
- Line endings are kept exactly (`.gitattributes`: `-text`): one function's source genuinely contains CR LF.

## What the stand-in does not reproduce

Supabase Auth's own behaviour (password hashing, JWT issuing), Storage's file API, Realtime delivery and pg_net's HTTP
calls. Tests that need them stub them (`tests/helpers.ts` `stubFetch`) or read what the database recorded
(`net.http_requests`, `cron.job`).
