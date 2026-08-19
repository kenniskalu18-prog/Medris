# Enable admin sign-up requests

## 1. Fix "Email signups are disabled"

This is a separate switch from "Confirm email." In Supabase:

**Authentication → Providers → Email** — make sure **"Allow new users to
sign up"** (sometimes shown as "Enable sign ups") is turned **ON**.
(**Confirm email** should stay **OFF**, as set up before — that's what lets
someone get a session immediately after creating a password, no email
required.)

## 2. Add the "pending approval" database rules

Paste this into **SQL Editor → New query** and click **Run**:

```sql
-- Allow the pending/removed states, not just active.
alter table public.champion_admins drop constraint if exists champion_admins_status_check;
alter table public.champion_admins add constraint champion_admins_status_check
  check (status in ('active', 'pending', 'removed'));

-- Let anyone see their OWN admin row (any status), so the dashboard can
-- tell a brand-new signup, a pending request, and an approved admin apart.
drop policy if exists champion_admins_select_self on public.champion_admins;
create policy champion_admins_select_self on public.champion_admins
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Let a newly-signed-up user create exactly one row for themselves, and
-- only ever as a pending, non-admin request -- never active, never
-- super_admin. Only the Super Admin (via the existing insert policy) can
-- create an admin that's active from the start.
drop policy if exists champion_admins_insert_self on public.champion_admins;
create policy champion_admins_insert_self on public.champion_admins
  for insert to authenticated
  with check (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'pending'
    and role = 'admin'
  );
```

That's it — the app side already knows how to use this once you send it the
updated `admin.html`.
