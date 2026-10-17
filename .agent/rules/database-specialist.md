---
trigger: model_decision
description: Use for anything that changes the database - tables, columns, indexes, SQL functions/RPCs, triggers, row-level security policies, grants, cron jobs - or for reviewing queries and data integrity.
---

# Database specialist

Production is Supabase PostgreSQL 17, project `ovklnoroyxobijgvsyfp`, with 70+ tables, row-level security on every
table and ~300 functions. **You never change production directly.** Every change is a migration file that a person
reviews and applies after approval (`docs/DATABASE.md`, section 3).

## Writing a migration

1. `npm run db:migration:new -w medris-backend -- "short description"` creates
   `medris-backend/src/database/migrations/NNNN_short_description.sql` from the template. Fill in Why / Effect /
   Roll back; leave "Approved" for the reviewer.
2. Write idempotent, guarded SQL: `create ... if not exists`, `create or replace function`, and for removals check the
   expected state first and `raise exception` if it differs. The runner wraps each
   expected state first and `raise exception` if it differs (see `0003`-`0006` for the pattern). The runner wraps each
   file in a transaction - no `BEGIN`/`COMMIT`. `CREATE INDEX CONCURRENTLY` goes alone in a file that starts with
   `-- migrate:no-transaction`.
3. Functions the browser calls: `security definer`, `set search_path = public`, check `auth.uid()` (and
   `is_admin()` / `owns_vendor()` as needed) **first**, then `grant execute ... to authenticated` only. Keep the same
   name, arguments and result shape unless the task is to change them - the frontend calls 150+ functions by name.
4. New tables: enable RLS and add explicit policies; money as `numeric` naira; timestamps `timestamptz`.
5. Never edit a migration that is already on `main` - write a new one. Never re-run `supabase/01`-`14`.
6. Check it: `npm run db:migrations:check -w medris-backend` and `npm test -w medris-backend` (applies every migration
   to a test database). Add a test in `medris-backend/tests/` for anything with guards or business rules.
7. In the pull request, say clearly: "Database change - needs approval and `npm run db:migrate` by the engineer", and
   whether app code depends on it (then the migration must be applied before that code is merged).

## Reviewing queries

Check row counts and pagination, missing indexes for the actual filters, N+1 calls from the browser (batch them into
one RPC, as `get_orders_buyer_names` does), and that RLS - not the browser - decides who sees which rows.
