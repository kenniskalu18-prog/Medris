-- Mobihealth Campus Champions — database schema
-- Run this once in the Supabase SQL Editor (or apply via `supabase db push`).
-- All objects are prefixed with "champion_" so they stay isolated from any other
-- tables that may already exist in your Supabase project.

create extension if not exists "pgcrypto";

-- =========================================================
-- 1. Administrators
-- =========================================================
create table if not exists public.champion_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'admin' check (role in ('super_admin', 'admin')),
  added_by text,
  status text not null default 'active' check (status in ('active', 'pending', 'removed')),
  created_at timestamptz not null default now()
);

-- Seed the initial Super Admin. Change the email below before running if needed.
insert into public.champion_admins (email, role, added_by, status)
values ('kenniskalu18@gmail.com', 'super_admin', 'system', 'active')
on conflict (email) do nothing;

-- =========================================================
-- 2. Programme settings (single row, editable from the admin dashboard)
-- =========================================================
create table if not exists public.champion_settings (
  id int primary key default 1,
  program_name text not null default 'Mobihealth Campus Champions',
  program_description text not null default 'A Mobihealth campus initiative recruiting passionate UNILAG students to lead, inspire and drive health impact on campus.',
  application_status text not null default 'open' check (application_status in ('open', 'closed')),
  deadline timestamptz not null default '2026-09-05 23:59:59+01',
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint champion_settings_singleton check (id = 1)
);

insert into public.champion_settings (id) values (1) on conflict (id) do nothing;

-- =========================================================
-- 3. Applications
-- =========================================================
create table if not exists public.champion_applications (
  id uuid primary key default gen_random_uuid(),
  application_number text not null unique,

  full_name text not null,
  preferred_name text,
  email text not null,
  phone text not null,
  whatsapp text,
  gender text,
  age_range text,
  matric_number text not null,
  institution text,
  faculty text not null,
  department text not null,
  level text not null,
  graduation_year text,

  introduction text,
  passions text[],
  has_prior_experience boolean,
  previous_experience text,
  leadership_roles text,

  why_mobihealth text,
  champion_role text,
  promotion_strategy text,
  one_month_idea text,
  contribution_areas text[],
  primary_track text,
  secondary_tracks text[],
  wants_leadership boolean default false,
  leadership_role_interest text,
  leadership_experience text,
  why_lead text,
  leadership_idea text,

  communication_rating int check (communication_rating between 1 and 5),
  public_speaking_rating int check (public_speaking_rating between 1 and 5),
  social_media_activity text,
  social_platforms text[],
  weekly_availability text,
  campus_events boolean,
  social_media_sharing text,

  champion_idea text,
  unique_strength text,
  referral_source text,
  profile_photo_path text,
  cv_path text,
  instagram text,
  linkedin text,
  additional_information text,

  status text not null default 'New' check (status in ('New','Under Review','Shortlisted','Interview','Selected','Not Selected')),
  admin_notes text default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists champion_applications_email_idx on public.champion_applications (lower(email));
create unique index if not exists champion_applications_matric_idx on public.champion_applications (lower(matric_number));
create index if not exists champion_applications_institution_idx on public.champion_applications (institution);
create index if not exists champion_applications_faculty_idx on public.champion_applications (faculty);
create index if not exists champion_applications_department_idx on public.champion_applications (department);
create index if not exists champion_applications_level_idx on public.champion_applications (level);
create index if not exists champion_applications_status_idx on public.champion_applications (status);
create index if not exists champion_applications_created_idx on public.champion_applications (created_at);

-- =========================================================
-- 4. Status change history
-- =========================================================
create table if not exists public.champion_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.champion_applications(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by text not null,
  changed_at timestamptz not null default now()
);

-- =========================================================
-- 5. Admin activity log
-- =========================================================
create table if not exists public.champion_activity_log (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

-- =========================================================
-- Application number generator (MOBI-YYYY-00001)
-- =========================================================
create sequence if not exists champion_application_seq;

create or replace function public.champion_next_application_number()
returns text
language sql
set search_path = public
as $$
  select 'MOBI-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('champion_application_seq')::text, 5, '0');
$$;

-- =========================================================
-- Row Level Security
-- =========================================================
alter table public.champion_applications enable row level security;
alter table public.champion_admins enable row level security;
alter table public.champion_settings enable row level security;
alter table public.champion_status_history enable row level security;
alter table public.champion_activity_log enable row level security;

create or replace function public.champion_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.champion_admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'active'
  );
$$;

create or replace function public.champion_is_super_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.champion_admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'active'
    and role = 'super_admin'
  );
$$;

-- Applications: anyone can submit (insert). Only logged-in, approved admins can read/update. Nobody can delete.
drop policy if exists champion_applications_insert on public.champion_applications;
create policy champion_applications_insert on public.champion_applications
  for insert to anon, authenticated
  with check (true);

drop policy if exists champion_applications_select on public.champion_applications;
create policy champion_applications_select on public.champion_applications
  for select to authenticated
  using (public.champion_is_admin());

drop policy if exists champion_applications_update on public.champion_applications;
create policy champion_applications_update on public.champion_applications
  for update to authenticated
  using (public.champion_is_admin())
  with check (public.champion_is_admin());

-- Only the Super Admin can permanently delete an application.
drop policy if exists champion_applications_delete on public.champion_applications;
create policy champion_applications_delete on public.champion_applications
  for delete to authenticated
  using (public.champion_is_super_admin());

-- Admins table: only admins can read the full list; only super admins can add/change admins.
drop policy if exists champion_admins_select on public.champion_admins;
create policy champion_admins_select on public.champion_admins
  for select to authenticated
  using (public.champion_is_admin());

-- Anyone can always see their OWN admin row (any status) — this is what lets
-- the app tell a brand-new signup, a pending request, and an approved admin
-- apart, before they're an approved admin themselves.
drop policy if exists champion_admins_select_self on public.champion_admins;
create policy champion_admins_select_self on public.champion_admins
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists champion_admins_write on public.champion_admins;
create policy champion_admins_write on public.champion_admins
  for insert to authenticated
  with check (public.champion_is_super_admin());

drop policy if exists champion_admins_update on public.champion_admins;
create policy champion_admins_update on public.champion_admins
  for update to authenticated
  using (public.champion_is_super_admin())
  with check (public.champion_is_super_admin());

-- Belt-and-braces: the primary Super Admin's row can never be demoted or
-- deactivated by anyone, even another Super Admin acting through the RLS
-- policy above. Update the email below if you change your primary admin.
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

-- =========================================================
-- Rate-limited admin access requests (max 3 per email per 24h)
-- =========================================================
-- Every request attempt (new signup or re-request after being declined) is
-- logged here. Not directly readable/writable by clients -- only the
-- SECURITY DEFINER function below touches it, so the limit can't be
-- bypassed by calling the table directly.
create table if not exists public.champion_admin_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_at timestamptz not null default now()
);
alter table public.champion_admin_requests enable row level security;
create index if not exists champion_admin_requests_email_idx on public.champion_admin_requests (lower(email), requested_at);

-- Called by the app right after a user signs in for the first time (or
-- signs back in after being declined). Files a pending request for their
-- own email, capped at 3 attempts per rolling 24 hours. Already-pending or
-- already-active accounts are left untouched and don't consume the limit.
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

-- Settings: readable by everyone (needed for the public countdown/open-closed state),
-- editable only by approved admins.
drop policy if exists champion_settings_select on public.champion_settings;
create policy champion_settings_select on public.champion_settings
  for select to anon, authenticated
  using (true);

drop policy if exists champion_settings_update on public.champion_settings;
create policy champion_settings_update on public.champion_settings
  for update to authenticated
  using (public.champion_is_admin())
  with check (public.champion_is_admin());

-- Status history / activity log: admins only.
drop policy if exists champion_status_history_all on public.champion_status_history;
create policy champion_status_history_all on public.champion_status_history
  for all to authenticated
  using (public.champion_is_admin())
  with check (public.champion_is_admin());

drop policy if exists champion_activity_log_all on public.champion_activity_log;
create policy champion_activity_log_all on public.champion_activity_log
  for all to authenticated
  using (public.champion_is_admin())
  with check (public.champion_is_admin());

-- =========================================================
-- Private storage buckets for profile photos & CVs
-- =========================================================
insert into storage.buckets (id, name, public)
values ('champion-photos', 'champion-photos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('champion-cvs', 'champion-cvs', false)
on conflict (id) do nothing;

drop policy if exists champion_photos_insert on storage.objects;
create policy champion_photos_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'champion-photos');

drop policy if exists champion_photos_admin_read on storage.objects;
create policy champion_photos_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'champion-photos' and public.champion_is_admin());

drop policy if exists champion_cvs_insert on storage.objects;
create policy champion_cvs_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'champion-cvs');

drop policy if exists champion_cvs_admin_read on storage.objects;
create policy champion_cvs_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'champion-cvs' and public.champion_is_admin());

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
