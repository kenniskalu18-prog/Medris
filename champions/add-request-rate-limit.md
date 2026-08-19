# Allow declined admins to request again (max 3/day)

Paste this into **SQL Editor → New query** in your Supabase project and
click **Run**. It lets someone who was declined try again later, while a
rate limit enforced by the database (not just the app) stops anyone from
spamming requests — capped at 3 attempts per email per rolling 24 hours.

```sql
-- Every request attempt (new signup or re-request after being declined) is
-- logged here. Not directly readable/writable by clients -- only the
-- function below touches it, so the limit can't be bypassed by calling the
-- table directly.
create table if not exists public.champion_admin_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_at timestamptz not null default now()
);
alter table public.champion_admin_requests enable row level security;
create index if not exists champion_admin_requests_email_idx on public.champion_admin_requests (lower(email), requested_at);

create or replace function public.champion_request_admin_access()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_count int;
  v_status text;
begin
  if v_email = '' then
    raise exception 'Not authenticated';
  end if;

  select status into v_status from public.champion_admins where lower(email) = v_email;

  if v_status is not null and v_status <> 'removed' then
    return v_status; -- already pending or active -- nothing to do, no limit consumed
  end if;

  select count(*) into v_count
  from public.champion_admin_requests
  where lower(email) = v_email and requested_at > now() - interval '24 hours';

  if v_count >= 3 then
    raise exception 'You''ve reached the maximum of 3 requests per day. Please try again later.';
  end if;

  insert into public.champion_admin_requests (email) values (v_email);

  if v_status is null then
    insert into public.champion_admins (email, role, status, added_by) values (v_email, 'admin', 'pending', v_email);
  else
    update public.champion_admins set status = 'pending' where lower(email) = v_email;
  end if;

  return 'pending';
end;
$$;

grant execute on function public.champion_request_admin_access() to authenticated;

-- The old self-insert policy is no longer needed -- all request creation
-- now goes through the rate-limited function above instead.
drop policy if exists champion_admins_insert_self on public.champion_admins;
```

That's it — the `admin.html` I'm sending already knows how to call this.
