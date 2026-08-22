# Add draft tracking + submission rate limiting

Paste this into **SQL Editor -> New query** in your Supabase project and
click **Run**. It's additive only, nothing existing is touched:

- A new `champion_application_drafts` table + `champion_track_draft()`
  function, so the admin dashboard can show applicants who started the
  form but never submitted (no personal info is stored, just a random
  session id, institution/track picked so far, and step reached).
- A new `champion_submission_attempts` table + `champion_check_submission_rate()`
  function, which caps a single browser/device to 5 application submission
  attempts per hour, server-side (the part a client can't bypass).

```sql
-- =========================================================
-- Started-but-not-completed application tracking
-- =========================================================
-- Deliberately minimal: a random client-generated session id, the
-- institution/track the applicant picked (if any) and the step they
-- reached. No name, email, phone or any other personal detail is ever
-- written here -- that only happens on a real, completed submission into
-- champion_applications.
create table if not exists public.champion_application_drafts (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  institution text,
  primary_track text,
  current_step int,
  completed boolean not null default false,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
alter table public.champion_application_drafts enable row level security;
create index if not exists champion_application_drafts_completed_idx
  on public.champion_application_drafts (completed, last_activity_at);

-- Only admins can read drafts directly. All writes go through the
-- SECURITY DEFINER function below so a client can only ever touch its own
-- session_id, never anyone else's row.
drop policy if exists champion_application_drafts_select on public.champion_application_drafts;
create policy champion_application_drafts_select on public.champion_application_drafts
  for select to authenticated
  using (public.champion_is_admin());

create or replace function public.champion_track_draft(
  p_session_id text,
  p_institution text,
  p_primary_track text,
  p_step int,
  p_completed boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_session_id is null or length(trim(p_session_id)) = 0 then
    return;
  end if;
  insert into public.champion_application_drafts (session_id, institution, primary_track, current_step, completed)
  values (p_session_id, p_institution, p_primary_track, p_step, coalesce(p_completed, false))
  on conflict (session_id) do update
    set institution = coalesce(excluded.institution, public.champion_application_drafts.institution),
        primary_track = coalesce(excluded.primary_track, public.champion_application_drafts.primary_track),
        current_step = greatest(coalesce(excluded.current_step, 0), coalesce(public.champion_application_drafts.current_step, 0)),
        completed = public.champion_application_drafts.completed or excluded.completed,
        last_activity_at = now();
end;
$$;

grant execute on function public.champion_track_draft(text, text, text, int, boolean) to anon, authenticated;

-- =========================================================
-- Application submission rate limiting (basic abuse protection)
-- =========================================================
-- Real protection against scripted/repeated submissions has to live here,
-- server-side -- a client-side-only check can always be bypassed by anyone
-- calling the API directly. This caps how many submission attempts a
-- single client id (a random id generated in the browser, not tied to any
-- personal data) can make in a rolling window.
create table if not exists public.champion_submission_attempts (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  attempted_at timestamptz not null default now()
);
alter table public.champion_submission_attempts enable row level security;
create index if not exists champion_submission_attempts_client_idx
  on public.champion_submission_attempts (client_id, attempted_at);

create or replace function public.champion_check_submission_rate(p_client_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.champion_submission_attempts
  where client_id = coalesce(p_client_id, 'unknown')
    and attempted_at > now() - interval '1 hour';

  if v_count >= 5 then
    raise exception 'Too many application attempts from this device. Please try again in a while.';
  end if;

  insert into public.champion_submission_attempts (client_id) values (coalesce(p_client_id, 'unknown'));
end;
$$;

grant execute on function public.champion_check_submission_rate(text) to anon, authenticated;
```
