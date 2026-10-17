-- =============================================================================
-- 0004  live updates for the backend: row changes announced with NOTIFY  NOT YET APPLIED
-- =============================================================================
-- Status: written for review. Do not run against production without approval.
-- Effect: one trigger function and one AFTER trigger per table below. Changes no
-- table, row, policy or existing function. Supabase Realtime keeps working as
-- before (it reads the write-ahead log, not these notifications).
--
-- The backend's live endpoint (/api/v1/live, replaces sb.channel(...)
-- postgres_changes) LISTENs on channel 'backend_live'. Each committed insert,
-- update or delete on these tables sends a small message: the table, the kind
-- of change, the primary key and the row's id columns (no other data - the
-- backend re-reads the row as each subscriber, so row-level security decides
-- who sees it, as Realtime does). NOTIFY is delivered only on commit; a rolled-
-- back change sends nothing.
--
-- Tables: the 22 in the supabase_realtime publication (except inventory,
-- retired by an earlier clean-up plan; not live), plus package_comments, which the app subscribes to but
-- which was never added to the publication (finding B15: package comments
-- never updated live).
--
-- Roll back:
--   do $$ declare t text; begin
--     foreach t in array array['disputes','equipment_requests','favorites','messages','monthly_listing_submissions',
--       'notifications','order_items','order_notes','orders','package_comment_likes','package_comments','payments',
--       'points_weekly','product_comment_likes','product_comments','product_variants','products','request_offers',
--       'service_offers','vendor_follows','vendor_packages','vendors'] loop
--       execute format('drop trigger if exists backend_live_notify on public.%I', t);
--     end loop; end $$;
--   drop function if exists public.backend_live_notify();
-- =============================================================================

create or replace function public.backend_live_notify()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- trigger argument: the primary key columns, comma separated
  pk text[] := string_to_array(tg_argv[0], ',');
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
begin
  perform pg_catalog.pg_notify('backend_live', pg_catalog.jsonb_build_object(
    't', tg_table_name,
    'op', tg_op,
    'at', pg_catalog.now(),
    'new', (select pg_catalog.jsonb_object_agg(key, value) from pg_catalog.jsonb_each(new_row)
             where (key = any(pk) or key = 'id' or key like '%\_id') and pg_catalog.length(value::text) <= 100),
    'old', (select pg_catalog.jsonb_object_agg(key, value) from pg_catalog.jsonb_each(old_row)
             where (key = any(pk) or key = 'id' or key like '%\_id') and pg_catalog.length(value::text) <= 100)
  )::text);
  return null;
end
$$;

revoke all on function public.backend_live_notify() from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('disputes', 'id'), ('equipment_requests', 'id'), ('favorites', 'id'), ('messages', 'id'),
      ('monthly_listing_submissions', 'id'), ('notifications', 'id'), ('order_items', 'id'), ('order_notes', 'id'),
      ('orders', 'id'), ('package_comment_likes', 'id'), ('package_comments', 'id'), ('payments', 'id'),
      ('points_weekly', 'user_id,week_start'), ('product_comment_likes', 'id'), ('product_comments', 'id'),
      ('product_variants', 'id'), ('products', 'id'), ('request_offers', 'id'), ('service_offers', 'id'),
      ('vendor_follows', 'id'), ('vendor_packages', 'id'), ('vendors', 'id')
    ) as x(name, pk)
  loop
    if to_regclass('public.' || t.name) is not null then
      execute format('drop trigger if exists backend_live_notify on public.%I', t.name);
      execute format('create trigger backend_live_notify after insert or update or delete on public.%I for each row execute function public.backend_live_notify(%L)', t.name, t.pk);
    end if;
  end loop;
end $$;
