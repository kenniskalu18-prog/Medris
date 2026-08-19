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
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now()
);

-- Seed the initial Super Admin. Change the email below before running if needed.
insert into public.champion_admins (email, role, added_by, status)
values ('kennyskalu18@gmail.com', 'super_admin', 'system', 'active')
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

-- Admins table: only admins can read the list; only super admins can add/change admins.
drop policy if exists champion_admins_select on public.champion_admins;
create policy champion_admins_select on public.champion_admins
  for select to authenticated
  using (public.champion_is_admin());

drop policy if exists champion_admins_write on public.champion_admins;
create policy champion_admins_write on public.champion_admins
  for insert to authenticated
  with check (public.champion_is_super_admin());

drop policy if exists champion_admins_update on public.champion_admins;
create policy champion_admins_update on public.champion_admins
  for update to authenticated
  using (public.champion_is_super_admin())
  with check (public.champion_is_super_admin());

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
