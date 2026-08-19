# Lock your Super Admin account permanently

Paste this into your Supabase project's **SQL Editor → New query** and click
**Run**. It adds a database-level guard so your account
(`kenniskalu18@gmail.com`) can never be demoted, deactivated, or removed by
anyone — not through the dashboard, not through the API directly, not even
by another Super Admin. It's enforced by Postgres itself, underneath the
app.

```sql
create or replace function public.champion_protect_primary_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(old.email) = 'kenniskalu18@gmail.com' then
    if new.status <> 'active' or new.role <> 'super_admin' then
      raise exception 'This account cannot be demoted or deactivated.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists champion_protect_primary_admin_trigger on public.champion_admins;
create trigger champion_protect_primary_admin_trigger
  before update on public.champion_admins
  for each row
  execute function public.champion_protect_primary_admin();
```

(There's already no way to *delete* an admin row at all — the schema never
grants a delete policy on `champion_admins` — so this trigger closes the one
remaining path: someone editing your row's `status` or `role` instead.)
