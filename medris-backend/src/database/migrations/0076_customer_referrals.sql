-- Migration:  0076_customer_referrals
-- Why:        Referral codes only existed for vendors. Customers can now have their own code, share it, and earn points when
--             someone joins with it - the same points rules vendors already follow (see points_rules). Points only for now.
-- Changes:    1. users.referral_code (new column, unique, one code per customer; also never equal to a vendor code).
--             2. referrals.referrer_vendor_id may be empty (a customer referrer has no shop).
--             3. generate_referral_code() makes sure the code is free in BOTH vendors and users.
--             4. apply_referral_internal() and validate_referral_code() accept a customer's code as well as a vendor's.
--             5. get_my_points_summary() gives customers their code and the name of whoever referred them.
--             6. A small trigger stops a signed-in customer from editing their own referral_code directly.
--             7. Every existing user gets a code now (one-time backfill below) and every new user gets one on sign-up.
--             8. A shop can no longer pick a code that a customer already has.
-- Applying:   run once by the engineer on production after review. Safe to re-run (if not exists / create or replace).
--             Rollback: re-run the functions from baseline/01-public-schema.sql, then
--               drop trigger if exists trg_users_new_referral_code on public.users; drop trigger if exists trg_vendor_referral_zcheck on public.vendors;
--               drop trigger if exists trg_users_keep_referral_code on public.users; drop function if exists public.trg_users_keep_referral_code();
--               alter table public.referrals alter column referrer_vendor_id set not null;  (only if no customer referrals exist yet)
--               drop index if exists users_referral_code_key; alter table public.users drop column if exists referral_code;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referral_code text;
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key ON public.users USING btree (referral_code);
ALTER TABLE public.referrals ALTER COLUMN referrer_vendor_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_users_keep_referral_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  -- Signed-in people (browser requests) can never change their code; the database functions (owner) can.
  if current_user in ('authenticated', 'anon') then NEW.referral_code := OLD.referral_code; end if;
  return NEW;
end $$;
DROP TRIGGER IF EXISTS trg_users_keep_referral_code ON public.users;
CREATE TRIGGER trg_users_keep_referral_code BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_users_keep_referral_code();

CREATE OR REPLACE FUNCTION public.generate_referral_code(p_name text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare v_base text; v_code text; v_try int := 0;
begin
  v_base := upper(left(regexp_replace(coalesce(p_name,''), '[^A-Za-z0-9]', '', 'g'), 5));
  if length(v_base) < 3 then v_base := 'LEVRO'; end if;
  loop
    v_code := v_base || lpad((floor(random()*900)+100)::int::text, 3, '0');
    v_try := v_try + 1;
    if v_try > 20 then v_code := v_base || substr(upper(md5(random()::text)), 1, 5); end if;
    exit when not exists (select 1 from public.vendors where referral_code = v_code)
          and not exists (select 1 from public.users where referral_code = v_code);
  end loop;
  return v_code;
end $$;

-- Every new user gets a code on sign-up ...
CREATE OR REPLACE FUNCTION public.trg_users_new_referral_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if NEW.referral_code is null or NEW.referral_code = '' then NEW.referral_code := public.generate_referral_code(NEW.name); end if;
  return NEW;
end $$;
DROP TRIGGER IF EXISTS trg_users_new_referral_code ON public.users;
CREATE TRIGGER trg_users_new_referral_code BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.trg_users_new_referral_code();

-- ... and everyone who is already here gets one now (one time; people who have a code are skipped).
DO $$
declare r record;
begin
  for r in select id, name from public.users where referral_code is null loop
    update public.users set referral_code = public.generate_referral_code(r.name) where id = r.id and referral_code is null;
  end loop;
end $$;

-- A shop cannot pick a code a customer already has (generate_referral_code already avoids it).
CREATE OR REPLACE FUNCTION public.trg_vendor_code_free_of_users() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if NEW.referral_code is not null and NEW.referral_code is distinct from (case when tg_op = 'UPDATE' then OLD.referral_code end)
     and exists (select 1 from public.users where referral_code = NEW.referral_code) then
    raise exception 'That referral code is already in use.';
  end if;
  return NEW;
end $$;
DROP TRIGGER IF EXISTS trg_vendor_referral_zcheck ON public.vendors;
CREATE TRIGGER trg_vendor_referral_zcheck BEFORE INSERT OR UPDATE OF referral_code ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.trg_vendor_code_free_of_users();

CREATE OR REPLACE FUNCTION public.validate_referral_code(p_code text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v record; c text := upper(regexp_replace(coalesce(p_code,''), '\s', '', 'g'));
begin
  if length(c) < 4 then return jsonb_build_object('valid', false); end if;
  select business_name, logo_url into v from public.vendors where referral_code = c and deleted_at is null and is_active = true;
  if found then return jsonb_build_object('valid', true, 'business_name', v.business_name, 'logo_url', v.logo_url); end if;
  select coalesce(nullif(split_part(coalesce(name,''),' ',1),''),'A Levromart member') as business_name, avatar_url as logo_url
    into v from public.users where referral_code = c;
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', true, 'business_name', v.business_name, 'logo_url', v.logo_url);
end $$;

CREATE OR REPLACE FUNCTION public.apply_referral_internal(p_uid uuid, p_code text, p_skip_customer boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  u record; v record; vu record; c text := upper(regexp_replace(coalesce(p_code,''), '\s', '', 'g'));
  ref2 record; is_vendor_acct boolean; r_user uuid; r_vendor uuid; r_name text; r_phone text;
begin
  if p_uid is null or c = '' then return jsonb_build_object('ok', false, 'error', 'no_code'); end if;
  select * into u from public.users where id = p_uid;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if exists (select 1 from public.referrals where referred_user_id = p_uid and code <> 'VOID') then
    return jsonb_build_object('ok', false, 'error', 'already_used', 'message', 'You have already used a referral code.');
  end if;
  if u.created_at < now() - interval '7 days' then
    return jsonb_build_object('ok', false, 'error', 'too_late', 'message', 'Referral codes can only be added within 7 days of creating your account.');
  end if;
  select * into v from public.vendors where referral_code = c and deleted_at is null and is_active = true;
  if found then
    r_user := v.user_id; r_vendor := v.id; r_name := v.business_name;
  else
    select * into vu from public.users where referral_code = c;
    if not found then return jsonb_build_object('ok', false, 'error', 'invalid', 'message', 'That referral code was not found.'); end if;
    r_user := vu.id; r_vendor := null; r_name := coalesce(nullif(split_part(coalesce(vu.name,''),' ',1),''),'A Levromart member');
  end if;
  select phone into r_phone from public.users where id = r_user;
  if r_user = p_uid or (coalesce(u.phone,'') <> '' and u.phone = r_phone) then
    return jsonb_build_object('ok', false, 'error', 'own_code', 'message', 'You cannot use your own referral code.');
  end if;
  insert into public.referrals (referred_user_id, referrer_user_id, referrer_vendor_id, code)
  values (p_uid, r_user, r_vendor, c)
  on conflict (referred_user_id) do update set referrer_user_id = excluded.referrer_user_id,
    referrer_vendor_id = excluded.referrer_vendor_id, code = excluded.code, vendor_awarded = false, created_at = now()
  where public.referrals.code = 'VOID';
  is_vendor_acct := exists (select 1 from public.vendors where user_id = p_uid);
  if not p_skip_customer and u.role::text = 'buyer' and not is_vendor_acct then
    perform public.award_points(r_user, 'ref_customer', 'refc:' || p_uid, p_uid, 'Customer joined with your code');
    select * into ref2 from public.referrals where referred_user_id = r_user and code <> 'VOID';
    if found then
      perform public.award_points(ref2.referrer_user_id, 'ref2_customer', 'refc2:' || p_uid, p_uid, 'Your referred member brought in a customer');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'business_name', r_name);
end $$;

CREATE OR REPLACE FUNCTION public.get_my_points_summary() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  uid uuid := auth.uid(); v record; cur date := public.points_week_start();
  tz text := 'Africa/Lagos'; today date := (now() at time zone 'Africa/Lagos')::date;
  s_today bigint; s_week bigint; s_month bigint; s_all bigint;
  my_rank int; nxt_name text; nxt_pts bigint; lead_pts bigint; total_v int;
  bd_all jsonb; bd_week jsonb; daily jsonb; weekly jsonb; streak int := 0; d date; refs jsonb; socials jsonb; won int;
begin
  if uid is null then return jsonb_build_object('signed_in', false); end if;
  select * into v from public.vendors where user_id = uid and deleted_at is null limit 1;
  select coalesce(sum(points) filter (where (created_at at time zone tz)::date = today),0),
         coalesce(sum(points) filter (where week_start = cur),0),
         coalesce(sum(points) filter (where created_at >= (date_trunc('month', now() at time zone tz) at time zone tz)),0),
         coalesce(sum(points),0)
    into s_today, s_week, s_month, s_all from public.points_ledger where user_id = uid;

  if v.id is not null then
    select t.rank into my_rank from public.get_points_leaderboard('week', 300) t where t.is_me limit 1;
    select count(*) into total_v from public.get_points_leaderboard('week', 300);
    if my_rank is not null and my_rank > 1 then
      select t.business_name, t.points into nxt_name, nxt_pts from public.get_points_leaderboard('week', 300) t where t.rank = my_rank - 1;
    end if;
    select max(t.points) into lead_pts from public.get_points_leaderboard('week', 1) t;
  end if;

  select coalesce(jsonb_agg(x order by (x->>'points')::int desc), '[]'::jsonb) into bd_all from (
    select jsonb_build_object('kind', l.kind, 'label', coalesce(r.label, initcap(replace(l.kind,'_',' '))), 'icon', coalesce(r.icon,'fa-star'),
           'points', sum(l.points), 'count', count(*)) x
      from public.points_ledger l left join public.points_rules r on r.kind = l.kind where l.user_id = uid group by l.kind, r.label, r.icon) t;
  select coalesce(jsonb_agg(x order by (x->>'points')::int desc), '[]'::jsonb) into bd_week from (
    select jsonb_build_object('kind', l.kind, 'label', coalesce(r.label, initcap(replace(l.kind,'_',' '))), 'icon', coalesce(r.icon,'fa-star'),
           'points', sum(l.points), 'count', count(*)) x
      from public.points_ledger l left join public.points_rules r on r.kind = l.kind where l.user_id = uid and l.week_start = cur group by l.kind, r.label, r.icon) t;

  select jsonb_agg(jsonb_build_object('date', g.d, 'points', coalesce(p.pts,0)) order by g.d) into daily
    from (select (today - n) d from generate_series(0, 13) n) g
    left join (select (created_at at time zone tz)::date d, sum(points) pts from public.points_ledger
                where user_id = uid and created_at > now() - interval '16 days' group by 1) p on p.d = g.d;
  select jsonb_agg(jsonb_build_object('week_start', g.w, 'points', coalesce(p.points,0)) order by g.w) into weekly
    from (select (cur - 7 * n) w from generate_series(0, 7) n) g
    left join public.points_weekly p on p.user_id = uid and p.week_start = g.w;

  d := today;
  if not exists (select 1 from public.points_ledger where user_id = uid and points > 0 and (created_at at time zone tz)::date = d) then d := d - 1; end if;
  while streak < 400 and exists (select 1 from public.points_ledger where user_id = uid and points > 0 and (created_at at time zone tz)::date = d) loop
    streak := streak + 1; d := d - 1;
  end loop;

  select count(*) into won from public.vendor_week_winners where user_id = uid and reward_status <> 'void';

  select jsonb_build_object(
    'referred_customers', (select count(*) from public.referrals r where r.referrer_user_id = uid and r.code <> 'VOID' and not exists (select 1 from public.vendors vv where vv.user_id = r.referred_user_id)),
    'referred_vendors', (select count(*) from public.referrals r where r.referrer_user_id = uid and r.code <> 'VOID' and exists (select 1 from public.vendors vv where vv.user_id = r.referred_user_id)),
    'second_level', (select count(*) from public.referrals r2 where r2.code <> 'VOID' and r2.referrer_user_id in (select referred_user_id from public.referrals where referrer_user_id = uid and code <> 'VOID')),
    'points_earned', coalesce((select sum(points) from public.points_ledger where user_id = uid and kind in ('ref_vendor','ref_customer','ref2_vendor','ref2_customer','ref_vendor_product','ref_social')),0),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(nullif(split_part(coalesce(u.name,''),' ',1),''),'New member'),
                'role', case when exists (select 1 from public.vendors vv where vv.user_id = rr.referred_user_id) then 'vendor' else 'customer' end,
                'at', rr.created_at) order by rr.created_at desc)
               from (select * from public.referrals where referrer_user_id = uid and code <> 'VOID' order by created_at desc limit 8) rr
               join public.users u on u.id = rr.referred_user_id), '[]'::jsonb),
    'referred_by', coalesce(
        (select vv.business_name from public.referrals rf join public.vendors vv on vv.id = rf.referrer_vendor_id where rf.referred_user_id = uid and rf.code <> 'VOID'),
        (select coalesce(nullif(split_part(coalesce(uu.name,''),' ',1),''),'A Levromart member') from public.referrals rf join public.users uu on uu.id = rf.referrer_user_id where rf.referred_user_id = uid and rf.code <> 'VOID'))
  ) into refs;

  select coalesce(jsonb_agg(substring(event_key from 8)), '[]'::jsonb) into socials from public.points_ledger where user_id = uid and event_key like 'social:%';

  return jsonb_build_object(
    'signed_in', true, 'is_vendor', v.id is not null, 'vendor_id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url,
    'referral_code', coalesce(v.referral_code, (select referral_code from public.users where id = uid)),
    'today', s_today, 'week', s_week, 'month', s_month, 'all', s_all,
    'rank', my_rank, 'vendor_total', total_v, 'week_leader_points', lead_pts,
    'next_name', nxt_name, 'next_points', nxt_pts,
    'breakdown_all', bd_all, 'breakdown_week', bd_week, 'daily', daily, 'weekly', weekly,
    'streak', streak, 'weeks_won', won, 'referrals', coalesce(refs, '{}'::jsonb), 'socials', socials,
    'week_start', cur, 'week_ends_at', ((cur + 7)::timestamp at time zone tz));
end $$;
