# Add email/phone + a Draft ID to abandoned-application tracking

You've already run the earlier `add-draft-tracking-and-rate-limit.md`
migration, so `champion_application_drafts` already exists. Paste this
into **SQL Editor -> New query** and click **Run** to add:

- `draft_number` -- a human-readable ID like `DRAFT-2026-00001`, the same
  idea as your `MOBI-2026-00001` application numbers.
- `email` and `phone` columns -- captured once the applicant has typed
  them in, so you can follow up with people who started but never
  finished. Full name is still never captured here.

```sql
alter table public.champion_application_drafts
  add column if not exists draft_number text,
  add column if not exists email text,
  add column if not exists phone text;

create unique index if not exists champion_application_drafts_draft_number_idx
  on public.champion_application_drafts (draft_number) where draft_number is not null;

create sequence if not exists champion_draft_seq;

create or replace function public.champion_next_draft_number()
returns text
language sql
set search_path = public
as $$
  select 'DRAFT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('champion_draft_seq')::text, 5, '0');
$$;

drop function if exists public.champion_track_draft(text, text, text, int, boolean);

create or replace function public.champion_track_draft(
  p_session_id text,
  p_institution text,
  p_primary_track text,
  p_step int,
  p_completed boolean,
  p_email text default null,
  p_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft_number text;
begin
  if p_session_id is null or length(trim(p_session_id)) = 0 then
    return;
  end if;

  select draft_number into v_draft_number
  from public.champion_application_drafts
  where session_id = p_session_id;

  if v_draft_number is null then
    v_draft_number := public.champion_next_draft_number();
  end if;

  insert into public.champion_application_drafts
    (session_id, draft_number, institution, primary_track, current_step, completed, email, phone)
  values
    (p_session_id, v_draft_number, p_institution, p_primary_track, p_step, coalesce(p_completed, false), p_email, p_phone)
  on conflict (session_id) do update
    set institution = coalesce(excluded.institution, public.champion_application_drafts.institution),
        primary_track = coalesce(excluded.primary_track, public.champion_application_drafts.primary_track),
        current_step = greatest(coalesce(excluded.current_step, 0), coalesce(public.champion_application_drafts.current_step, 0)),
        completed = public.champion_application_drafts.completed or excluded.completed,
        email = coalesce(excluded.email, public.champion_application_drafts.email),
        phone = coalesce(excluded.phone, public.champion_application_drafts.phone),
        last_activity_at = now();
end;
$$;

grant execute on function public.champion_track_draft(text, text, text, int, boolean, text, text) to anon, authenticated;

-- Optional: backfill a draft number for the test row(s) you already created,
-- so nothing shows up blank in the admin table.
update public.champion_application_drafts
set draft_number = 'DRAFT-' || to_char(started_at, 'YYYY') || '-' || lpad(nextval('champion_draft_seq')::text, 5, '0')
where draft_number is null;
```
