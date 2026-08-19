# Add MTCP fields (institution, tracks, leadership)

Paste this into **SQL Editor → New query** in your Supabase project and
click **Run**. It adds the new columns the updated form needs — existing
applications are untouched (new columns just come back empty for them).

```sql
alter table public.champion_applications
  add column if not exists institution text,
  add column if not exists primary_track text,
  add column if not exists secondary_tracks text[],
  add column if not exists wants_leadership boolean default false,
  add column if not exists leadership_role_interest text,
  add column if not exists leadership_experience text,
  add column if not exists why_lead text,
  add column if not exists leadership_idea text;

create index if not exists champion_applications_institution_idx
  on public.champion_applications (institution);
```
