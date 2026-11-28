-- Migration:  0077_points_to_wallet
-- Why:        Members can turn the points they have earned into money in their Levromart wallet: 1 point = ₦1, at most
--             100 points a day, and only points that are at least 24 hours old (so points that are taken back after a
--             cancelled order cannot already have been cashed).
-- Changes:    1. public.points_cashouts: one row per conversion (points, naira, the wallet line it created).
--             2. wallet_entries.kind may now be 'points_in'.
--             3. get_points_cashout_status(): what the caller can convert right now.
--             4. convert_points_to_wallet(points): checks the rules, takes the points, credits the wallet - one transaction.
-- Money:      This creates wallet balance that is not backed by a payment. It is a Levromart marketing cost (up to ₦100 per
--             member per day). The engineer should decide how it is funded / booked; nothing is written to the platform wallet.
-- Applying:   run once by the engineer on production after review. Safe to re-run.
--             Rollback: drop function public.convert_points_to_wallet(integer); drop function public.get_points_cashout_status();
--             drop table public.points_cashouts (only if empty; converted money stays in wallets either way);
--             put the wallet_entries kind check back from 0037.

CREATE TABLE IF NOT EXISTS public.points_cashouts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  points          integer not null check (points > 0),
  amount_kobo     bigint not null check (amount_kobo > 0),
  wallet_entry_id uuid references public.wallet_entries (id) on delete set null,
  created_at      timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS points_cashouts_user_idx ON public.points_cashouts (user_id, created_at DESC);
ALTER TABLE public.points_cashouts ENABLE ROW LEVEL SECURITY;
-- no policies: people reach it only through the two functions below

ALTER TABLE public.wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
ALTER TABLE public.wallet_entries ADD CONSTRAINT wallet_entries_kind_check
  CHECK (kind in ('topup', 'transfer_in', 'transfer_out', 'order_payment', 'refund_in', 'refund_out', 'earnings_in', 'withdrawal', 'withdrawal_return', 'fee', 'fee_return', 'points_in'));

-- What can be converted now (internal; used by both functions).
CREATE OR REPLACE FUNCTION public.points_cashout_state(p_uid uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  daily_limit constant int := 100;
  tz constant text := 'Africa/Lagos';
  total_pts bigint; settled bigint; cashed bigint; today_cashed bigint; avail bigint; can int;
begin
  select coalesce(sum(points), 0), coalesce(sum(points) filter (where created_at <= now() - interval '24 hours'), 0)
    into total_pts, settled from public.points_ledger where user_id = p_uid;
  select coalesce(sum(points), 0), coalesce(sum(points) filter (where (created_at at time zone tz)::date = (now() at time zone tz)::date), 0)
    into cashed, today_cashed from public.points_cashouts where user_id = p_uid;
  avail := greatest(0, settled - cashed);
  can := greatest(0, least(avail, daily_limit - today_cashed))::int;
  return jsonb_build_object('balance', greatest(0, total_pts - cashed), 'available', avail, 'waiting', greatest(0, total_pts - cashed - avail),
    'daily_limit', daily_limit, 'converted_today', today_cashed, 'can_convert', can, 'naira_per_point', 1);
end $$;
REVOKE ALL ON FUNCTION public.points_cashout_state(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_cashout_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_points_cashout_status() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then return jsonb_build_object('signed_in', false); end if;
  return jsonb_build_object('signed_in', true) || public.points_cashout_state(auth.uid());
end $$;
GRANT ALL ON FUNCTION public.get_points_cashout_status() TO authenticated;
GRANT ALL ON FUNCTION public.get_points_cashout_status() TO service_role;

CREATE OR REPLACE FUNCTION public.convert_points_to_wallet(p_points integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  uid uuid := auth.uid(); st jsonb; can int; kobo bigint; acct record; bal bigint; cid uuid := gen_random_uuid(); eid uuid;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_signed_in'); end if;
  if p_points is null or p_points <= 0 then return jsonb_build_object('ok', false, 'error', 'bad_points', 'message', 'Enter how many points to convert.'); end if;
  -- one conversion at a time per person (two taps, two tabs)
  perform pg_advisory_xact_lock(hashtext('points_cashout:' || uid::text));
  insert into public.wallet_accounts (user_id, handle)
    select u.id, public.wallet_make_handle(u.name, u.id) from public.users u where u.id = uid on conflict do nothing;
  select * into acct from public.wallet_accounts where user_id = uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_wallet', 'message', 'Your wallet is not ready yet.'); end if;
  if acct.frozen then return jsonb_build_object('ok', false, 'error', 'frozen', 'message', 'Your wallet is on hold. Please contact Levromart.'); end if;
  st := public.points_cashout_state(uid);
  can := (st->>'can_convert')::int;
  if can <= 0 then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_convert', 'message',
      case when (st->>'converted_today')::int >= (st->>'daily_limit')::int then 'You have converted the most you can today. Come back tomorrow.'
           else 'You have no points ready to convert yet. Points can be converted 24 hours after you earn them.' end);
  end if;
  if p_points > can then
    return jsonb_build_object('ok', false, 'error', 'too_many', 'message', 'You can convert up to ' || can || ' points right now.', 'can_convert', can);
  end if;
  kobo := p_points::bigint * 100;
  update public.wallet_accounts set balance_kobo = balance_kobo + kobo, updated_at = now() where user_id = uid returning balance_kobo into bal;
  insert into public.wallet_entries (user_id, kind, amount_kobo, balance_after_kobo, reference, note)
    values (uid, 'points_in', kobo, bal, 'points:' || cid::text, p_points || ' points converted to cash') returning id into eid;
  insert into public.points_cashouts (id, user_id, points, amount_kobo, wallet_entry_id) values (cid, uid, p_points, kobo, eid);
  return jsonb_build_object('ok', true, 'points', p_points, 'amount_kobo', kobo, 'balance_kobo', bal) || public.points_cashout_state(uid);
end $$;
GRANT ALL ON FUNCTION public.convert_points_to_wallet(integer) TO authenticated;
GRANT ALL ON FUNCTION public.convert_points_to_wallet(integer) TO service_role;
