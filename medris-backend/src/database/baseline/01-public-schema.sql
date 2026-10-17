--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: delivery_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_method AS ENUM (
    'pickup',
    'delivery'
);


--
-- Name: dispute_raised_by; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_raised_by AS ENUM (
    'buyer',
    'vendor'
);


--
-- Name: dispute_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_status AS ENUM (
    'open',
    'resolved'
);


--
-- Name: listing_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.listing_type AS ENUM (
    'rent',
    'sale',
    'both'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'confirmed',
    'handed_over',
    'returned',
    'completed',
    'cancelled',
    'disputed',
    'payment_unresolved'
);


--
-- Name: order_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_type AS ENUM (
    'rental',
    'sale'
);


--
-- Name: payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method AS ENUM (
    'card',
    'transfer',
    'cash'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'pending',
    'paid',
    'refunded'
);


--
-- Name: payment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_type AS ENUM (
    'sale_price',
    'rental_fee',
    'deposit',
    'delivery_deposit_20'
);


--
-- Name: product_condition; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.product_condition AS ENUM (
    'new',
    'used-good',
    'used-fair'
);


--
-- Name: product_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.product_status AS ENUM (
    'active',
    'paused',
    'removed'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'buyer',
    'vendor',
    'admin'
);


--
-- Name: vendor_verification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vendor_verification_status AS ENUM (
    'pending',
    'verified',
    'rejected'
);


--
-- Name: accept_legal_terms(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_legal_terms() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_version constant text := '2026-10-02';
  accepted_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.users set legal_terms_version = current_version, legal_terms_accepted_at = accepted_at where id = auth.uid();
  if not found then raise exception 'Account profile not found'; end if;
  return jsonb_build_object('accepted', true, 'version', current_version, 'accepted_at', accepted_at);
end;
$$;


--
-- Name: accept_request_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_request_offer(p_offer_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_request_id uuid;
  v_buyer_id uuid;
begin
  select o.request_id, r.buyer_id into v_request_id, v_buyer_id
  from request_offers o join equipment_requests r on r.id = o.request_id
  where o.id = p_offer_id;

  if v_request_id is null then
    raise exception 'Offer not found';
  end if;
  if v_buyer_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;

  update request_offers set status = 'accepted' where id = p_offer_id;
  update request_offers set status = 'declined' where request_id = v_request_id and id <> p_offer_id and status = 'pending';
  update equipment_requests set status = 'fulfilled' where id = v_request_id;
end;
$$;


--
-- Name: add_order_note(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_order_note(p_order_id uuid, p_body text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.orders%rowtype;
  v_vendor_user uuid;
  v_is_buyer boolean;
  v_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 500 then
    raise exception 'Notes must be between 1 and 500 characters.' using errcode = '22023';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Order not found.' using errcode = '22023'; end if;
  select user_id into v_vendor_user from public.vendors where id = v_order.vendor_id;
  v_is_buyer := (v_order.buyer_id = auth.uid());
  if not v_is_buyer and v_vendor_user is distinct from auth.uid() then
    raise exception 'Not your order.' using errcode = '42501';
  end if;
  if v_order.status in ('completed', 'cancelled') then
    raise exception 'This order is closed, so notes can no longer be sent.' using errcode = '22023';
  end if;
  if (select count(*) from public.order_notes where order_id = p_order_id and sender_id = auth.uid()) >= 10 then
    raise exception 'You have reached the note limit for this order.' using errcode = '22023';
  end if;
  insert into public.order_notes (order_id, sender_id, body) values (p_order_id, auth.uid(), v_body) returning id into v_id;
  perform public.create_notification(
    case when v_is_buyer then v_vendor_user else v_order.buyer_id end,
    'order_note',
    case when v_is_buyer then 'Note on an order' else 'Vendor replied to your note' end,
    left(v_body, 80),
    'orderDetail',
    jsonb_build_object('orderId', p_order_id),
    null
  );
  return v_id;
end $$;


--
-- Name: add_to_cart(uuid, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_to_cart(p_product_id uuid, p_quantity integer DEFAULT 1, p_variant_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_listing text;
  v_vendor_user_id uuid;
  v_variant_product_id uuid;
  v_existing_qty int;
begin
  if is_admin() then raise exception 'Admin accounts cannot make purchases on Levromart.'; end if;
  if p_quantity is null or p_quantity < 1 then p_quantity := 1; end if;

  select p.listing_type, v.user_id
    into v_listing, v_vendor_user_id
  from products p
  join vendors v on v.id = p.vendor_id
  where p.id = p_product_id and p.status = 'active' and p.is_service = false
    and v.verification_status = 'verified' and v.is_active = true;
  if v_listing is null then raise exception 'This product is not available to add to cart right now.'; end if;
  if v_vendor_user_id = auth.uid() then raise exception 'You can''t buy from your own shop.'; end if;
  if v_listing = 'rent' then raise exception 'Rentals need dates picked on the product page, they can''t be added to a cart.'; end if;

  if p_variant_id is not null then
    select product_id into v_variant_product_id from product_variants where id = p_variant_id;
    if v_variant_product_id is distinct from p_product_id then raise exception 'invalid product variety'; end if;
  end if;

  select quantity into v_existing_qty
  from cart_items
  where buyer_id = auth.uid() and product_id = p_product_id and variant_id is not distinct from p_variant_id;

  -- Buyers are no longer capped to the current stock count when adding to
  -- cart -- see create_sale_order's own comment for the reasoning. The
  -- vendor, not a raw number, decides whether an order can be fulfilled.
  if found then
    update cart_items
       set quantity = cart_items.quantity + p_quantity
     where buyer_id = auth.uid() and product_id = p_product_id and variant_id is not distinct from p_variant_id;
  else
    insert into cart_items (buyer_id, product_id, variant_id, quantity)
    values (auth.uid(), p_product_id, p_variant_id, p_quantity);
  end if;
end;
$$;


--
-- Name: admin_adjust_points(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_adjust_points(p_user uuid, p_points integer, p_note text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r int; n text := coalesce(nullif(trim(p_note), ''), 'Adjustment by Levromart');
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_points is null or p_points = 0 then return jsonb_build_object('ok', false, 'error', 'bad_points', 'message', 'Enter a number of points.'); end if;
  if abs(p_points) > 10000 then return jsonb_build_object('ok', false, 'error', 'too_big', 'message', 'That is too many points in one go.'); end if;
  if not exists (select 1 from public.users where id = p_user) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  r := public.award_points(p_user, 'admin_adjustment', 'admin:' || gen_random_uuid(), auth.uid(), n, '{}'::jsonb, p_points, false);
  perform public.create_notification(p_user, 'points', (case when p_points > 0 then '+' else '' end) || p_points || ' points', n, 'leaderboard', '{"tab":"activity"}'::jsonb, null);
  return jsonb_build_object('ok', true, 'applied', r);
end $$;


--
-- Name: admin_approve_manual_password_reset(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_approve_manual_password_reset(p_request_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not exists (select 1 from public.users u where u.id=auth.uid() and u.role::text='admin' and coalesce(u.is_super_admin,false)) then
    raise exception 'Super admin access required.';
  end if;
  update public.password_reset_requests
  set status='approved',approved_at=now(),approved_by=auth.uid()
  where id=p_request_id and status='pending' and expires_at >= now() and user_id is not null;
  if not found then raise exception 'Request is no longer pending, has expired, or the account was not found.'; end if;
  return true;
end;
$$;


--
-- Name: admin_approve_monthly_listing(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_approve_monthly_listing(p_submission_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s public.monthly_listing_submissions%rowtype; v_until timestamptz; v_name text; v_vendor_name text; v_user_id uuid;
begin
  if not exists(select 1 from public.users where id=auth.uid() and role='admin') then raise exception 'Admin access required.'; end if;
  select * into s from public.monthly_listing_submissions where id=p_submission_id for update;
  if s.id is null then raise exception 'Monthly listing submission not found.'; end if;
  if s.status <> 'pending' then raise exception 'This submission has already been reviewed.'; end if;
  v_until := now() + interval '1 month';
  if s.kind='product' then
    select name into v_name from public.products where id=s.listing_id and vendor_id=s.vendor_id;
    if v_name is null then raise exception 'Product no longer exists.'; end if;
    update public.products set status='active',billing_status='active',billing_paid_until=v_until,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  else
    select name into v_name from public.vendor_packages where id=s.listing_id and vendor_id=s.vendor_id;
    if v_name is null then raise exception 'Package no longer exists.'; end if;
    update public.vendor_packages set status='active',billing_status='active',billing_paid_until=v_until,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  end if;
  update public.monthly_listing_submissions set status='approved',reviewed_at=now(),reviewed_by=auth.uid(),updated_at=now() where id=s.id;
  select business_name,user_id into v_vendor_name,v_user_id from public.vendors where id=s.vendor_id;
  insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label) select auth.uid(),u.name,'Approved monthly listing payment','monthly_listing',s.listing_id,v_name from public.users u where u.id=auth.uid();
  insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,vendor_id,notification_category,metadata)
  values(v_user_id,'monthly_listing_approved','Monthly listing activated','Your ₦1,000 monthly payment for '||v_name||' was approved. Your listing is active for one month.','vendorProducts',jsonb_build_object('listingId',s.listing_id,'kind',s.kind),auth.uid(),(select name from public.users where id=auth.uid()),s.vendor_id,'system',jsonb_build_object('submission_id',s.id,'listing_id',s.listing_id,'kind',s.kind,'paid_until',v_until));
  return jsonb_build_object('ok',true,'listing_id',s.listing_id,'kind',s.kind,'paid_until',v_until);
end; $$;


--
-- Name: admin_approve_vendor(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_user public.users%rowtype;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can approve vendors.' using errcode='42501';
  end if;
  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is null for update;
  if not found then raise exception 'Vendor not found.' using errcode='P0002'; end if;
  select * into v_user from public.users where id=v_vendor.user_id for update;
  if not found then raise exception 'Vendor account profile not found.' using errcode='P0002'; end if;
  v_name := coalesce(v_vendor.business_name,'this business');

  if not p_approve_without_payout and nullif(trim(coalesce(v_vendor.paystack_subaccount_code,'')),'') is null then
    if nullif(trim(coalesce(v_vendor.bank_name,'')),'') is null
       or nullif(trim(coalesce(v_vendor.bank_code,'')),'') is null
       or nullif(trim(coalesce(v_vendor.account_number,'')),'') is null then
      raise exception 'This vendor does not have complete payout details.' using errcode='22023';
    end if;
  end if;

  update public.vendors
  set verification_status='verified'::public.vendor_verification_status,
      is_active=true,
      admin_paused=false,
      avg_rating=coalesce(avg_rating,0),
      review_count=coalesce(review_count,0)
  where id=p_vendor_id;

  update public.users set role='vendor', role_selected=true where id=v_vendor.user_id and role<>'admin';

  begin
    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name)
    values(v_vendor.user_id,'vendor_approved','Vendor application approved',
      case when p_approve_without_payout
        then 'Congratulations! '||v_name||' has been approved. Your Levromart vendor account is active. Complete payout setup later to receive payouts.'
        else 'Congratulations! '||v_name||' has been approved. Your Levromart vendor account is now active and your storefront is live.'
      end,
      'vendorDashboard','{}'::jsonb,v_actor,
      (select coalesce(name,email,'Levromart Admin') from public.users where id=v_actor));
  exception when others then
    raise warning 'Vendor approval notification failed: %', SQLERRM;
  end;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),
      case when p_approve_without_payout then 'approve_vendor_without_payout' else 'approve_vendor' end,
      'vendor',p_vendor_id,v_name);
  exception when others then
    raise warning 'Vendor admin-action audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object('success',true,'approved_without_payout',p_approve_without_payout,
    'vendor',jsonb_build_object('id',v_vendor.id,'user_id',v_vendor.user_id,'verification_status','verified','is_active',true),
    'user',jsonb_build_object('id',v_user.id,'role','vendor','role_selected',true));
end;
$$;


--
-- Name: admin_award_social_points(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_award_social_points(p_phone text, p_platform text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  pf text := lower(coalesce(p_platform,'')); digits text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  u record; n int; ref record; pts int; rpts int := 0;
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if pf not in ('instagram','tiktok','linkedin') then return jsonb_build_object('ok', false, 'error', 'bad_platform'); end if;
  if length(digits) < 10 then return jsonb_build_object('ok', false, 'error', 'bad_phone', 'message', 'Enter the full phone number.'); end if;
  select count(*) into n from public.users where right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = digits;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'No account uses that phone number.'); end if;
  if n > 1 then return jsonb_build_object('ok', false, 'error', 'ambiguous', 'message', 'More than one account uses that number.'); end if;
  select * into u from public.users where right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = digits;
  pts := public.award_points(u.id, 'social_follow', 'social:' || pf, null, 'Followed Levromart on ' || initcap(pf));
  select * into ref from public.referrals where referred_user_id = u.id and code <> 'VOID';
  if found then
    rpts := public.award_points(ref.referrer_user_id, 'ref_social', 'refsocial:' || pf || ':' || u.id, u.id, 'Your referral followed us on ' || initcap(pf));
  end if;
  return jsonb_build_object('ok', true, 'name', u.name, 'awarded', pts, 'referrer_awarded', rpts, 'already', pts = 0);
end $$;


--
-- Name: admin_campus_submissions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_campus_submissions() RETURNS TABLE(name_norm text, name text, requests integer, users_count bigint, vendors_count bigint, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not exists(select 1 from users u where u.id=auth.uid() and u.role='admin') then raise exception 'admin only'; end if;
  return query select s.name_norm,s.name,s.requests,
    (select count(*) from users u where u.campus_id like 'custom:%' and lv_norm_school(substr(u.campus_id,8))=s.name_norm),
    (select count(*) from vendors v where v.campus_id like 'custom:%' and lv_norm_school(substr(v.campus_id,8))=s.name_norm),
    s.created_at
  from campus_submissions s where s.status='pending' order by s.created_at;
end $$;


--
-- Name: admin_cancel_confirmed_overdue_order(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_cancel_confirmed_overdue_order(p_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_order public.orders%rowtype;
begin
  if v_uid is null or not exists(select 1 from public.users where id=v_uid and role='admin') then raise exception 'Admin access required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_order.status<>'confirmed' or v_order.payment_escalated_at is null then raise exception 'This order is not an overdue confirmed payment case.'; end if;
  if coalesce(v_order.status_changed_at,v_order.created_at)>now()-interval '24 hours' then raise exception 'This order has not been confirmed for 24 hours yet.'; end if;
  if exists(select 1 from public.payments where order_id=p_order_id and payment_type in ('sale_price','rental_fee') and status='paid') then raise exception 'This order has a verified payment and cannot be cancelled by this escalation action.'; end if;
  update public.orders set status='cancelled'::public.order_status,cancelled_at=coalesce(cancelled_at,now()),payment_escalated_at=null where id=p_order_id;
  perform public.create_notification(v_order.buyer_id,'order_cancelled','Order cancelled','This confirmed order was cancelled because payment was not verified after the 24-hour payment follow-up period.','orderDetail',jsonb_build_object('orderId',p_order_id),v_uid);
  perform public.create_notification((select user_id from public.vendors where id=v_order.vendor_id),'order_cancelled','Order cancelled','This confirmed order was cancelled because payment was not verified after the 24-hour payment follow-up period.','orderDetail',jsonb_build_object('orderId',p_order_id),v_uid);
  return jsonb_build_object('success',true,'status','cancelled');
end;
$$;


--
-- Name: admin_confirm_reported_payment(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_confirm_reported_payment(p_order_id uuid, p_admin_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype; v_dispute_id uuid; v_should_complete boolean:=false; v_await boolean:=false; v_offer_id uuid;
begin
  if not public.is_admin() then raise exception 'Only admins can verify payment claims.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update; if not found then raise exception 'Order not found.'; end if;
  select * into v_payment from public.payments where order_id=p_order_id and status='pending' and provider_reference in ('buyer_report','service_offer_report') order by created_at desc limit 1 for update; if v_payment.id is null then raise exception 'No pending reported payment was found.'; end if;
  update public.payments set status='paid'::public.payment_status,paid_at=coalesce(paid_at,now()),provider_reference='admin_confirmed' where id=v_payment.id;
  if v_payment.payment_type in ('sale_price','rental_fee') then
    if v_order.delivery_method='delivery' and v_order.payment_timing='pay_after' then v_should_complete:=exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid'); else v_should_complete:=true; end if;
    if v_should_complete and v_order.order_type<>'rental' and v_order.service_offer_id is null and coalesce(v_order.payout_status,'not_applicable')='not_applicable' then v_should_complete:=false; v_await:=true; update public.orders set status=case when status='payment_unresolved' then 'confirmed'::public.order_status else status end,payment_unresolved_at=null,payment_escalated_at=null,awaiting_confirmation_since=now() where id=p_order_id; end if;
    if v_should_complete then update public.orders set status='completed'::public.order_status,completed_at=coalesce(completed_at,now()),payment_unresolved_at=null,payment_escalated_at=null,awaiting_confirmation_since=null where id=p_order_id and status<>'cancelled'; elsif not v_await then update public.orders set status='confirmed'::public.order_status,payment_unresolved_at=null,payment_escalated_at=null where id=p_order_id; end if;
  elsif v_payment.payment_type='delivery_deposit_20' then update public.orders set status='confirmed'::public.order_status,payment_unresolved_at=null,payment_escalated_at=null where id=p_order_id; end if;
  if v_order.service_offer_id is not null and v_should_complete then select id into v_offer_id from public.service_offers where id=v_order.service_offer_id; if v_offer_id is not null then update public.service_offers set status='completed',completed_at=now(),updated_at=now() where id=v_offer_id; end if; end if;
  select id into v_dispute_id from public.disputes where order_id=p_order_id and status='open' order by created_at desc limit 1; if v_dispute_id is not null then update public.disputes set status='resolved',admin_notes=coalesce(p_admin_notes,'Payment claim verified by admin.') where id=v_dispute_id; end if;
  perform public.create_notification(v_order.buyer_id,'payment_confirmed','Payment verified by Levromart','Levromart verified the reported payment.'||case when v_should_complete then ' The order is now complete and ready for review.' when v_await then ' Please confirm once you have received your order. It completes automatically in 24 hours if no issue is reported.' else '' end,'orderDetail',jsonb_build_object('orderId',p_order_id,'reviewEligible',v_should_complete),null);
  return jsonb_build_object('success',true,'payment_id',v_payment.id,'order_completed',v_should_complete,'awaiting_buyer_confirmation',v_await);
end;$$;


--
-- Name: admin_deactivate_monthly_listing(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_deactivate_monthly_listing(p_submission_id uuid, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s public.monthly_listing_submissions%rowtype; v_name text; v_user_id uuid; v_admin_name text;
begin
  if not exists(select 1 from public.users where id=auth.uid() and role='admin') then raise exception 'Admin access required.'; end if;
  select * into s from public.monthly_listing_submissions where id=p_submission_id for update;
  if s.id is null then raise exception 'Monthly listing submission not found.'; end if;
  if s.kind='product' then
    select name into v_name from public.products where id=s.listing_id and vendor_id=s.vendor_id;
    update public.products set status='paused',billing_status='cancelled',billing_paid_until=null,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  else
    select name into v_name from public.vendor_packages where id=s.listing_id and vendor_id=s.vendor_id;
    update public.vendor_packages set status='paused',billing_status='cancelled',billing_paid_until=null,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  end if;
  update public.monthly_listing_submissions set status='deactivated',reviewed_at=now(),reviewed_by=auth.uid(),review_note=nullif(trim(coalesce(p_note,'')),''),updated_at=now() where id=s.id;
  select name into v_admin_name from public.users where id=auth.uid();
  insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label) values(auth.uid(),v_admin_name,'Deactivated monthly listing','monthly_listing',s.listing_id,v_name);
  select user_id into v_user_id from public.vendors where id=s.vendor_id;
  insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,vendor_id,notification_category,metadata)
  values(v_user_id,'monthly_listing_deactivated','Monthly listing deactivated','Your monthly listing '||coalesce(v_name,'')||' was deactivated by an administrator.'||case when nullif(trim(coalesce(p_note,'')),'') is not null then ' Note: '||trim(p_note) else '' end,'vendorProducts',jsonb_build_object('listingId',s.listing_id,'kind',s.kind),auth.uid(),v_admin_name,s.vendor_id,'system',jsonb_build_object('submission_id',s.id,'listing_id',s.listing_id,'kind',s.kind));
  return jsonb_build_object('ok',true);
end; $$;


--
-- Name: admin_delete_inventory_product(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_inventory_product(p_product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_actor uuid := auth.uid(); v_product public.products%rowtype; v_name text; v_has_history boolean;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can delete inventory products.' using errcode='42501';
  end if;
  select * into v_product from public.products where id=p_product_id and admin_deleted_at is null for update;
  if not found then raise exception 'Product not found in inventory.' using errcode='P0002'; end if;
  v_name := coalesce(v_product.name,'Unnamed product');
  select exists(select 1 from public.order_items oi where oi.product_id=p_product_id) into v_has_history;
  if not v_has_history then
    delete from public.products where id=p_product_id;
    begin perform public.create_notification(v_actor,'admin_inventory_product_deleted','Inventory product deleted','Product “'||v_name||'” was permanently deleted from inventory.','adminInventory','{}'::jsonb,v_actor); exception when others then null; end;
    return jsonb_build_object('deleted',true,'permanent',true,'product_id',p_product_id,'product_name',v_name);
  end if;
  update public.products set status='removed', admin_deleted_at=now(), admin_deleted_by=v_actor where id=p_product_id;
  begin perform public.create_notification(v_actor,'admin_inventory_product_deleted','Inventory product removed','Product “'||v_name||'” was removed from the inventory view while preserving order history.','adminInventory','{}'::jsonb,v_actor); exception when others then null; end;
  return jsonb_build_object('deleted',true,'permanent',false,'preserved_order_history',true,'product_id',p_product_id,'product_name',v_name);
end;
$$;


--
-- Name: admin_delete_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_vendor(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
begin
  if v_actor is null or not exists (
    select 1 from public.users
    where id = v_actor and role = 'admin'
  ) then
    raise exception 'Only admins can delete a vendor.' using errcode='42501';
  end if;

  select * into v_vendor
  from public.vendors
  where id = p_vendor_id and deleted_at is null
  for update;
  if not found then raise exception 'Vendor not found.' using errcode='P0002'; end if;

  v_name := coalesce(v_vendor.business_name, 'Vendor');

  insert into public.vendor_recycle_bin(vendor_id, deleted_at, deleted_by, product_statuses, package_statuses)
  values (
    p_vendor_id, now(), v_actor,
    coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'status',p.status::text)) from public.products p where p.vendor_id=p_vendor_id), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('id',vp.id,'status',vp.status::text)) from public.vendor_packages vp where vp.vendor_id=p_vendor_id), '[]'::jsonb)
  )
  on conflict (vendor_id) do update set
    deleted_at=excluded.deleted_at,
    deleted_by=excluded.deleted_by,
    product_statuses=excluded.product_statuses,
    package_statuses=excluded.package_statuses;

  update public.products set status='removed' where vendor_id=p_vendor_id and status<>'removed';
  update public.vendor_packages set status='removed' where vendor_id=p_vendor_id and status<>'removed';

  update public.vendors
  set is_active=false,
      verification_status='rejected'::public.vendor_verification_status,
      deleted_previous_verification_status=v_vendor.verification_status,
      deleted_previous_is_active=v_vendor.is_active,
      deleted_at=now()
  where id=p_vendor_id;

  update public.users set role='buyer', role_selected=true where id=v_vendor.user_id and role<>'admin';

  begin
    perform public.create_notification(
      v_vendor.user_id,
      'vendor_deleted',
      'Vendor moved to recycle bin',
      'Your Levromart vendor account for ' || v_name || ' has been deactivated by an administrator. Your storefront and listings are temporarily hidden.',
      'home', '{}'::jsonb, v_actor
    );
  exception when others then
    raise warning 'Vendor deletion notification failed: %', SQLERRM;
  end;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),'delete_vendor','vendor',p_vendor_id,v_name);
  exception when others then
    raise warning 'Vendor admin-action audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object('deleted',true,'recycled',true,'vendor_id',p_vendor_id,'user_id',v_vendor.user_id);
end;
$$;


--
-- Name: admin_deny_appeal(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_deny_appeal(p_appeal_id uuid, p_response text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_response is null or trim(p_response) = '' then
    raise exception 'A reason is required to deny an appeal.';
  end if;

  update account_appeals set status = 'denied', admin_response = p_response, resolved_at = now(), resolved_by = auth.uid()
    where id = p_appeal_id and status = 'pending'
    returning user_id into v_user_id;
  if v_user_id is null then
    raise exception 'Appeal not found or already resolved.';
  end if;

  perform create_notification(
    v_user_id, 'appeal_denied', 'Your appeal was not approved',
    p_response, 'editProfile', '{}'::jsonb, auth.uid()
  );
end;
$$;


--
-- Name: admin_find_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_find_conversation(p_buyer_id uuid, p_vendor_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select id from conversations
  where is_admin() and buyer_id = p_buyer_id and vendor_id = p_vendor_id
  limit 1;
$$;


--
-- Name: admin_force_unlock_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_force_unlock_vendor(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
  v_owed numeric := 0;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can unlock vendor storefronts.' using errcode='42501';
  end if;

  select * into v_vendor
  from public.vendors
  where id=p_vendor_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Vendor not found.' using errcode='P0002';
  end if;

  v_name := coalesce(v_vendor.business_name,'this vendor');

  select coalesce(sum(c.amount),0) into v_owed
  from public.commission_charges c
  join public.orders o on o.id=c.order_id
  where c.vendor_id=p_vendor_id
    and c.status='owed'
    and o.status='completed';

  update public.vendors
  set is_active=true,
      admin_paused=false,
      commission_paused=false,
      commission_pause_reason='admin_override'
  where id=p_vendor_id;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),
      'unlock_vendor_storefront','vendor',p_vendor_id,v_name);
  exception when others then
    raise warning 'Vendor unlock admin-action audit insert failed: %',SQLERRM;
  end;

  return jsonb_build_object('success',true,'vendor',jsonb_build_object(
    'id',p_vendor_id,'is_active',true,'admin_paused',false,
    'commission_paused',false,'commission_pause_reason','admin_override',
    'commission_owed',v_owed,'commission_remains_owed',v_owed>0));
end;
$$;


--
-- Name: admin_get_conversation_participants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_conversation_participants(p_conversation_id uuid) RETURNS TABLE(buyer_id uuid, buyer_name text, buyer_avatar text, vendor_id uuid, vendor_name text, vendor_avatar text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select bu.id, bu.name, bu.avatar_url, v.id, v.business_name, v.logo_url
  from conversations c
  join vendors v on v.id = c.vendor_id
  join users bu on bu.id = c.buyer_id
  where c.id = p_conversation_id and is_admin();
$$;


--
-- Name: admin_get_inventory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_inventory() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can view inventory.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'price', coalesce(p.discount_price,p.sale_price,p.rental_rate),
    'status', p.status::text,
    'created_at', p.created_at,
    'vendor_id', p.vendor_id,
    'quantity_available', p.quantity_available,
    'quantity_total', p.quantity_total,
    'vendor_name', coalesce(v.business_name,'Unknown vendor'),
    'category_id', p.category_id,
    'category_name', coalesce(c.name,'Uncategorized'),
    'sector_id', coalesce(c.sector_id, v.sector_id),
    'sector_name', coalesce(cs.name, s.name, 'Unassigned')
  ) order by lower(coalesce(p.name,'')), p.created_at desc), '[]'::jsonb)
  into v_result
  from public.products p
  left join public.vendors v on v.id=p.vendor_id
  left join public.sectors s on s.id=v.sector_id
  left join public.categories c on c.id=p.category_id
  left join public.sectors cs on cs.id=c.sector_id
  where p.admin_deleted_at is null;
  return v_result;
end;
$$;


--
-- Name: admin_get_manual_password_reset_requests(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_manual_password_reset_requests() RETURNS TABLE(id uuid, email text, user_id uuid, user_name text, status text, created_at timestamp with time zone, approved_at timestamp with time zone, rejected_at timestamp with time zone, completed_at timestamp with time zone, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not exists (select 1 from public.users u where u.id=auth.uid() and u.role::text='admin' and coalesce(u.is_super_admin,false)) then
    raise exception 'Super admin access required.';
  end if;
  return query
  select r.id,r.email,r.user_id,u.name,r.status,r.created_at,r.approved_at,r.rejected_at,r.completed_at,r.expires_at
  from public.password_reset_requests r
  left join public.users u on u.id=r.user_id
  order by r.created_at desc
  limit 100;
end;
$$;


--
-- Name: admin_get_pending_appeals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_pending_appeals() RETURNS TABLE(id uuid, user_id uuid, user_name text, user_email text, suspension_reason text, message text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select a.id, a.user_id, u.name, u.email, a.suspension_reason, a.message, a.created_at
  from account_appeals a
  join users u on u.id = a.user_id
  where a.status = 'pending'
  order by a.created_at asc;
$$;


--
-- Name: admin_list_conversations(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_conversations(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100) RETURNS TABLE(conversation_id uuid, buyer_id uuid, buyer_name text, vendor_id uuid, vendor_name text, last_body text, last_at timestamp with time zone, message_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select c.id, c.buyer_id, bu.name, v.id, v.business_name,
         lm.body, lm.created_at, coalesce(mc.n, 0)
  from public.conversations c
  join public.vendors v on v.id = c.vendor_id
  left join public.users bu on bu.id = c.buyer_id
  left join lateral (select m.body, m.created_at from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
  left join lateral (select count(*) n from public.messages m where m.conversation_id = c.id) mc on true
  where public.is_admin()
    and (p_search is null or p_search = '' or bu.name ilike '%' || p_search || '%' or v.business_name ilike '%' || p_search || '%')
  order by lm.created_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 100), 300));
$$;


--
-- Name: admin_list_locked_vendors(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_locked_vendors() RETURNS TABLE(vendor_id uuid, business_name text, city text, applicant_name text, applicant_email text, admin_paused boolean, commission_paused boolean, commission_pause_reason text, commission_owed numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.' using errcode='42501';
  end if;

  return query
  select
    v.id as vendor_id,
    v.business_name,
    v.city,
    u.name as applicant_name,
    u.email as applicant_email,
    coalesce(v.admin_paused,false) as admin_paused,
    coalesce(v.commission_paused,false) as commission_paused,
    v.commission_pause_reason,
    coalesce((
      select sum(c.amount)
      from public.commission_charges c
      join public.orders o on o.id = c.order_id
      where c.vendor_id = v.id
        and c.status = 'owed'
        and o.status = 'completed'
    ), 0) as commission_owed
  from public.vendors v
  left join public.users u on u.id = v.user_id
  where v.deleted_at is null
    and v.verification_status = 'verified'
    and v.is_active = false
    and (coalesce(v.admin_paused,false) = true or coalesce(v.commission_paused,false) = true)
  order by v.business_name asc;
end;
$$;


--
-- Name: admin_list_transactions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_transactions() RETURNS TABLE(payment_id uuid, created_at timestamp with time zone, order_id uuid, payment_type public.payment_type, amount numeric, method public.payment_method, status public.payment_status, provider_reference text, vendor_name text, buyer_name text, commission_pct numeric, platform_cut numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    p.id, p.created_at, p.order_id, p.payment_type, p.amount, p.method, p.status, p.provider_reference,
    v.business_name, u.name, v.commission_pct,
    round(p.amount * v.commission_pct / 100, 2)
  from payments p
  join orders o on o.id = p.order_id
  join vendors v on v.id = o.vendor_id
  join users u on u.id = o.buyer_id
  where (select is_admin())
  order by p.created_at desc
  limit 300;
$$;


--
-- Name: admin_list_vendor_payouts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_vendor_payouts() RETURNS TABLE(vendor_id uuid, business_name text, verification_status public.vendor_verification_status, bank_name text, account_number text, account_name text, paystack_subaccount_code text, commission_pct numeric, completed_orders integer, total_paid_in numeric, commission_owed numeric, commission_due_at timestamp with time zone, commission_days_remaining integer, commission_status text, commission_paused boolean, commission_pause_reason text, admin_paused boolean, is_active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
select v.id,v.business_name,v.verification_status,v.bank_name,v.account_number,v.account_name,v.paystack_subaccount_code,v.commission_pct,
(select count(*)::int from public.orders o where o.vendor_id=v.id and o.status='completed'),
(select coalesce(sum(p.amount),0) from public.payments p join public.orders o on o.id=p.order_id where o.vendor_id=v.id and p.status='paid'),
coalesce((select sum(c.amount) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed'),0),
(select min(coalesce(c.due_at,c.created_at+interval '7 days')) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed'),
case when (select min(coalesce(c.due_at,c.created_at+interval '7 days')) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed') is null then null else floor(extract(epoch from ((select min(coalesce(c.due_at,c.created_at+interval '7 days')) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed'))-now())/86400)::int end,
case when coalesce((select sum(c.amount) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed'),0)<=0 then 'paid' when (select min(coalesce(c.due_at,c.created_at+interval '7 days')) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed')<=now() then 'overdue' when (select min(coalesce(c.due_at,c.created_at+interval '7 days')) from public.commission_charges c join public.orders o on o.id=c.order_id where c.vendor_id=v.id and c.status='owed' and o.status='completed')<=now()+interval '48 hours' then 'due_soon' else 'owing' end,
v.commission_paused,v.commission_pause_reason,coalesce(v.admin_paused,false),v.is_active
from public.vendors v where public.is_admin() and v.deleted_at is null order by v.business_name;
$$;


--
-- Name: admin_permanently_delete_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_permanently_delete_vendor(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
begin
  if v_actor is null or not exists (
    select 1 from public.users where id=v_actor and role='admin' and coalesce(is_super_admin,false)=true
  ) then
    raise exception 'Only a super admin can permanently delete a vendor.' using errcode='42501';
  end if;

  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is not null for update;
  if not found then raise exception 'Vendor is not in the recycle bin.' using errcode='P0002'; end if;
  v_name := coalesce(nullif(v_vendor.business_name,'Deleted vendor'),'Vendor');

  update public.products set status='removed' where vendor_id=p_vendor_id;
  update public.vendor_packages set status='removed' where vendor_id=p_vendor_id;
  update public.users set role='buyer'::public.user_role, role_selected=true where id=v_vendor.user_id and role<>'admin';
  update public.vendors
  set is_active=false,
      verification_status='rejected'::public.vendor_verification_status,
      deleted_at=coalesce(deleted_at,now()),
      business_name='Deleted vendor',
      bio=null,
      address=null,
      city=null,
      phone=null,
      whatsapp_number=null,
      cac_number=null,
      logo_url=null,
      cover_image_url=null,
      cover_url=null,
      verification_docs='{}'::text[]
  where id=p_vendor_id;

  delete from public.vendor_recycle_bin where vendor_id=p_vendor_id;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),'permanently_delete_vendor','vendor',p_vendor_id,v_name);
  exception when others then
    raise warning 'Permanent-delete audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object('deleted_permanently',true,'vendor_id',p_vendor_id,'user_id',v_vendor.user_id,'reapply_required',true);
end;
$$;


--
-- Name: admin_recent_points_adjustments(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_recent_points_adjustments(p_user uuid) RETURNS TABLE(created_at timestamp with time zone, points integer, note text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then return; end if;
  return query select l.created_at, l.points, l.note from public.points_ledger l
   where l.user_id = p_user and l.kind = 'admin_adjustment' order by l.created_at desc limit 10;
end $$;


--
-- Name: admin_recent_points_skips(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_recent_points_skips(p_limit integer DEFAULT 30) RETURNS TABLE(created_at timestamp with time zone, kind text, reason text, business_name text, name text, ref text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then return; end if;
  return query
  select s.created_at, s.kind, s.reason, v.business_name, u.name, s.ref
    from public.points_skips s
    left join public.users u on u.id = s.user_id
    left join public.vendors v on v.user_id = s.user_id and v.deleted_at is null
   where not exists (select 1 from public.points_ledger l where l.user_id = s.user_id and l.event_key in ('order:' || s.ref, 'review:' || s.ref))
   order by s.created_at desc limit greatest(1, least(coalesce(p_limit, 30), 100));
end $$;


--
-- Name: admin_reject_manual_password_reset(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reject_manual_password_reset(p_request_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not exists (select 1 from public.users u where u.id=auth.uid() and u.role::text='admin' and coalesce(u.is_super_admin,false)) then
    raise exception 'Super admin access required.';
  end if;
  update public.password_reset_requests
  set status='rejected',rejected_at=now(),rejected_by=auth.uid()
  where id=p_request_id and status='pending';
  if not found then raise exception 'Request is no longer pending.'; end if;
  return true;
end;
$$;


--
-- Name: admin_reject_monthly_listing(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reject_monthly_listing(p_submission_id uuid, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s public.monthly_listing_submissions%rowtype; v_name text; v_user_id uuid; v_admin_name text;
begin
  if not exists(select 1 from public.users where id=auth.uid() and role='admin') then raise exception 'Admin access required.'; end if;
  select * into s from public.monthly_listing_submissions where id=p_submission_id for update;
  if s.id is null then raise exception 'Monthly listing submission not found.'; end if;
  if s.status <> 'pending' then raise exception 'This submission has already been reviewed.'; end if;
  if s.kind='product' then
    select name into v_name from public.products where id=s.listing_id and vendor_id=s.vendor_id;
    update public.products set status='paused',billing_status='pending_payment',billing_paid_until=null,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  else
    select name into v_name from public.vendor_packages where id=s.listing_id and vendor_id=s.vendor_id;
    update public.vendor_packages set status='paused',billing_status='pending_payment',billing_paid_until=null,billing_reference=null where id=s.listing_id and vendor_id=s.vendor_id;
  end if;
  update public.monthly_listing_submissions set status='rejected',reviewed_at=now(),reviewed_by=auth.uid(),review_note=nullif(trim(coalesce(p_note,'')),''),updated_at=now() where id=s.id;
  select name into v_admin_name from public.users where id=auth.uid();
  insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label) values(auth.uid(),v_admin_name,'Rejected monthly listing payment','monthly_listing',s.listing_id,v_name);
  select user_id into v_user_id from public.vendors where id=s.vendor_id;
  insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,vendor_id,notification_category,metadata)
  values(v_user_id,'monthly_listing_rejected','Monthly listing payment rejected','Your ₦1,000 monthly payment for '||coalesce(v_name,'this listing')||' was not approved.'||case when nullif(trim(coalesce(p_note,'')),'') is not null then ' Note: '||trim(p_note) else '' end,'vendorProducts',jsonb_build_object('listingId',s.listing_id,'kind',s.kind),auth.uid(),v_admin_name,s.vendor_id,'system',jsonb_build_object('submission_id',s.id,'listing_id',s.listing_id,'kind',s.kind));
  return jsonb_build_object('ok',true);
end; $$;


--
-- Name: admin_reject_reported_payment(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reject_reported_payment(p_order_id uuid, p_admin_notes text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype; v_dispute_id uuid; v_offer_id uuid;
begin
  if not public.is_admin() then raise exception 'Only admins can reject payment claims.' using errcode='42501'; end if;
  if trim(coalesce(p_admin_notes,''))='' then raise exception 'Resolution notes are required when rejecting a payment claim.'; end if;
  select * into v_order from public.orders where id=p_order_id for update; if not found then raise exception 'Order not found.'; end if;
  select * into v_payment from public.payments where order_id=p_order_id and status='pending' and provider_reference in ('buyer_report','service_offer_report') order by created_at desc limit 1 for update; if v_payment.id is null then raise exception 'No pending reported payment was found.'; end if;
  update public.payments set provider_reference='reported_payment_rejected' where id=v_payment.id;
  if v_order.service_offer_id is not null then select id into v_offer_id from public.service_offers where id=v_order.service_offer_id; if v_offer_id is not null then update public.service_offers set status='expired',updated_at=now() where id=v_offer_id; end if; end if;
  select id into v_dispute_id from public.disputes where order_id=p_order_id and status='open' order by created_at desc limit 1; if v_dispute_id is not null then update public.disputes set status='resolved',admin_notes=p_admin_notes where id=v_dispute_id; end if;
  update public.orders set status='cancelled'::public.order_status,cancelled_at=coalesce(cancelled_at,now()),payment_unresolved_at=null where id=p_order_id and status<>'completed';
  perform public.create_notification(v_order.buyer_id,'payment_claim_rejected','Payment claim rejected','Levromart could not verify the reported payment for this order. Check the order for the resolution notes.','orderDetail',jsonb_build_object('orderId',p_order_id),null);
  return jsonb_build_object('success',true,'order_cancelled',true);
end;$$;


--
-- Name: admin_reject_vendor(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reject_vendor(p_vendor_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_user public.users%rowtype;
  v_reason text;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can reject vendor applications.' using errcode='42501';
  end if;

  v_reason := nullif(trim(coalesce(p_reason,'')), '');
  if v_reason is null then
    raise exception 'Please provide a reason for rejecting this vendor.' using errcode='22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'Rejection reason must be 1000 characters or fewer.' using errcode='22023';
  end if;

  select * into v_vendor
  from public.vendors
  where id = p_vendor_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Vendor application not found.' using errcode='P0002';
  end if;

  select * into v_user from public.users where id=v_vendor.user_id for update;
  if not found then
    raise exception 'Vendor account profile not found.' using errcode='P0002';
  end if;

  v_name := coalesce(v_vendor.business_name, 'this business');

  update public.vendors
  set verification_status='rejected'::public.vendor_verification_status,
      is_active=false
  where id=p_vendor_id;

  update public.users
  set role='buyer', role_selected=true
  where id=v_vendor.user_id and role<>'admin';

  begin
    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name)
    values(
      v_vendor.user_id,
      'vendor_rejected',
      'Vendor application rejected',
      'Your application for ' || v_name || ' was rejected by a Levromart administrator. Reason: ' || v_reason,
      'home',
      jsonb_build_object('reason', v_reason),
      v_actor,
      (select coalesce(name,email,'Levromart Admin') from public.users where id=v_actor)
    );
  exception when others then
    raise warning 'Vendor rejection notification failed: %', SQLERRM;
  end;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(
      v_actor,
      (select coalesce(name,email,'Admin') from public.users where id=v_actor),
      'reject_vendor',
      'vendor',
      p_vendor_id,
      v_name || ' — ' || left(v_reason, 180)
    );
  exception when others then
    raise warning 'Vendor rejection audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object(
    'success',true,
    'rejected',true,
    'vendor_id',p_vendor_id,
    'user_id',v_vendor.user_id,
    'user_role',(select role from public.users where id=v_vendor.user_id),
    'reason',v_reason
  );
end;
$$;


--
-- Name: admin_restore_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_restore_vendor(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_bin public.vendor_recycle_bin%rowtype;
  v_status public.vendor_verification_status;
  v_active boolean;
  item jsonb;
begin
  if v_actor is null or not exists (select 1 from public.users where id=v_actor and role='admin') then
    raise exception 'Only admins can restore a vendor.' using errcode='42501';
  end if;

  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is not null for update;
  if not found then raise exception 'Vendor is not in the recycle bin.' using errcode='P0002'; end if;
  select * into v_bin from public.vendor_recycle_bin where vendor_id=p_vendor_id;

  v_status := coalesce(nullif(v_vendor.deleted_previous_verification_status::text,''),'verified')::public.vendor_verification_status;
  v_active := coalesce(v_vendor.deleted_previous_is_active,false);

  update public.vendors
  set deleted_at=null,
      verification_status=v_status,
      is_active=v_active,
      deleted_previous_verification_status=null,
      deleted_previous_is_active=null
  where id=p_vendor_id;

  if v_bin.vendor_id is not null then
    for item in select value from jsonb_array_elements(v_bin.product_statuses) loop
      update public.products set status=(item->>'status')::public.product_status where id=(item->>'id')::uuid and vendor_id=p_vendor_id;
    end loop;
    for item in select value from jsonb_array_elements(v_bin.package_statuses) loop
      update public.vendor_packages set status=item->>'status' where id=(item->>'id')::uuid and vendor_id=p_vendor_id;
    end loop;
  else
    update public.products set status='active' where vendor_id=p_vendor_id and status='removed';
    update public.vendor_packages set status='active' where vendor_id=p_vendor_id and status='removed';
  end if;

  update public.users
  set role=(case when v_status='verified' then 'vendor' else 'buyer' end)::public.user_role,
      role_selected=true
  where id=v_vendor.user_id and role<>'admin';

  delete from public.vendor_recycle_bin where vendor_id=p_vendor_id;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),'restore_vendor','vendor',p_vendor_id,coalesce(v_vendor.business_name,'Vendor'));
  exception when others then
    raise warning 'Restore audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object('restored',true,'vendor_id',p_vendor_id,'user_id',v_vendor.user_id,'verification_status',v_status,'is_active',v_active);
end;
$$;


--
-- Name: admin_review_campus_school(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_review_campus_school(p_norm text, p_action text, p_target text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not exists(select 1 from users u where u.id=auth.uid() and u.role='admin') then raise exception 'admin only'; end if;
  if p_action='approve' then
    update campus_submissions set status='approved',reviewed_at=now() where name_norm=p_norm;
  elsif p_action='merge' then
    if p_target is null or p_target='' then raise exception 'target required'; end if;
    update users set campus_id=p_target where campus_id like 'custom:%' and lv_norm_school(substr(campus_id,8))=p_norm;
    update vendors set campus_id=p_target where campus_id like 'custom:%' and lv_norm_school(substr(campus_id,8))=p_norm;
    update campus_submissions set status='merged',merged_into=p_target,reviewed_at=now() where name_norm=p_norm;
  elsif p_action='reject' then
    update users set campus_id='none' where campus_id like 'custom:%' and lv_norm_school(substr(campus_id,8))=p_norm;
    update vendors set campus_id='none' where campus_id like 'custom:%' and lv_norm_school(substr(campus_id,8))=p_norm;
    update campus_submissions set status='rejected',reviewed_at=now() where name_norm=p_norm;
  else raise exception 'bad action'; end if;
end $$;


--
-- Name: admin_review_student_verification(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_review_student_verification(p_vendor_id uuid, p_status text, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid := auth.uid(); v_user uuid; v_row public.vendor_student_verification%rowtype;
begin
  if v_uid is null or not public.is_admin() then raise exception 'Only admins can review student verification.' using errcode='42501'; end if;
  if p_status not in ('approved','rejected','pending') then raise exception 'Invalid status.'; end if;
  select * into v_row from public.vendor_student_verification where vendor_id=p_vendor_id;
  if not found then raise exception 'No verification submitted for this vendor.'; end if;
  if p_status='approved' and (v_row.matric_pending or coalesce(trim(v_row.matric_number),'')='') then
    raise exception 'This vendor has not added a matric number yet, so they cannot be verified.';
  end if;
  update public.vendor_student_verification set status=p_status, review_note=p_note, reviewed_by=v_uid, reviewed_at=now(), updated_at=now() where vendor_id=p_vendor_id;
  update public.vendors set student_verified=(p_status='approved') where id=p_vendor_id returning user_id into v_user;
  begin
    perform public.create_notification(v_user,'student_verification',
      case p_status when 'approved' then 'Student verification approved' when 'rejected' then 'Student verification needs attention' else 'Student verification updated' end,
      case p_status when 'approved' then 'Your student details were verified. A Verified student badge now shows on your store.' when 'rejected' then coalesce(nullif(p_note,''),'Please re-upload clearer documents and submit again.') else 'Your verification is back under review.' end,
      'vendorEditProfile','{}'::jsonb,null);
  exception when others then null; end;
  return jsonb_build_object('success',true,'status',p_status);
end $$;


--
-- Name: admin_search_points_users(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_search_points_users(p_q text) RETURNS TABLE(user_id uuid, name text, phone text, email text, role text, business_name text, vendor_id uuid, week_points bigint, all_points bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare q text := trim(coalesce(p_q, '')); digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if not public.is_admin() then return; end if;
  if length(q) < 2 then return; end if;
  return query
  select u.id, u.name, u.phone, u.email, u.role::text, v.business_name, v.id,
         coalesce((select sum(l.points) from public.points_ledger l where l.user_id = u.id and l.week_start = public.points_week_start()), 0)::bigint,
         coalesce((select sum(l.points) from public.points_ledger l where l.user_id = u.id), 0)::bigint
    from public.users u
    left join public.vendors v on v.user_id = u.id and v.deleted_at is null
   where u.name ilike '%' || q || '%' or coalesce(u.email, '') ilike '%' || q || '%' or coalesce(v.business_name, '') ilike '%' || q || '%'
      or (length(digits) >= 6 and right(regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'), 9) = right(digits, 9))
   order by (v.id is not null) desc, u.name
   limit 12;
end $$;


--
-- Name: admin_set_user_role(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_user_role(target_email text, new_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_target_id uuid;
  v_target_super boolean;
  v_admin_name text;
  affected int;
begin
  if not exists (select 1 from public.users where id=auth.uid() and role='admin' and coalesce(is_super_admin,false)) then
    raise exception 'Only the super admin can change admin roles';
  end if;
  if new_role not in ('buyer','vendor','admin') then
    raise exception 'Invalid role: %', new_role;
  end if;
  select id, is_super_admin into v_target_id, v_target_super from public.users where email = target_email;
  if v_target_id is null then raise exception 'No user found with email %', target_email; end if;
  if v_target_super and new_role <> 'admin' and v_target_id <> auth.uid() then
    raise exception 'This admin account is protected. Only that account itself can remove its own admin access.';
  end if;
  update public.users set role = new_role::user_role where id = v_target_id;
  get diagnostics affected = row_count;
  if affected = 0 then raise exception 'No user found with email %', target_email; end if;
  select name into v_admin_name from users where id = auth.uid();
  insert into admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
    values (auth.uid(), v_admin_name, case when new_role = 'admin' then 'promote_admin' else 'demote_admin' end, 'user', v_target_id, target_email);
  perform create_notification(v_target_id, case when new_role = 'admin' then 'promoted_admin' else 'demoted_admin' end,
    case when new_role = 'admin' then 'You were made an admin' else 'Your admin access was removed' end,
    case when new_role = 'admin' then 'You can now approve vendors, resolve disputes, and manage other admins.' else 'Your account is now a regular ' || new_role || ' account.' end,
    'home', '{}'::jsonb, auth.uid());
end;
$$;


--
-- Name: admin_set_vendor_status(uuid, public.vendor_verification_status); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_vendor_status(p_vendor_id uuid, p_status public.vendor_verification_status) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_user public.users%rowtype;
  v_action text;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then raise exception 'Only admins can change vendor status.' using errcode='42501'; end if;
  if p_status not in ('verified'::public.vendor_verification_status,'rejected'::public.vendor_verification_status,'pending'::public.vendor_verification_status) then raise exception 'Invalid vendor status.' using errcode='22023'; end if;
  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is null for update;
  if not found then raise exception 'Vendor not found.' using errcode='P0002'; end if;
  select * into v_user from public.users where id=v_vendor.user_id for update;
  if not found then raise exception 'Vendor account profile not found.' using errcode='P0002'; end if;
  v_name := coalesce(v_vendor.business_name,'this business');

  update public.vendors
    set verification_status=p_status,
        is_active=(p_status='verified'::public.vendor_verification_status),
        avg_rating=coalesce(avg_rating,0),
        review_count=coalesce(review_count,0),
        admin_paused=false
  where id=p_vendor_id;

  if p_status='verified' then
    update public.users set role='vendor',role_selected=true where id=v_vendor.user_id and role<>'admin';
    v_action:='approve_vendor';
    begin
      insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name)
      values(v_vendor.user_id,'vendor_approved','Vendor application approved',
        'Congratulations! '||v_name||' has been approved. Your Levromart vendor account is now active and your storefront is live.',
        'vendorDashboard','{}'::jsonb,v_actor,
        (select coalesce(name,email,'Levromart Admin') from public.users where id=v_actor));
    exception when others then raise warning 'Vendor approval notification failed: %',SQLERRM; end;
  elsif p_status='rejected' then
    update public.users set role='buyer',role_selected=true where id=v_vendor.user_id and role<>'admin';
    v_action:='reject_vendor';
    begin
      insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name)
      values(v_vendor.user_id,'vendor_rejected','Vendor application update',
        'Your application for '||v_name||' was not approved at this time. Please review your application details or contact Levromart support.',
        'home','{}'::jsonb,v_actor,
        (select coalesce(name,email,'Levromart Admin') from public.users where id=v_actor));
    exception when others then raise warning 'Vendor rejection notification failed: %',SQLERRM; end;
  else
    update public.users set role='buyer',role_selected=true where id=v_vendor.user_id and role<>'admin';
    v_action:='set_vendor_pending';
  end if;

  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),v_action,'vendor',p_vendor_id,v_name);
  exception when others then raise warning 'Vendor admin-action audit insert failed: %',SQLERRM; end;

  select * into v_user from public.users where id=v_vendor.user_id;
  return jsonb_build_object('success',true,'vendor',jsonb_build_object('id',v_vendor.id,'user_id',v_vendor.user_id,'verification_status',p_status,'is_active',(p_status='verified'),'lat',v_vendor.lat,'lng',v_vendor.lng),'user',jsonb_build_object('id',v_user.id,'role',v_user.role,'role_selected',v_user.role_selected));
end;
$$;


--
-- Name: admin_set_vendor_storefront_active(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_vendor_storefront_active(p_vendor_id uuid, p_active boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can change vendor storefront status.' using errcode='42501';
  end if;
  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is null for update;
  if not found then raise exception 'Vendor not found.' using errcode='P0002'; end if;
  v_name := coalesce(v_vendor.business_name,'this vendor');
  update public.vendors
  set is_active=p_active,
      admin_paused=case when p_active then false else true end,
      commission_paused=case when p_active then false else commission_paused end,
      commission_pause_reason=case when p_active then 'admin_override' else commission_pause_reason end
  where id=p_vendor_id;
  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),
      case when p_active then 'reactivate_storefront' else 'pause_storefront' end,'vendor',p_vendor_id,v_name);
  exception when others then raise warning 'Vendor storefront admin-action audit insert failed: %',SQLERRM; end;
  return jsonb_build_object('success',true,'vendor',jsonb_build_object('id',v_vendor.id,'is_active',p_active,'admin_paused',not p_active,'commission_paused',case when p_active then false else v_vendor.commission_paused end,'commission_pause_reason',case when p_active then 'admin_override' else v_vendor.commission_pause_reason end));
end;
$$;


--
-- Name: admin_suspend_user(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_suspend_user(p_user_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_admin_name text;
  v_target_name text;
  v_target_email text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required to suspend an account';
  end if;

  update public.users
    set suspended_at = now(), suspended_reason = p_reason, suspended_by = auth.uid()
    where id = p_user_id;

  update public.vendors set is_active = false where user_id = p_user_id;

  select name, email into v_target_name, v_target_email from users where id = p_user_id;
  select name into v_admin_name from users where id = auth.uid();
  insert into admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
    values (auth.uid(), v_admin_name, 'suspend_user', 'user', p_user_id,
      coalesce(v_target_name, v_target_email, 'user') || ' — ' || p_reason);

  perform create_notification(
    p_user_id, 'account_suspended', 'Your account has been suspended',
    p_reason, 'editProfile', '{}'::jsonb, auth.uid()
  );
end;
$$;


--
-- Name: admin_toggle_vendor_storefront_active(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then raise exception 'Only admins can change vendor storefront status.' using errcode='42501'; end if;
  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is null for update;
  if not found then raise exception 'Vendor not found.' using errcode='P0002'; end if;
  v_name := coalesce(v_vendor.business_name,'this vendor');
  update public.vendors
  set is_active=p_active,
      admin_paused=case when p_active then false else true end,
      commission_paused=case when p_active then false else commission_paused end,
      commission_pause_reason=case when p_active then 'admin_override' else commission_pause_reason end
  where id=p_vendor_id;
  begin
    insert into public.admin_actions(admin_id,admin_name,action,target_type,target_id,target_label)
    values(v_actor,(select coalesce(name,email,'Admin') from public.users where id=v_actor),case when p_active then 'unlock_vendor' else 'pause_vendor' end,'vendor',p_vendor_id,v_name);
  exception when others then raise warning 'Vendor admin-action audit insert failed: %',SQLERRM; end;
  return jsonb_build_object('success',true,'vendor_id',p_vendor_id,'is_active',p_active,'admin_paused',case when p_active then false else true end,'commission_paused',case when p_active then false else v_vendor.commission_paused end,'commission_pause_reason',case when p_active then 'admin_override' else v_vendor.commission_pause_reason end);
end;
$$;


--
-- Name: admin_trash_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_trash_vendor(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_vendor public.vendors%rowtype;
  v_name text;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only admins can delete a vendor.' using errcode='42501';
  end if;

  select * into v_vendor
  from public.vendors
  where id = p_vendor_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Vendor not found.' using errcode='P0002';
  end if;

  v_name := coalesce(v_vendor.business_name, 'Vendor');

  update public.vendors
  set deleted_previous_verification_status = verification_status,
      deleted_previous_is_active = is_active,
      deleted_at = now(),
      is_active = false,
      verification_status = 'rejected'
  where id = p_vendor_id;

  update public.users
  set role = 'buyer', role_selected = true
  where id = v_vendor.user_id and role <> 'admin';

  begin
    perform public.create_notification(
      v_vendor.user_id,
      'vendor_deleted',
      'Vendor account deactivated',
      'Your Levromart vendor account for ' || v_name || ' has been moved out of vendor status by an administrator. Your storefront is no longer active.',
      'home', '{}'::jsonb, v_actor
    );
  exception when others then
    raise warning 'Vendor delete notification failed: %', SQLERRM;
  end;

  begin
    insert into public.admin_actions(admin_id, admin_name, action, target_type, target_id, target_label)
    values(v_actor,
      (select coalesce(name,email,'Admin') from public.users where id=v_actor),
      'delete_vendor', 'vendor', p_vendor_id, v_name);
  exception when others then
    raise warning 'Vendor delete audit insert failed: %', SQLERRM;
  end;

  return jsonb_build_object('deleted', true, 'vendor_id', p_vendor_id, 'user_id', v_vendor.user_id, 'user_role', 'buyer');
end;
$$;


--
-- Name: admin_unlink_all_identities(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_unlink_all_identities(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  delete from auth.identities where user_id = p_user_id;
$$;


--
-- Name: admin_unsuspend_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_unsuspend_user(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_admin_name text;
  v_target_name text;
  v_target_email text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  update public.users set suspended_at = null, suspended_reason = null, suspended_by = null where id = p_user_id;
  update public.account_appeals set status = 'approved', resolved_at = now(), resolved_by = auth.uid()
    where user_id = p_user_id and status = 'pending';

  select name, email into v_target_name, v_target_email from users where id = p_user_id;
  select name into v_admin_name from users where id = auth.uid();
  insert into admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
    values (auth.uid(), v_admin_name, 'unsuspend_user', 'user', p_user_id, coalesce(v_target_name, v_target_email, 'user'));

  perform create_notification(
    p_user_id, 'account_unsuspended', 'Your account has been reinstated',
    'Your account is active again.', 'home', '{}'::jsonb, auth.uid()
  );
end;
$$;


--
-- Name: am_i_blocked_with(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.am_i_blocked_with(other_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select public.is_blocked_between(auth.uid(), other_user_id);
$$;


--
-- Name: apply_referral_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_referral_code(p_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'not_signed_in'); end if;
  return public.apply_referral_internal(auth.uid(), p_code, false);
end $$;


--
-- Name: apply_referral_internal(uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_referral_internal(p_uid uuid, p_code text, p_skip_customer boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  u record; v record; vu record; c text := upper(regexp_replace(coalesce(p_code,''), '\s', '', 'g'));
  ref2 record; is_vendor_acct boolean;
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
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid', 'message', 'That referral code was not found.'); end if;
  select * into vu from public.users where id = v.user_id;
  if v.user_id = p_uid or (coalesce(u.phone,'') <> '' and u.phone = vu.phone) then
    return jsonb_build_object('ok', false, 'error', 'own_code', 'message', 'You cannot use your own referral code.');
  end if;
  insert into public.referrals (referred_user_id, referrer_user_id, referrer_vendor_id, code)
  values (p_uid, v.user_id, v.id, c)
  on conflict (referred_user_id) do update set referrer_user_id = excluded.referrer_user_id,
    referrer_vendor_id = excluded.referrer_vendor_id, code = excluded.code, vendor_awarded = false, created_at = now()
  where public.referrals.code = 'VOID';
  is_vendor_acct := exists (select 1 from public.vendors where user_id = p_uid);
  if not p_skip_customer and u.role::text = 'buyer' and not is_vendor_acct then
    perform public.award_points(v.user_id, 'ref_customer', 'refc:' || p_uid, p_uid, 'Customer joined with your code');
    select * into ref2 from public.referrals where referred_user_id = v.user_id and code <> 'VOID';
    if found then
      perform public.award_points(ref2.referrer_user_id, 'ref2_customer', 'refc2:' || p_uid, p_uid, 'Your referred vendor brought in a customer');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'business_name', v.business_name);
end $$;


--
-- Name: auto_cancel_unconfirmed_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_cancel_unconfirmed_orders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record; n integer := 0;
begin
  for r in
    select o.id, o.buyer_id, v.user_id as vendor_user_id
    from public.orders o join public.vendors v on v.id = o.vendor_id
    where o.status = 'pending' and o.created_at <= now() - interval '30 minutes'
    for update of o skip locked
  loop
    update public.orders set status='cancelled', cancelled_at=now(),
      cancellation_reason='Cancelled automatically: the vendor did not confirm within 30 minutes'
    where id=r.id and status='pending';
    if not found then continue; end if;
    if r.buyer_id is not null then
      perform public.create_notification(r.buyer_id,'order_auto_cancelled','Order cancelled automatically',
        'The vendor did not confirm your order within 30 minutes, so it was cancelled. You have not been charged. You can order again or try another vendor.',
        'orderDetail', jsonb_build_object('orderId', r.id), null);
    end if;
    if r.vendor_user_id is not null then
      perform public.create_notification(r.vendor_user_id,'order_auto_cancelled','Order cancelled automatically',
        'You did not confirm this order within 30 minutes, so it was cancelled automatically. Reply faster next time to keep your customers.',
        'orderDetail', jsonb_build_object('orderId', r.id), null);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;


--
-- Name: auto_complete_eligible_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_complete_eligible_orders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record; n integer:=0;
begin
  for r in
    select o.id, o.buyer_id, o.vendor_id from public.orders o
    where o.status in ('confirmed','handed_over') and o.awaiting_confirmation_since is not null
      and o.awaiting_confirmation_since < now() - interval '24 hours'
      and o.order_type<>'rental' and o.service_offer_id is null
      and coalesce(o.payout_status,'not_applicable')='not_applicable'
      and exists(select 1 from public.payments p where p.order_id=o.id and p.payment_type in ('sale_price','rental_fee') and p.status='paid')
      and (not (o.delivery_method='delivery' and o.payment_timing='pay_after') or exists(select 1 from public.payments p where p.order_id=o.id and p.payment_type='delivery_deposit_20' and p.status='paid'))
      and not exists(select 1 from public.disputes d where d.order_id=o.id and d.status='open')
    for update of o skip locked
  loop
    update public.orders set status='completed'::public.order_status, completed_at=coalesce(completed_at,now()), auto_completed_at=now(), awaiting_confirmation_since=null where id=r.id;
    n:=n+1;
    begin
      perform public.create_notification(r.buyer_id,'order_completed','Order marked as received','No issue was reported within 24 hours, so your order was marked as received and completed.','orderDetail',jsonb_build_object('orderId',r.id,'reviewEligible',true),null);
    exception when others then null; end;
  end loop;
  return n;
end $$;


--
-- Name: award_points(uuid, text, text, uuid, text, jsonb, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.award_points(p_user uuid, p_kind text, p_key text, p_source uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb, p_points integer DEFAULT NULL::integer, p_notify boolean DEFAULT true) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  r public.points_rules%rowtype; v_have boolean; v_pts int; v_week date := public.points_week_start();
  v_cnt int; v_id uuid;
begin
  if p_user is null or p_key is null then return 0; end if;
  if not exists (select 1 from public.users where id = p_user) then return 0; end if;
  select * into r from public.points_rules where kind = p_kind;
  v_have := found;
  if p_points is null then
    if not v_have or not r.active then return 0; end if;
    v_pts := r.points;
  else
    v_pts := p_points;
  end if;
  if v_pts = 0 then return 0; end if;
  if v_have and r.daily_cap is not null then
    select count(*) into v_cnt from public.points_ledger
     where user_id = p_user and kind = p_kind
       and (created_at at time zone 'Africa/Lagos')::date = (now() at time zone 'Africa/Lagos')::date;
    if v_cnt >= r.daily_cap then
      perform public.points_log_skip(p_user, p_kind, p_key, 'Daily limit of ' || r.daily_cap || ' reached');
      return 0;
    end if;
  end if;
  if v_have and r.weekly_cap is not null then
    select count(*) into v_cnt from public.points_ledger where user_id = p_user and kind = p_kind and week_start = v_week;
    if v_cnt >= r.weekly_cap then
      perform public.points_log_skip(p_user, p_kind, p_key, 'Weekly limit of ' || r.weekly_cap || ' reached');
      return 0;
    end if;
  end if;
  insert into public.points_ledger (user_id, kind, points, event_key, source_user_id, note, meta, week_start)
  values (p_user, p_kind, v_pts, p_key, p_source, coalesce(p_note, case when v_have then r.label end), coalesce(p_meta, '{}'::jsonb), v_week)
  on conflict (user_id, event_key) do nothing
  returning id into v_id;
  if v_id is null then return 0; end if;
  insert into public.points_weekly (user_id, week_start, points, tx_count, last_at)
  values (p_user, v_week, v_pts, case when p_kind = 'order_completed' then 1 else 0 end, now())
  on conflict (user_id, week_start) do update set
    points = public.points_weekly.points + excluded.points,
    tx_count = public.points_weekly.tx_count + excluded.tx_count,
    last_at = now(), updated_at = now();
  if p_notify and v_pts > 0 then
    perform public.notify_points(p_user, v_pts, coalesce(p_note, case when v_have then r.label end));
  end if;
  return v_pts;
end $$;


--
-- Name: buyer_can_message_vendor(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buyer_can_message_vendor(p_buyer uuid, p_vendor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.orders o
    where o.buyer_id = p_buyer and o.vendor_id = p_vendor
      and (
        o.status in ('confirmed','handed_over','returned','payment_unresolved','disputed')
        or (o.status = 'completed' and coalesce(o.completed_at, o.status_changed_at, o.created_at) > now() - interval '24 hours')
      )
  );
$$;


--
-- Name: buyer_confirm_received(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buyer_confirm_received(p_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); o public.orders%rowtype; v_fee boolean; v_dep boolean:=true;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.buyer_id<>v_uid then raise exception 'Only the buyer can confirm receipt.' using errcode='42501'; end if;
  if o.awaiting_confirmation_since is null or o.status not in ('confirmed','handed_over') then raise exception 'This order is not waiting for your confirmation.' using errcode='22023'; end if;
  select exists(select 1 from public.payments where order_id=p_order_id and payment_type in ('sale_price','rental_fee') and status='paid') into v_fee;
  if o.delivery_method='delivery' and o.payment_timing='pay_after' then select exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid') into v_dep; end if;
  if not v_fee or not v_dep then raise exception 'All required payments must be confirmed first.' using errcode='22023'; end if;
  update public.orders set status='completed'::public.order_status, completed_at=coalesce(completed_at,now()), awaiting_confirmation_since=null where id=p_order_id;
  return jsonb_build_object('success',true);
end $$;


--
-- Name: buyer_report_manual_payment(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buyer_report_manual_payment(p_order_id uuid, p_amount numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_vendor_user_id uuid; v_vendor_name text; v_buyer_name text;
  v_payment_type public.payment_type; v_expected numeric:=0; v_delivery_deposit_paid numeric:=0; v_payment_id uuid;
  v_timing text; v_pct numeric(5,2);
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found.' using errcode='P0002'; end if;
  if v_order.buyer_id<>v_uid then raise exception 'You are not authorized to report payment for this order.' using errcode='42501'; end if;
  if v_order.status not in ('pending','confirmed','handed_over','returned','payment_unresolved') then raise exception 'This order is not currently eligible for a payment report.' using errcode='22023'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be positive.' using errcode='22023'; end if;
  v_timing:=case when v_order.payment_timing in ('pay_before','pay_after') then v_order.payment_timing when v_order.delivery_method='delivery' then 'pay_after' else 'pay_before' end;
  v_pct:=greatest(0.01,least(99.99,coalesce(v_order.payment_deposit_percent,20)));
  if v_order.delivery_method='delivery' and v_timing='pay_after' then
    if not exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid') then
      v_payment_type:='delivery_deposit_20'::public.payment_type; v_expected:=round(greatest(0,coalesce(v_order.total_amount,0)-coalesce(v_order.delivery_fee,0))*v_pct/100,2);
    else
      v_payment_type:=case when v_order.order_type='sale' then 'sale_price'::public.payment_type else 'rental_fee'::public.payment_type end;
      select coalesce(sum(amount),0) into v_delivery_deposit_paid from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid';
      v_expected:=greatest(0,coalesce(v_order.total_amount,0)-v_delivery_deposit_paid);
    end if;
  elsif v_order.delivery_method='pickup' then
    v_payment_type:=case when v_order.order_type='sale' then 'sale_price'::public.payment_type else 'rental_fee'::public.payment_type end;
    if not exists(select 1 from public.payments where order_id=p_order_id and payment_type=v_payment_type and status='paid') then v_expected:=greatest(0,coalesce(v_order.total_amount,0));
    elsif coalesce(v_order.deposit_amount,0)>0 and not exists(select 1 from public.payments where order_id=p_order_id and payment_type='deposit' and status='paid') then
      v_payment_type:='deposit'::public.payment_type; v_expected:=coalesce((select amount from public.payments where order_id=p_order_id and payment_type='deposit' and status in ('pending','paid') order by (status='pending') desc,created_at desc limit 1),v_order.deposit_amount,0);
    else return jsonb_build_object('success',true,'message','There is no outstanding payment obligation on this order.'); end if;
  else
    v_payment_type:=case when v_order.order_type='sale' then 'sale_price'::public.payment_type else 'rental_fee'::public.payment_type end;
    if not exists(select 1 from public.payments where order_id=p_order_id and payment_type=v_payment_type and status='paid') then
      v_expected:=coalesce((select amount from public.payments where order_id=p_order_id and payment_type=v_payment_type and status in ('pending','paid') order by (status='pending') desc,created_at desc limit 1),v_order.total_amount,0);
    elsif coalesce(v_order.deposit_amount,0)>0 and not exists(select 1 from public.payments where order_id=p_order_id and payment_type='deposit' and status='paid') then
      v_payment_type:='deposit'::public.payment_type; v_expected:=coalesce((select amount from public.payments where order_id=p_order_id and payment_type='deposit' and status in ('pending','paid') order by (status='pending') desc,created_at desc limit 1),v_order.deposit_amount,0);
    else return jsonb_build_object('success',true,'message','There is no outstanding payment obligation on this order.'); end if;
  end if;
  if abs(p_amount-coalesce(v_expected,p_amount))>0.01 then raise exception 'Payment amount does not match the outstanding amount for this order.' using errcode='22023'; end if;
  select v.user_id,v.business_name into v_vendor_user_id,v_vendor_name from public.vendors v where v.id=v_order.vendor_id;
  select u.name into v_buyer_name from public.users u where u.id=v_uid;
  select id into v_payment_id from public.payments where order_id=p_order_id and payment_type=v_payment_type and status='pending' and provider_reference='buyer_report' order by created_at desc limit 1 for update;
  if v_payment_id is not null then update public.payments set amount=p_amount,method='transfer'::public.payment_method,provider_reference='buyer_report' where id=v_payment_id;
  else insert into public.payments(order_id,payment_type,amount,method,status,provider_reference) values(p_order_id,v_payment_type,p_amount,'transfer'::public.payment_method,'pending'::public.payment_status,'buyer_report') returning id into v_payment_id; end if;
  update public.orders set status='payment_unresolved'::public.order_status,payment_unresolved_at=coalesce(payment_unresolved_at,now()),payment_escalated_at=null,awaiting_confirmation_since=null where id=p_order_id;
  perform public.create_notification(v_vendor_user_id,'manual_payment_reported','Payment unresolved',coalesce(v_buyer_name,'The buyer')||' says they paid '||coalesce(v_vendor_name,'your shop')||' directly by bank transfer. Check your account and either confirm the payment or raise a dispute.','orderDetail',jsonb_build_object('orderId',p_order_id),v_uid);
  return jsonb_build_object('success',true,'payment_id',v_payment_id,'order_completed',false,'status','payment_unresolved','message','Payment reported. The order is now Payment unresolved until the vendor confirms the payment or raises a dispute.');
end;$$;


--
-- Name: buyer_respond_quantity_proposal(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buyer_respond_quantity_proposal(p_order_id uuid, p_accept boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid(); v_order public.orders%rowtype; v_vendor_user uuid; v_buyer_name text;
  v_line jsonb; v_old int; v_new int; v_total numeric;
begin
  if v_uid is null then raise exception 'You must be logged in.' using errcode='42501'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.' using errcode='P0002'; end if;
  if v_order.buyer_id <> v_uid then raise exception 'This is not your order.' using errcode='42501'; end if;
  if v_order.quantity_proposal is null then raise exception 'There is no suggestion to respond to.' using errcode='22023'; end if;
  if v_order.status <> 'pending' then
    update public.orders set quantity_proposal = null where id = p_order_id;
    raise exception 'This order has already moved on.' using errcode='22023';
  end if;
  select user_id into v_vendor_user from public.vendors where id = v_order.vendor_id;
  select coalesce(nullif(trim(name), ''), 'The customer') into v_buyer_name from public.users where id = v_uid;
  if p_accept then
    for v_line in select * from jsonb_array_elements(v_order.quantity_proposal->'items') loop
      select quantity into v_old from public.order_items where id = (v_line->>'id')::uuid and order_id = p_order_id for update;
      if not found then continue; end if;
      v_new := (v_line->>'suggested')::int;
      if v_new < 0 or v_new > v_old then continue; end if;
      if v_new = 0 then delete from public.order_items where id = (v_line->>'id')::uuid;
      else update public.order_items set quantity = v_new where id = (v_line->>'id')::uuid; end if;
    end loop;
    if not exists (select 1 from public.order_items where order_id = p_order_id) then
      raise exception 'The suggestion would leave your order empty.' using errcode='22023';
    end if;
    select coalesce(sum(unit_price * quantity), 0) + coalesce(v_order.delivery_fee, 0) into v_total from public.order_items where order_id = p_order_id;
    update public.orders set quantity_proposal = null, total_amount = v_total,
      deposit_amount = case when payment_timing = 'pay_before' then v_total else round(v_total * coalesce(payment_deposit_percent, 20) / 100, 2) end
    where id = p_order_id;
  else
    update public.orders set quantity_proposal = null where id = p_order_id;
  end if;
  insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, vendor_id, notification_category, metadata)
  values (v_vendor_user, 'order_quantity_response',
    case when p_accept then 'Customer accepted your suggested quantity' else 'Customer kept the original quantity' end,
    case when p_accept then v_buyer_name || ' accepted the quantity you suggested. The order is updated and ready for you to confirm.'
         else v_buyer_name || ' kept the original quantity. You can still confirm or decline the order.' end,
    'orderDetail', jsonb_build_object('orderId', p_order_id), v_uid, v_buyer_name, v_order.vendor_id, 'order',
    jsonb_build_object('order_id', p_order_id, 'kind', 'order_quantity_response'));
  return jsonb_build_object('order_id', p_order_id, 'accepted', p_accept);
end; $$;


--
-- Name: campus_school_names(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.campus_school_names() RETURNS TABLE(name text, status text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select name,status from campus_submissions where status in ('pending','approved') order by created_at desc limit 500 $$;


--
-- Name: can_call_in_conversation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_call_in_conversation(p_conversation_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.conversations c join public.vendors v on v.id = c.vendor_id
    where c.id = p_conversation_id and (c.buyer_id = auth.uid() or v.user_id = auth.uid())
      and (
        public.buyer_can_message_vendor(c.buyer_id, c.vendor_id)
        or (
          -- an existing two-party chat with no orders between them stays callable;
          -- once an order between them has finished (and its 24h window passed) it is not
          exists (select 1 from public.messages m where m.conversation_id = c.id)
          and not exists (select 1 from public.orders o where o.buyer_id = c.buyer_id and o.vendor_id = c.vendor_id)
        )
      )
  );
$$;


--
-- Name: chat_purge_candidates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.chat_purge_candidates() RETURNS TABLE(conversation_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select null::uuid where false;
$$;


--
-- Name: clear_presence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_presence() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ delete from public.app_presence where user_id=auth.uid() $$;


--
-- Name: complete_manual_password_reset(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  r public.password_reset_requests%rowtype;
  v_password text := coalesce(p_new_password,'');
begin
  if char_length(v_password) < 8 then raise exception 'Password must be at least 8 characters.'; end if;
  if char_length(v_password) > 128 then raise exception 'Password is too long.'; end if;

  select * into r from public.password_reset_requests
  where id=p_request_id and token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex')
  for update;
  if not found then raise exception 'This reset request is invalid.'; end if;
  if r.status <> 'approved' then raise exception 'This reset request has not been approved.'; end if;
  if r.expires_at < now() then
    update public.password_reset_requests set status='expired' where id=r.id;
    raise exception 'This reset request has expired.';
  end if;
  if r.user_id is null then raise exception 'The account could not be found.'; end if;

  update auth.users
  set encrypted_password=extensions.crypt(v_password,extensions.gen_salt('bf',10)),updated_at=now()
  where id=r.user_id;
  if not found then raise exception 'The account could not be found.'; end if;

  update public.users set has_password=true where id=r.user_id;
  update public.password_reset_requests set status='completed',completed_at=now() where id=r.id;
  return true;
end;
$$;


--
-- Name: compute_delivery_fee(uuid, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_delivery_fee(p_vendor_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  v_fee numeric; v_mode text; v_per_km numeric; v_lat double precision; v_lng double precision;
  v_dist_km double precision; v_r double precision := 6371; v_dlat double precision; v_dlng double precision; v_a double precision;
begin
  select coalesce(delivery_fee,0), delivery_fee_mode, coalesce(delivery_fee_per_km,0), lat, lng
    into v_fee, v_mode, v_per_km, v_lat, v_lng from vendors where id = p_vendor_id;
  if v_mode <> 'distance' or v_per_km <= 0 then return v_fee; end if;
  if v_lat is null or v_lng is null then return v_fee; end if;
  if p_buyer_lat is null or p_buyer_lng is null then
    raise exception 'Share your location to get this vendor''s delivery fee.';
  end if;
  v_dlat := radians(p_buyer_lat - v_lat);
  v_dlng := radians(p_buyer_lng - v_lng);
  v_a := sin(v_dlat/2)^2 + cos(radians(v_lat)) * cos(radians(p_buyer_lat)) * sin(v_dlng/2)^2;
  v_dist_km := v_r * 2 * atan2(sqrt(v_a), sqrt(1 - v_a));
  return round((v_per_km * greatest(v_dist_km, 1)) / 50) * 50;
end;
$$;


--
-- Name: compute_monthly_billing_amount(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_monthly_billing_amount(p_vendor_id uuid) RETURNS TABLE(listing_count integer, amount numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select count(*)::int, count(*)::numeric * 999 from public.products where vendor_id=p_vendor_id and status='active' and coalesce(billing_model,'commission')='commission'; $$;


--
-- Name: compute_product_delivery_fee(uuid, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_product_delivery_fee(p_product_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_mode text; v_fee numeric; v_per_km numeric; v_vendor_lat double precision; v_vendor_lng double precision;
  v_dist_km double precision; v_r double precision := 6371; v_dlat double precision; v_dlng double precision; v_a double precision;
BEGIN
  SELECT p.delivery_fee_mode, COALESCE(p.delivery_fee,0), COALESCE(p.delivery_fee_per_km,0), v.lat, v.lng
    INTO v_mode, v_fee, v_per_km, v_vendor_lat, v_vendor_lng
  FROM public.products p JOIN public.vendors v ON v.id = p.vendor_id WHERE p.id = p_product_id;
  IF v_mode IS NULL OR v_mode = 'free' THEN RETURN 0; END IF;
  IF v_mode = 'flat' THEN RETURN v_fee; END IF;
  IF v_mode <> 'distance' THEN RETURN 0; END IF;
  IF v_per_km <= 0 THEN RETURN 0; END IF;
  IF v_vendor_lat IS NULL OR v_vendor_lng IS NULL THEN RETURN v_fee; END IF;
  IF p_buyer_lat IS NULL OR p_buyer_lng IS NULL THEN
    RAISE EXCEPTION 'Share your location to get this product''s delivery fee.';
  END IF;
  v_dlat := radians(p_buyer_lat - v_vendor_lat);
  v_dlng := radians(p_buyer_lng - v_vendor_lng);
  v_a := sin(v_dlat/2)^2 + cos(radians(v_vendor_lat)) * cos(radians(p_buyer_lat)) * sin(v_dlng/2)^2;
  v_dist_km := v_r * 2 * atan2(sqrt(v_a), sqrt(1 - v_a));
  -- a distance fee is never free: at least one kilometre is charged
  RETURN round((v_per_km * greatest(v_dist_km, 1)) / 50) * 50;
END;
$$;


--
-- Name: confirm_service_offer_payment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_service_offer_payment(p_offer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_offer public.service_offers%rowtype; v_payment_id uuid; v_buyer_name text; v_dispute_id uuid;
begin
  select * into v_offer from public.service_offers where id=p_offer_id for update; if v_offer.id is null then raise exception 'Offer not found.'; end if;
  if not exists(select 1 from public.vendors v where v.id=v_offer.vendor_id and v.user_id=v_uid) then raise exception 'Only the vendor can confirm this payment.' using errcode='42501'; end if;
  if v_offer.status not in ('payment_reported','disputed') then raise exception 'This service payment is not awaiting confirmation.' using errcode='22023'; end if;
  select id into v_payment_id from public.payments where order_id=v_offer.order_id and payment_type='sale_price' and status='pending' and provider_reference='service_offer_report' order by created_at desc limit 1 for update; if v_payment_id is null then raise exception 'Reported payment record not found.'; end if;
  update public.payments set status='paid',paid_at=coalesce(paid_at,now()),provider_reference='service_offer_confirmed' where id=v_payment_id;
  update public.orders set status='completed',completed_at=coalesce(completed_at,now()),awaiting_confirmation_since=null,payment_unresolved_at=null,payment_escalated_at=null where id=v_offer.order_id and status<>'cancelled';
  select id into v_dispute_id from public.disputes where order_id=v_offer.order_id and status='open' order by created_at desc limit 1; if v_dispute_id is not null then update public.disputes set status='resolved',admin_notes=coalesce(admin_notes,'') || case when coalesce(admin_notes,'')='' then '' else E'\n' end || 'Vendor confirmed the reported service payment.' where id=v_dispute_id; end if;
  update public.service_offers set status='completed',completed_at=now(),updated_at=now() where id=v_offer.id;
  select name into v_buyer_name from public.users where id=v_offer.buyer_id;
  perform public.create_notification(v_offer.buyer_id,'service_offer_completed','Payment confirmed','The vendor confirmed receipt of your service payment. The booking is complete and ready for review.','orderDetail',jsonb_build_object('orderId',v_offer.order_id,'serviceOfferId',v_offer.id,'reviewEligible',true),v_uid);
  return jsonb_build_object('success',true,'status','completed','order_id',v_offer.order_id);
end;$$;


--
-- Name: conversation_is_open(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.conversation_is_open(p_conversation_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.conversations c join public.vendors v on v.id = c.vendor_id
    where c.id = p_conversation_id
      and (c.buyer_id = auth.uid() or v.user_id = auth.uid())
      and public.buyer_can_message_vendor(c.buyer_id, c.vendor_id)
  );
$$;


--
-- Name: create_cart_order(uuid, jsonb, public.delivery_method, text, text, double precision, double precision, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_cart_order(p_vendor_id uuid, p_items jsonb, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text, p_buyer_lat double precision DEFAULT NULL::double precision, p_buyer_lng double precision DEFAULT NULL::double precision, p_buyer_note text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
 v_buyer_id uuid:=auth.uid(); v_vendor_active boolean; v_vendor_user_id uuid; v_order_id uuid; v_delivery_fee numeric:=0; v_items_total numeric:=0; v_item jsonb; v_product_id uuid; v_variant_id uuid; v_variant_product_id uuid; v_qty int; v_price numeric; v_discount numeric; v_unit_price numeric; v_available int; v_payment_timing text:=''; v_item_timing text; v_payment_deposit_percent numeric; v_item_deposit_percent numeric;
begin
 if v_buyer_id is null then raise exception 'must be signed in'; end if;
 if is_admin() then raise exception 'admin accounts cannot make purchases on Levromart'; end if;
 if p_items is null or jsonb_array_length(p_items)=0 then raise exception 'Your cart is empty.'; end if;
 select is_active,user_id into v_vendor_active,v_vendor_user_id from vendors where id=p_vendor_id;
 if v_vendor_active is not true then raise exception 'this shop is currently paused and not accepting orders'; end if;
 if v_vendor_user_id=v_buyer_id then raise exception 'You can''t buy from your own shop.'; end if;
 insert into orders(buyer_id,vendor_id,order_type,status,total_amount,deposit_amount,delivery_method,delivery_address,delivery_phone,delivery_fee,buyer_note,payment_timing,payment_deposit_percent)
 values(v_buyer_id,p_vendor_id,'sale','pending',0,0,p_delivery_method,p_delivery_address,p_delivery_phone,0,nullif(trim(p_buyer_note),''),'pay_before',100) returning id into v_order_id;
 for v_item in select * from jsonb_array_elements(p_items) loop
   v_product_id:=nullif(v_item->>'product_id','')::uuid; v_variant_id:=nullif(v_item->>'variant_id','')::uuid; v_qty:=(v_item->>'quantity')::int;
   if v_product_id is null or v_qty is null or v_qty<=0 then raise exception 'invalid item in your cart'; end if;
   select sale_price,discount_price,quantity_available,payment_timing,payment_deposit_percent into v_price,v_discount,v_available,v_item_timing,v_item_deposit_percent from products where id=v_product_id and vendor_id=p_vendor_id and status='active' for update;
   if v_price is null then raise exception 'One of the items in your cart is no longer available.'; end if;
   -- Buyers may order more than the counter shows; the vendor can suggest the quantity they can actually supply.
   v_item_timing:=case when v_item_timing in ('pay_before','pay_after') then v_item_timing else 'pay_before' end;
   v_item_deposit_percent:=case when v_item_timing='pay_after' then greatest(1,least(99,coalesce(v_item_deposit_percent,20))) else null end;
   if p_delivery_method='delivery' then
     if v_payment_timing='' then v_payment_timing:=v_item_timing; elsif v_payment_timing<>v_item_timing then raise exception 'These cart items use different delivery payment plans. Please check out them separately.'; end if;
     if v_item_timing='pay_after' then
       if v_payment_deposit_percent is null then v_payment_deposit_percent:=v_item_deposit_percent; elsif abs(v_payment_deposit_percent-v_item_deposit_percent)>0.001 then raise exception 'These cart items use different delivery deposit percentages. Please check out them separately.'; end if;
     end if;
   end if;
   if v_variant_id is not null then
     select product_id into v_variant_product_id from product_variants where id=v_variant_id;
     if v_variant_product_id is distinct from v_product_id then raise exception 'invalid product variety'; end if;
     select sale_price,discount_price into v_price,v_discount from product_variants where id=v_variant_id;
     if v_price is null then raise exception 'Selected product variety is no longer available.'; end if;
   end if;
   v_unit_price:=case when v_discount is not null and v_discount>0 and v_discount<v_price then v_discount else v_price end;
   update products set quantity_available=greatest(quantity_available-v_qty,0) where id=v_product_id;
   insert into order_items(order_id,product_id,quantity,unit_price,variant_id) values(v_order_id,v_product_id,v_qty,v_unit_price,v_variant_id);
   v_items_total:=v_items_total+(v_unit_price*v_qty);
   if p_delivery_method='delivery' then v_delivery_fee:=v_delivery_fee+compute_product_delivery_fee(v_product_id,p_buyer_lat,p_buyer_lng); end if;
 end loop;
 update orders set total_amount=v_items_total+v_delivery_fee,delivery_fee=v_delivery_fee,
   payment_timing=case when p_delivery_method='delivery' and v_payment_timing<>'' then v_payment_timing else 'pay_before' end,
   payment_deposit_percent=case when p_delivery_method='delivery' and v_payment_timing='pay_after' then v_payment_deposit_percent else 100 end,
   deposit_amount=case when p_delivery_method='delivery' and v_payment_timing='pay_after' then round((v_items_total+v_delivery_fee)*v_payment_deposit_percent/100,2) else v_items_total+v_delivery_fee end
 where id=v_order_id;
 return v_order_id;
end;$$;


--
-- Name: create_chat_list(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_chat_list(p_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_id uuid;
begin
  if trim(coalesce(p_name,'')) = '' then
    raise exception 'List name cannot be empty';
  end if;
  insert into chat_lists(user_id, name) values (auth.uid(), trim(p_name))
  returning id into v_id;
  return v_id;
end;
$$;


--
-- Name: create_commission_payment_intent(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_commission_payment_intent(p_vendor_id uuid) RETURNS TABLE(reference text, amount numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_owed numeric(12,2); v_reference text;
begin
 if not owns_vendor(p_vendor_id) then raise exception 'not authorized'; end if;
 select coalesce(sum(c.amount),0) into v_owed from commission_charges c join orders o on o.id=c.order_id where c.vendor_id=p_vendor_id and c.status='owed' and o.status='completed';
 if v_owed<=0 then raise exception 'No commission currently owed.'; end if;
 v_reference:='commission_'||replace(gen_random_uuid()::text,'-','');
 insert into commission_settlements(vendor_id,amount,status,provider_reference) values(p_vendor_id,v_owed,'pending',v_reference);
 return query select v_reference,v_owed;
end;
$$;


--
-- Name: create_notification(uuid, text, text, text, text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification(p_user_id uuid, p_type text, p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_actor_name text;
  v_actor_avatar text;
begin
  if p_user_id is null then
    return;
  end if;
  if p_actor_id is not null then
    select name, avatar_url into v_actor_name, v_actor_avatar from users where id = p_actor_id;
  end if;
  insert into notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, actor_avatar_url)
  values (p_user_id, p_type, p_title, p_body, p_target_view, coalesce(p_target_params, '{}'::jsonb), p_actor_id, v_actor_name, v_actor_avatar);
end;
$$;


--
-- Name: create_package_order(uuid, public.delivery_method, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_package_order(p_package_id uuid, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_id uuid := auth.uid();
  v_pkg record;
  v_delivery_fee numeric := 0;
  v_total numeric;
  v_order_id uuid;
  item record;
begin
  if v_buyer_id is null then
    raise exception 'must be signed in';
  end if;
  if is_admin() then
    raise exception 'admin accounts cannot make purchases on Levromart';
  end if;

  select * into v_pkg from vendor_packages where id = p_package_id and status = 'active';
  if v_pkg.id is null then
    raise exception 'package is not available';
  end if;

  for item in
    select pi.product_id, pi.quantity, p.quantity_available, p.status
    from package_items pi join products p on p.id = pi.product_id
    where pi.package_id = p_package_id
    for update of p
  loop
    if item.status <> 'active' or item.quantity_available < item.quantity then
      raise exception 'one or more items in this package is no longer available';
    end if;
  end loop;

  if p_delivery_method = 'delivery' then
    select coalesce(delivery_fee, 0) into v_delivery_fee from vendors where id = v_pkg.vendor_id;
  end if;

  v_total := v_pkg.price + v_delivery_fee;

  insert into orders (buyer_id, vendor_id, order_type, status, total_amount, deposit_amount, delivery_method, delivery_address, delivery_phone, delivery_fee, package_id)
  values (v_buyer_id, v_pkg.vendor_id, 'sale', 'pending', v_total, 0, p_delivery_method, p_delivery_address, p_delivery_phone, v_delivery_fee, p_package_id)
  returning id into v_order_id;

  for item in select pi.product_id, pi.quantity, p.sale_price from package_items pi join products p on p.id = pi.product_id where pi.package_id = p_package_id
  loop
    update products set quantity_available = quantity_available - item.quantity where id = item.product_id;
    insert into order_items (order_id, product_id, quantity, unit_price) values (v_order_id, item.product_id, item.quantity, coalesce(item.sale_price, 0));
  end loop;

  return v_order_id;
end;
$$;


--
-- Name: create_payment_intent(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_payment_intent(p_order_id uuid) RETURNS TABLE(reference text, amount numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order orders%rowtype;
  v_reference text;
  v_fee_type payment_type;
begin
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;
  if v_order.buyer_id <> auth.uid() then
    raise exception 'not authorized';
  end if;
  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'this order can no longer be paid online';
  end if;

  delete from payments where order_id = p_order_id and status = 'pending';

  v_reference := 'medris_' || replace(gen_random_uuid()::text, '-', '');
  v_fee_type := case when v_order.order_type = 'sale' then 'sale_price' else 'rental_fee' end;

  insert into payments (order_id, payment_type, amount, method, status, provider_reference)
  values (p_order_id, v_fee_type, v_order.total_amount, 'card', 'pending', v_reference);

  if v_order.deposit_amount > 0 then
    insert into payments (order_id, payment_type, amount, method, status, provider_reference)
    values (p_order_id, 'deposit', v_order.deposit_amount, 'card', 'pending', v_reference);
  end if;

  return query select v_reference, v_order.total_amount + v_order.deposit_amount;
end;
$$;


--
-- Name: create_rental_booking(uuid, uuid, date, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_rental_booking(p_order_item_id uuid, p_product_id uuid, p_start_date date, p_end_date date, p_quantity integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_quantity_total integer;
  v_booked integer;
  v_booking_id uuid;
  v_range daterange;
begin
  if p_quantity <= 0 then
    raise exception 'quantity must be positive';
  end if;
  if p_end_date < p_start_date then
    raise exception 'end date must be on or after start date';
  end if;

  v_range := daterange(p_start_date, p_end_date, '[]');

  select quantity_total into v_quantity_total
  from products
  where id = p_product_id
  for update;

  if v_quantity_total is null then
    raise exception 'product % not found', p_product_id;
  end if;

  select coalesce(sum(quantity), 0) into v_booked
  from bookings
  where product_id = p_product_id
    and date_range && v_range;

  if v_booked + p_quantity > v_quantity_total then
    raise exception 'not enough availability for product % in range %', p_product_id, v_range;
  end if;

  insert into bookings (product_id, order_item_id, date_range, quantity)
  values (p_product_id, p_order_item_id, v_range, p_quantity)
  returning id into v_booking_id;

  return v_booking_id;
end;
$$;


--
-- Name: create_rental_order(uuid, uuid, integer, date, date, public.delivery_method, text, text, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_rental_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_start_date date, p_end_date date, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text, p_buyer_lat double precision DEFAULT NULL::double precision, p_buyer_lng double precision DEFAULT NULL::double precision) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_buyer_id uuid:=auth.uid(); v_rental_rate numeric; v_rental_rate_unit text; v_deposit numeric; v_payment_timing text; v_payment_deposit_percent numeric; v_days integer; v_units integer; v_item_total numeric; v_delivery_fee numeric:=0; v_total numeric; v_order_id uuid; v_order_item_id uuid; v_vendor_active boolean; v_vendor_user_id uuid;
begin
 if v_buyer_id is null then raise exception 'must be signed in'; end if;
 if is_admin() then raise exception 'admin accounts cannot make purchases on Levromart'; end if;
 if p_quantity<=0 then raise exception 'quantity must be positive'; end if;
 select is_active,user_id into v_vendor_active,v_vendor_user_id from vendors where id=p_vendor_id;
 if v_vendor_active is not true then raise exception 'this shop is currently paused and not accepting orders'; end if;
 if v_vendor_user_id=v_buyer_id then raise exception 'You can''t rent from your own shop.'; end if;
 select rental_rate,rental_rate_unit,coalesce(deposit_amount,0),payment_timing,payment_deposit_percent into v_rental_rate,v_rental_rate_unit,v_deposit,v_payment_timing,v_payment_deposit_percent from products where id=p_product_id and vendor_id=p_vendor_id and status='active';
 if v_rental_rate is null then raise exception 'product is not available to rent'; end if;
 v_payment_timing:=case when v_payment_timing in ('pay_before','pay_after') then v_payment_timing else 'pay_before' end;
 v_payment_deposit_percent:=case when v_payment_timing='pay_after' then greatest(1,least(99,coalesce(v_payment_deposit_percent,20))) else null end;
 v_days:=(p_end_date-p_start_date)+1; if v_days<1 then raise exception 'invalid date range'; end if;
 v_units:=case when v_rental_rate_unit='week' then ceil(v_days::numeric/7) else v_days end;
 v_item_total:=v_rental_rate*v_units*p_quantity;
 if p_delivery_method='delivery' then v_delivery_fee:=compute_product_delivery_fee(p_product_id,p_buyer_lat,p_buyer_lng); end if;
 v_total:=v_item_total+v_delivery_fee;
 insert into orders(buyer_id,vendor_id,order_type,status,total_amount,deposit_amount,delivery_method,delivery_address,delivery_phone,delivery_fee,payment_timing,payment_deposit_percent) values(v_buyer_id,p_vendor_id,'rental','pending',v_total,v_deposit*p_quantity,p_delivery_method,p_delivery_address,p_delivery_phone,v_delivery_fee,case when p_delivery_method='delivery' then v_payment_timing else 'pay_before' end,case when p_delivery_method='delivery' and v_payment_timing='pay_after' then v_payment_deposit_percent else null end) returning id into v_order_id;
 insert into order_items(order_id,product_id,quantity,unit_price,rental_start_date,rental_end_date) values(v_order_id,p_product_id,p_quantity,v_rental_rate,p_start_date,p_end_date) returning id into v_order_item_id;
 perform public.create_rental_booking(v_order_item_id,p_product_id,p_start_date,p_end_date,p_quantity);
 return v_order_id;
end;$$;


--
-- Name: create_sale_order(uuid, uuid, integer, public.delivery_method, text, text, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text, p_buyer_lat double precision DEFAULT NULL::double precision, p_buyer_lng double precision DEFAULT NULL::double precision) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_buyer_id uuid := auth.uid(); v_sale_price numeric; v_discount_price numeric; v_unit_price numeric;
  v_available integer; v_item_total numeric; v_delivery_fee numeric := 0; v_total numeric; v_order_id uuid;
  v_vendor_active boolean; v_vendor_user_id uuid;
BEGIN
  IF v_buyer_id IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  IF is_admin() THEN RAISE EXCEPTION 'admin accounts cannot make purchases on Levromart'; END IF;
  IF p_quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  SELECT is_active, user_id INTO v_vendor_active, v_vendor_user_id FROM vendors WHERE id = p_vendor_id;
  IF v_vendor_active IS NOT TRUE THEN RAISE EXCEPTION 'this shop is currently paused and not accepting orders'; END IF;
  IF v_vendor_user_id = v_buyer_id THEN RAISE EXCEPTION 'You can''t buy from your own shop.'; END IF;
  SELECT sale_price, discount_price, quantity_available INTO v_sale_price, v_discount_price, v_available
  FROM products WHERE id = p_product_id AND vendor_id = p_vendor_id AND status = 'active' FOR UPDATE;
  IF v_sale_price IS NULL THEN RAISE EXCEPTION 'product is not available for sale'; END IF;
  IF v_available < p_quantity THEN RAISE EXCEPTION 'not enough stock available'; END IF;
  v_unit_price := CASE WHEN v_discount_price IS NOT NULL AND v_discount_price > 0 AND v_discount_price < v_sale_price THEN v_discount_price ELSE v_sale_price END;
  UPDATE products SET quantity_available = quantity_available - p_quantity WHERE id = p_product_id;
  v_item_total := v_unit_price * p_quantity;
  IF p_delivery_method = 'delivery' THEN v_delivery_fee := compute_product_delivery_fee(p_product_id, p_buyer_lat, p_buyer_lng); END IF;
  v_total := v_item_total + v_delivery_fee;
  INSERT INTO orders (buyer_id, vendor_id, order_type, status, total_amount, deposit_amount, delivery_method, delivery_address, delivery_phone, delivery_fee)
  VALUES (v_buyer_id, p_vendor_id, 'sale', 'pending', v_total, 0, p_delivery_method, p_delivery_address, p_delivery_phone, v_delivery_fee)
  RETURNING id INTO v_order_id;
  INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (v_order_id, p_product_id, p_quantity, v_unit_price);
  RETURN v_order_id;
END;
$$;


--
-- Name: create_sale_order(uuid, uuid, integer, public.delivery_method, text, text, double precision, double precision, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text, p_buyer_lat double precision DEFAULT NULL::double precision, p_buyer_lng double precision DEFAULT NULL::double precision, p_buyer_note text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_buyer_id uuid := auth.uid(); v_sale_price numeric; v_discount_price numeric; v_unit_price numeric;
  v_available integer; v_item_total numeric; v_delivery_fee numeric := 0; v_total numeric; v_order_id uuid;
  v_vendor_active boolean; v_vendor_user_id uuid;
BEGIN
  IF v_buyer_id IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  IF is_admin() THEN RAISE EXCEPTION 'admin accounts cannot make purchases on Levromart'; END IF;
  IF p_quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  SELECT is_active, user_id INTO v_vendor_active, v_vendor_user_id FROM vendors WHERE id = p_vendor_id;
  IF v_vendor_active IS NOT TRUE THEN RAISE EXCEPTION 'this shop is currently paused and not accepting orders'; END IF;
  IF v_vendor_user_id = v_buyer_id THEN RAISE EXCEPTION 'You can''t buy from your own shop.'; END IF;
  SELECT sale_price, discount_price, quantity_available INTO v_sale_price, v_discount_price, v_available
  FROM products WHERE id = p_product_id AND vendor_id = p_vendor_id AND status = 'active' FOR UPDATE;
  IF v_sale_price IS NULL THEN RAISE EXCEPTION 'product is not available for sale'; END IF;
  IF v_available < p_quantity THEN RAISE EXCEPTION 'not enough stock available'; END IF;
  v_unit_price := CASE WHEN v_discount_price IS NOT NULL AND v_discount_price > 0 AND v_discount_price < v_sale_price THEN v_discount_price ELSE v_sale_price END;
  UPDATE products SET quantity_available = quantity_available - p_quantity WHERE id = p_product_id;
  v_item_total := v_unit_price * p_quantity;
  IF p_delivery_method = 'delivery' THEN v_delivery_fee := compute_product_delivery_fee(p_product_id, p_buyer_lat, p_buyer_lng); END IF;
  v_total := v_item_total + v_delivery_fee;
  INSERT INTO orders (buyer_id, vendor_id, order_type, status, total_amount, deposit_amount, delivery_method, delivery_address, delivery_phone, delivery_fee, buyer_note)
  VALUES (v_buyer_id, p_vendor_id, 'sale', 'pending', v_total, 0, p_delivery_method, p_delivery_address, p_delivery_phone, v_delivery_fee, NULLIF(TRIM(p_buyer_note), ''))
  RETURNING id INTO v_order_id;
  INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (v_order_id, p_product_id, p_quantity, v_unit_price);
  RETURN v_order_id;
END;
$$;


--
-- Name: create_sale_order(uuid, uuid, integer, public.delivery_method, text, text, double precision, double precision, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text DEFAULT NULL::text, p_buyer_lat double precision DEFAULT NULL::double precision, p_buyer_lng double precision DEFAULT NULL::double precision, p_buyer_note text DEFAULT NULL::text, p_variant_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
 v_buyer_id uuid:=auth.uid(); v_sale_price numeric; v_discount_price numeric; v_unit_price numeric; v_available integer; v_item_total numeric; v_delivery_fee numeric:=0; v_total numeric; v_order_id uuid; v_vendor_active boolean; v_vendor_user_id uuid; v_variant_product_id uuid; v_payment_timing text; v_payment_deposit_percent numeric; v_is_service boolean; v_billing_model text; v_commission_exempt boolean; v_track_quantity boolean; v_variant_available integer;
begin
 if v_buyer_id is null then raise exception 'must be signed in'; end if;
 if public.is_admin() then raise exception 'admin accounts cannot make purchases on Levromart'; end if;
 if p_quantity<=0 then raise exception 'quantity must be positive'; end if;
 select is_active,user_id into v_vendor_active,v_vendor_user_id from public.vendors where id=p_vendor_id;
 if v_vendor_active is not true then raise exception 'this shop is currently paused and not accepting orders'; end if;
 if v_vendor_user_id=v_buyer_id then raise exception 'You can''t buy from your own shop.'; end if;
 select sale_price,discount_price,quantity_available,payment_timing,payment_deposit_percent,is_service,billing_model,track_quantity into v_sale_price,v_discount_price,v_available,v_payment_timing,v_payment_deposit_percent,v_is_service,v_billing_model,v_track_quantity from public.products where id=p_product_id and vendor_id=p_vendor_id and status='active' for update;
 if v_sale_price is null then raise exception 'product is not available for sale'; end if;
 -- Buyers are no longer hard-blocked by a stock counter reaching zero --
 -- some listings (food, made-to-order items) were never truly "out of
 -- stock" in the way a fixed-inventory product is, and even for ones that
 -- are, the vendor is in a better position than a raw number to say
 -- whether they can still fulfil one more order. The counter still moves
 -- (floored at zero) and still drives the low/out-of-stock notification
 -- to the vendor -- it just no longer refuses the order outright.
 if p_variant_id is not null then
   select product_id,quantity_available into v_variant_product_id,v_variant_available from public.product_variants where id=p_variant_id for update;
   if v_variant_product_id is distinct from p_product_id then raise exception 'invalid product variety'; end if;
   select sale_price,discount_price into v_sale_price,v_discount_price from public.product_variants where id=p_variant_id;
   if v_sale_price is null then raise exception 'selected product variety is not available for sale'; end if;
 end if;
 v_payment_timing:=case when v_payment_timing in ('pay_before','pay_after') then v_payment_timing else 'pay_before' end;
 v_payment_deposit_percent:=case when v_payment_timing='pay_after' then greatest(1,least(99,coalesce(v_payment_deposit_percent,20))) else 100 end;
 v_unit_price:=case when v_discount_price is not null and v_discount_price>0 and v_discount_price<v_sale_price then v_discount_price else v_sale_price end;
 if coalesce(v_track_quantity,true) then
   if p_variant_id is not null and v_variant_available is not null then
     update public.product_variants set quantity_available=greatest(quantity_available-p_quantity,0) where id=p_variant_id;
   else
     update public.products set quantity_available=greatest(quantity_available-p_quantity,0) where id=p_product_id;
   end if;
 end if;
 v_item_total:=v_unit_price*p_quantity;
 if p_delivery_method='delivery' then v_delivery_fee:=public.compute_product_delivery_fee(p_product_id,p_buyer_lat,p_buyer_lng); end if;
 v_total:=v_item_total+v_delivery_fee;
 v_commission_exempt:=coalesce(v_is_service,false) and coalesce(v_billing_model,'commission')='monthly';
 insert into public.orders(buyer_id,vendor_id,order_type,status,total_amount,deposit_amount,delivery_method,delivery_address,delivery_phone,delivery_fee,buyer_note,payment_timing,payment_deposit_percent,commission_exempt)
 values(v_buyer_id,p_vendor_id,'sale','pending',v_total,0,p_delivery_method,p_delivery_address,p_delivery_phone,v_delivery_fee,nullif(trim(p_buyer_note),''),v_payment_timing,v_payment_deposit_percent,v_commission_exempt)
 returning id into v_order_id;
 insert into public.order_items(order_id,product_id,quantity,unit_price,variant_id) values(v_order_id,p_product_id,p_quantity,v_unit_price,p_variant_id);
 return v_order_id;
end; $$;


--
-- Name: create_service_offer(uuid, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_service_offer(p_listing_id uuid, p_description text, p_price numeric) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_product public.products%rowtype; v_vendor_id uuid; v_vendor_user uuid; v_id uuid;
begin
 if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
 if public.is_admin() then raise exception 'Admin accounts cannot negotiate service bookings.' using errcode='42501'; end if;
 if length(trim(coalesce(p_description,''))) < 1 then raise exception 'Describe what you need from the vendor.' using errcode='22023'; end if;
 if p_price is null or p_price <= 0 then raise exception 'Enter a valid proposed price.' using errcode='22023'; end if;
 select p.* into v_product from public.products p join public.vendors v on v.id=p.vendor_id where p.id=p_listing_id and p.is_service=true and p.status='active' and p.billing_model='commission' and v.verification_status='verified' and v.is_active=true;
 if v_product.id is null then raise exception 'This service is not available for negotiation.' using errcode='22023'; end if;
 v_vendor_id:=v_product.vendor_id;
 select user_id into v_vendor_user from public.vendors where id=v_vendor_id;
 if v_vendor_user=v_uid then raise exception 'You cannot negotiate with your own service.' using errcode='22023'; end if;
 insert into public.service_offers(listing_id,buyer_id,vendor_id,description,current_price,current_offer_by,status,round_count,expires_at)
 values(p_listing_id,v_uid,v_vendor_id,trim(p_description),round(p_price,2),'buyer','pending',1,now()+interval '72 hours') returning id into v_id;
 perform public.create_notification(v_vendor_user,'service_offer_new','New service request',coalesce((select name from public.users where id=v_uid),'A buyer')||' proposed '||to_char(round(p_price,2),'FM999G999G999G990.00')||' for '||v_product.name||'.','productDetail',jsonb_build_object('productId',p_listing_id,'serviceOfferId',v_id),v_uid);
 return v_id;
end; $$;


--
-- Name: create_vendor_category(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_vendor_category(p_name text, p_sector_id uuid, p_parent_category_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_existing uuid;
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Category name is required.';
  end if;

  if not public.is_admin() and not exists (
    select 1
    from public.vendors v
    where v.user_id = auth.uid()
      and v.verification_status = 'verified'::public.vendor_verification_status
      and v.is_active = true
      and v.deleted_at is null
  ) then
    raise exception 'Only approved vendor accounts can create a new category.';
  end if;

  if p_sector_id is null or not exists (select 1 from public.sectors where id = p_sector_id) then
    raise exception 'Pick a valid sector first.';
  end if;

  if p_parent_category_id is null
     or not exists (
       select 1 from public.categories
       where id = p_parent_category_id and sector_id = p_sector_id
     ) then
    raise exception 'Choose a valid category group first.';
  end if;

  select id into v_existing
  from public.categories
  where parent_category_id = p_parent_category_id
    and sector_id = p_sector_id
    and lower(name) = lower(btrim(p_name))
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.categories(name, parent_category_id, sector_id)
  values (btrim(p_name), p_parent_category_id, p_sector_id)
  returning id into v_id;

  return v_id;
end;
$$;


--
-- Name: create_vendor_sector(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_vendor_sector(p_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_existing uuid;
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Sector name is required.';
  end if;

  if not public.is_admin() and not exists (
    select 1
    from public.vendors v
    where v.user_id = auth.uid()
      and v.verification_status = 'verified'::public.vendor_verification_status
      and v.is_active = true
      and v.deleted_at is null
  ) then
    raise exception 'Only approved vendor accounts can create a new sector.';
  end if;

  select id into v_existing
  from public.sectors
  where lower(name) = lower(btrim(p_name))
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.sectors(name, sort_order)
  values (btrim(p_name), 999)
  returning id into v_id;

  return v_id;
end;
$$;


--
-- Name: current_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public."current_role"() RETURNS public.user_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select role from public.users where id = auth.uid();
$$;


--
-- Name: delete_chat_list(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_chat_list(p_list_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  delete from chat_lists where id = p_list_id and user_id = auth.uid();
$$;


--
-- Name: delete_message(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_message(p_message_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_msg messages%rowtype;
begin
  select * into v_msg from messages where id = p_message_id for update;
  if v_msg.id is null then
    raise exception 'Message not found.';
  end if;
  if v_msg.sender_id <> auth.uid() then
    raise exception 'You can only delete your own messages.';
  end if;
  if v_msg.deleted_at is not null then
    return;
  end if;
  if v_msg.created_at < now() - interval '30 minutes' then
    raise exception 'The 30-minute delete window for this message has passed.';
  end if;

  update messages set deleted_at = now() where id = p_message_id;
end;
$$;


--
-- Name: delete_my_account(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_my_account(p_user_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE uid uuid:=coalesce(p_user_id,auth.uid()); vendor_ids uuid[]:='{}'; order_ids uuid[]:='{}'; conversation_ids uuid[]:='{}'; ai_conversation_ids uuid[]:='{}'; request_ids uuid[]:='{}'; package_ids uuid[]:='{}'; review_ids uuid[]:='{}';
BEGIN
 IF uid IS NULL OR (auth.uid() IS DISTINCT FROM uid AND NOT public.is_admin()) THEN RAISE EXCEPTION 'Not authorized to delete this account.'; END IF;
 SELECT coalesce(array_agg(id),'{}') INTO vendor_ids FROM public.vendors WHERE user_id=uid;
 SELECT coalesce(array_agg(id),'{}') INTO order_ids FROM public.orders WHERE buyer_id=uid OR vendor_id=ANY(vendor_ids);
 SELECT coalesce(array_agg(id),'{}') INTO conversation_ids FROM public.conversations WHERE buyer_id=uid OR vendor_id=ANY(vendor_ids);
 SELECT coalesce(array_agg(id),'{}') INTO ai_conversation_ids FROM public.ai_conversations WHERE user_id=uid;
 SELECT coalesce(array_agg(id),'{}') INTO request_ids FROM public.equipment_requests WHERE buyer_id=uid;
 SELECT coalesce(array_agg(id),'{}') INTO package_ids FROM public.vendor_packages WHERE vendor_id=ANY(vendor_ids);
 SELECT coalesce(array_agg(id),'{}') INTO review_ids FROM public.reviews WHERE buyer_id=uid OR vendor_id=ANY(vendor_ids);
 DELETE FROM public.ai_messages WHERE conversation_id=ANY(ai_conversation_ids); DELETE FROM public.ai_conversations WHERE user_id=uid;
 DELETE FROM public.chat_list_conversations WHERE list_id IN (SELECT id FROM public.chat_lists WHERE user_id=uid); DELETE FROM public.chat_lists WHERE user_id=uid; DELETE FROM public.chat_usage WHERE user_id=uid; DELETE FROM public.tts_usage WHERE user_id=uid;
 DELETE FROM public.push_subscriptions WHERE user_id=uid; DELETE FROM public.notifications WHERE user_id=uid; DELETE FROM public.support_requests WHERE user_id=uid; DELETE FROM public.account_appeals WHERE user_id=uid; DELETE FROM public.admin_login_otps WHERE user_id=uid; DELETE FROM public.admin_actions WHERE admin_id=uid; DELETE FROM public.suggestions WHERE sender_id=uid; DELETE FROM public.inventory WHERE owner_id=uid; DELETE FROM public.messages WHERE sender_id=uid;
 IF cardinality(conversation_ids)>0 THEN DELETE FROM public.messages WHERE conversation_id=ANY(conversation_ids); DELETE FROM public.conversations WHERE id=ANY(conversation_ids); END IF;
 IF cardinality(order_ids)>0 THEN DELETE FROM public.disputes WHERE order_id=ANY(order_ids); DELETE FROM public.payments WHERE order_id=ANY(order_ids); DELETE FROM public.reviews WHERE order_id=ANY(order_ids); DELETE FROM public.order_items WHERE order_id=ANY(order_ids); DELETE FROM public.orders WHERE id=ANY(order_ids); END IF;
 DELETE FROM public.reviews WHERE id=ANY(review_ids); DELETE FROM public.request_offers WHERE request_id=ANY(request_ids) OR vendor_id=ANY(vendor_ids); DELETE FROM public.equipment_requests WHERE buyer_id=uid; DELETE FROM public.package_favorites WHERE buyer_id=uid; DELETE FROM public.favorites WHERE buyer_id=uid;
 IF cardinality(package_ids)>0 THEN DELETE FROM public.package_items WHERE package_id=ANY(package_ids); DELETE FROM public.vendor_packages WHERE id=ANY(package_ids); END IF;
 DELETE FROM public.commission_settlements WHERE vendor_id=ANY(vendor_ids); DELETE FROM public.commission_charges WHERE vendor_id=ANY(vendor_ids); DELETE FROM public.vendor_monthly_charges WHERE vendor_id=ANY(vendor_ids); DELETE FROM public.cart_items WHERE buyer_id=uid; DELETE FROM public.products WHERE vendor_id=ANY(vendor_ids);
 UPDATE public.account_appeals SET resolved_by=NULL WHERE resolved_by=uid; UPDATE public.users SET suspended_by=NULL WHERE suspended_by=uid;
 DELETE FROM public.vendors WHERE user_id=uid; DELETE FROM public.users WHERE id=uid;
 RETURN jsonb_build_object('deleted',true,'user_id',uid);
END;$$;


--
-- Name: dispute_service_offer_payment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dispute_service_offer_payment(p_offer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_offer public.service_offers%rowtype; v_dispute_id uuid; v_vendor_name text;
begin
  select * into v_offer from public.service_offers where id=p_offer_id for update;
  if v_offer.id is null then raise exception 'Offer not found.'; end if;
  if not exists(select 1 from public.vendors v where v.id=v_offer.vendor_id and v.user_id=v_uid) then raise exception 'Only the vendor can dispute this payment.' using errcode='42501'; end if;
  if v_offer.status<>'payment_reported' then raise exception 'This payment is not in a disputable state.' using errcode='22023'; end if;
  select id into v_dispute_id from public.disputes where order_id=v_offer.order_id and status='open' order by created_at desc limit 1;
  if v_dispute_id is null then insert into public.disputes(order_id,raised_by,reason) values(v_offer.order_id,'vendor','Vendor disputes the reported service payment.') returning id into v_dispute_id; end if;
  update public.service_offers set status='disputed',updated_at=now() where id=v_offer.id;
  update public.orders set status='disputed' where id=v_offer.order_id and status<>'completed';
  select business_name into v_vendor_name from public.vendors where id=v_offer.vendor_id;
  perform public.create_notification(v_offer.buyer_id,'service_payment_disputed','Payment unresolved',coalesce(v_vendor_name,'The vendor')||' disputed the reported service payment. Levromart will review it.','orderDetail',jsonb_build_object('orderId',v_offer.order_id,'serviceOfferId',v_offer.id,'disputeId',v_dispute_id),v_uid);
  return jsonb_build_object('success',true,'status','payment_unresolved','dispute_id',v_dispute_id);
end;$$;


--
-- Name: edit_buyer_order(uuid, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_vendor_user_id uuid;
  v_vendor_name text;
  v_buyer_name text;
  v_item jsonb;
  v_item_id uuid;
  v_new_qty integer;
  v_old_qty integer;
  v_delta integer;
  v_product_id uuid;
  v_available integer;
  v_new_total numeric := 0;
  v_changed boolean := false;
  v_item_count integer := 0;
  v_items_summary text;
  v_clean_note text;
begin
  if v_uid is null then raise exception 'You must be logged in.' using errcode='42501'; end if;
  if p_order_id is null then raise exception 'Order not found.' using errcode='22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your order must contain at least one item.' using errcode='22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.' using errcode='P0002'; end if;
  if v_order.buyer_id <> v_uid then raise exception 'You are not allowed to edit this order.' using errcode='42501'; end if;
  if v_order.package_id is not null then raise exception 'Package orders cannot be edited. Please cancel the order and place a new one.' using errcode='22023'; end if;
  if v_order.status not in ('pending','confirmed') then raise exception 'This order can no longer be edited.' using errcode='22023'; end if;
  if exists (
    select 1 from public.payments
    where order_id = p_order_id and status = 'paid'
  ) then
    raise exception 'This order has already been paid for and can no longer be edited.' using errcode='22023';
  end if;

  select v.user_id, v.business_name into v_vendor_user_id, v_vendor_name
  from public.vendors v where v.id = v_order.vendor_id limit 1;
  if v_vendor_user_id is null then raise exception 'Vendor not found.' using errcode='22023'; end if;
  select coalesce(nullif(trim(u.name), ''), 'A buyer') into v_buyer_name from public.users u where u.id = v_uid;

  -- Lock every affected product before changing quantities so two simultaneous
  -- edits cannot oversell stock.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_item_id := nullif(v_item->>'id','')::uuid;
    v_new_qty := (v_item->>'quantity')::integer;
    if v_item_id is null or v_new_qty is null or v_new_qty < 0 then
      raise exception 'Each order item needs a valid quantity of zero or more.' using errcode='22023';
    end if;

    select oi.quantity, oi.product_id, p.quantity_available
      into v_old_qty, v_product_id, v_available
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.id = v_item_id and oi.order_id = p_order_id
    for update of oi, p;
    if not found then raise exception 'One of the items in this order could not be found.' using errcode='22023'; end if;

    v_delta := v_new_qty - v_old_qty;
    if v_delta > 0 and v_available < v_delta then
      raise exception 'Not enough stock is available for one of the edited items.' using errcode='22023';
    end if;

    if v_delta > 0 then
      update public.products set quantity_available = quantity_available - v_delta where id = v_product_id;
    elsif v_delta < 0 then
      update public.products set quantity_available = least(quantity_total, quantity_available + abs(v_delta)) where id = v_product_id;
    end if;

    if v_new_qty = 0 then
      delete from public.order_items where id = v_item_id and order_id = p_order_id;
      v_changed := true;
    else
      update public.order_items set quantity = v_new_qty where id = v_item_id and order_id = p_order_id;
      if v_delta <> 0 then v_changed := true; end if;
    end if;
  end loop;

  select count(*) into v_item_count from public.order_items where order_id = p_order_id;
  if v_item_count = 0 then raise exception 'Your order must contain at least one item.' using errcode='22023'; end if;

  select coalesce(sum(oi.unit_price * oi.quantity),0)
    into v_new_total
  from public.order_items oi
  where oi.order_id = p_order_id;
  v_new_total := v_new_total + coalesce(v_order.delivery_fee,0);

  v_clean_note := nullif(left(trim(coalesce(p_buyer_note,'')),500),'');
  if v_clean_note is distinct from v_order.buyer_note then v_changed := true; end if;

  update public.orders
  set total_amount = v_new_total,
      buyer_note = v_clean_note,
      deposit_amount = case when payment_timing = 'pay_before' then v_new_total else round(v_new_total * coalesce(payment_deposit_percent,20) / 100,2) end,
      payment_deposit_percent = case when payment_timing = 'pay_before' then 100 else greatest(1,least(99,coalesce(payment_deposit_percent,20))) end
  where id = p_order_id;

  select string_agg(oi.quantity || '× ' || p.name, ', ' order by p.name)
    into v_items_summary
  from public.order_items oi join public.products p on p.id = oi.product_id
  where oi.order_id = p_order_id;

  if v_changed then
    insert into public.notifications (
      user_id, type, title, body, target_view, target_params,
      actor_id, actor_name, vendor_id, notification_category, metadata
    ) values (
      v_vendor_user_id,
      'order_edited',
      'Order edited by customer',
      'A customer edited their order to ' || coalesce(v_items_summary, 'an updated order') || '.',
      'orderDetail',
      jsonb_build_object('orderId', p_order_id),
      null,
      null,
      v_order.vendor_id,
      'order',
      jsonb_build_object('order_id', p_order_id, 'kind', 'order_edited')
    );

    insert into public.notifications (
      user_id, type, title, body, target_view, target_params,
      actor_id, actor_name, vendor_id, notification_category, metadata
    ) values (
      v_uid,
      'order_edit_saved',
      'Order updated',
      'Your order with ' || coalesce(v_vendor_name, 'the vendor') || ' has been updated.',
      'orderDetail',
      jsonb_build_object('orderId', p_order_id),
      v_uid,
      v_buyer_name,
      v_order.vendor_id,
      'order',
      jsonb_build_object('order_id', p_order_id, 'kind', 'order_edit_saved')
    );
  end if;

  return jsonb_build_object('order_id', p_order_id, 'changed', v_changed, 'total_amount', v_new_total, 'items_summary', coalesce(v_items_summary,''));
end;
$$;


--
-- Name: edit_message(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.edit_message(p_message_id uuid, p_new_body text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_msg messages%rowtype;
begin
  select * into v_msg from messages where id = p_message_id for update;
  if v_msg.id is null then
    raise exception 'Message not found.';
  end if;
  if v_msg.sender_id <> auth.uid() then
    raise exception 'You can only edit your own messages.';
  end if;
  if v_msg.deleted_at is not null then
    raise exception 'This message was deleted.';
  end if;
  if v_msg.created_at < now() - interval '30 minutes' then
    raise exception 'The 30-minute edit window for this message has passed.';
  end if;
  if p_new_body is null or trim(p_new_body) = '' then
    raise exception 'Message can''t be empty.';
  end if;

  update messages set body = p_new_body, edited_at = now() where id = p_message_id;
end;
$$;


--
-- Name: edit_pending_order(uuid, jsonb, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.edit_pending_order(p_order_id uuid, p_items jsonb, p_buyer_note text DEFAULT NULL::text, p_delivery_address text DEFAULT NULL::text, p_delivery_phone text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_item record;
  v_requested jsonb;
  v_new_qty integer;
  v_old_qty integer;
  v_delta integer;
  v_items_total numeric := 0;
  v_vendor_user_id uuid;
  v_change_summary text := '';
  v_count integer := 0;
begin
  if v_buyer_id is null then raise exception 'must be signed in'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your order must contain at least one item.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found.'; end if;
  if v_order.buyer_id <> v_buyer_id then raise exception 'You can only edit your own orders.'; end if;
  if v_order.status <> 'pending' then raise exception 'This order can only be edited while it is waiting for vendor confirmation.'; end if;
  if v_order.package_id is not null then raise exception 'Package orders cannot be edited after checkout.'; end if;
  if v_order.order_type not in ('sale','rental') then raise exception 'This order type cannot be edited.'; end if;

  select user_id into v_vendor_user_id from public.vendors where id = v_order.vendor_id;
  if v_vendor_user_id is null then raise exception 'Vendor account could not be found.'; end if;

  for v_item in
    select oi.id, oi.product_id, oi.quantity, oi.unit_price, p.name, p.quantity_available
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
    for update of p
  loop
    v_requested := (select x from jsonb_array_elements(p_items) x where (x->>'order_item_id')::uuid = v_item.id limit 1);
    v_new_qty := case when v_requested is null then 0 else coalesce((v_requested->>'quantity')::integer, 0) end;
    if v_new_qty < 0 then raise exception 'Quantity cannot be negative.'; end if;
    if v_new_qty > v_item.quantity + v_item.quantity_available then
      raise exception 'Not enough stock available for %.', v_item.name;
    end if;

    v_old_qty := v_item.quantity;
    v_delta := v_new_qty - v_old_qty;
    if v_delta > 0 then
      update public.products set quantity_available = quantity_available - v_delta where id = v_item.product_id;
    elsif v_delta < 0 then
      update public.products set quantity_available = least(quantity_total, quantity_available + abs(v_delta)) where id = v_item.product_id;
    end if;

    if v_new_qty = 0 then
      delete from public.order_items where id = v_item.id;
    else
      update public.order_items set quantity = v_new_qty where id = v_item.id;
      v_items_total := v_items_total + (v_new_qty * v_item.unit_price);
      if v_new_qty <> v_old_qty then
        v_count := v_count + 1;
        v_change_summary := v_change_summary || case when v_change_summary = '' then '' else ', ' end || v_item.name || ' ×' || v_new_qty;
      end if;
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_items) x
    where not exists (
      select 1 from public.order_items oi where oi.id = (x->>'order_item_id')::uuid and oi.order_id = p_order_id
    )
    and coalesce((x->>'quantity')::integer,0) > 0
  ) then
    raise exception 'One of the selected order items is no longer part of this order.';
  end if;

  if v_items_total <= 0 or not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'Your order must contain at least one item.';
  end if;

  -- Payment terms and any refundable rental deposit are historical order
  -- snapshots. Editing a pending order changes only the item total and the
  -- buyer-provided details; it must never turn the refundable deposit into the
  -- purchase total.
  update public.orders
  set buyer_note = nullif(trim(coalesce(p_buyer_note, '')), ''),
      delivery_address = case when delivery_method = 'delivery' then nullif(trim(coalesce(p_delivery_address, delivery_address)), '') else delivery_address end,
      delivery_phone = case when delivery_method = 'delivery' then nullif(trim(coalesce(p_delivery_phone, delivery_phone)), '') else delivery_phone end,
      total_amount = v_items_total + coalesce(delivery_fee,0)
  where id = p_order_id;

  perform public.create_notification(
    v_vendor_user_id,
    'order_updated',
    'Order updated',
    'A customer edited order #' || left(replace(p_order_id::text,'-',''),8) || '. Please review the updated items before confirming.',
    'orderDetail',
    jsonb_build_object('orderId', p_order_id, 'source', 'sales'),
    v_buyer_id
  );
end;
$$;


--
-- Name: enforce_buyer_phone_on_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_buyer_phone_on_order() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_phone text;
begin
  select nullif(trim(phone),'') into v_phone from public.users where id = new.buyer_id;
  if v_phone is null then
    raise exception 'A phone number is required before placing an order.' using errcode='22023';
  end if;
  return new;
end;
$$;


--
-- Name: enforce_commission_deadlines(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_commission_deadlines(p_vendor_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_changed integer := 0;
  v_rows integer := 0;
  r record;
begin
  if p_vendor_id is not null and not (public.owns_vendor(p_vendor_id) or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  update public.vendors v
  set commission_pause_reason=null
  where v.deleted_at is null
    and v.commission_pause_reason='admin_override'
    and (p_vendor_id is null or v.id=p_vendor_id)
    and coalesce((select sum(c.amount) from public.commission_charges c join public.orders o on o.id=c.order_id
                  where c.vendor_id=v.id and c.status='owed' and o.status='completed'),0) <= 0;

  for r in
    update public.vendors v
    set is_active=false, commission_paused=true, commission_pause_reason='commission_overdue'
    where v.deleted_at is null
      and v.verification_status='verified'
      and (p_vendor_id is null or v.id=p_vendor_id)
      and coalesce(v.admin_paused,false)=false
      and coalesce(v.commission_pause_reason,'') <> 'admin_override'
      and exists(select 1 from public.commission_charges c join public.orders o on o.id=c.order_id
                 where c.vendor_id=v.id and c.status='owed' and o.status='completed' and c.due_at <= now())
      and coalesce((select sum(c2.amount) from public.commission_charges c2 join public.orders o2 on o2.id=c2.order_id
                    where c2.vendor_id=v.id and c2.status='owed' and o2.status='completed'),0) >= 100
    returning v.id, v.business_name
  loop
    v_changed := v_changed + 1;
    perform public.notify_admins(
      'Storefront paused: commission overdue',
      coalesce(r.business_name,'A vendor') || '''s storefront was automatically paused because their commission balance is overdue.',
      'adminPanel', jsonb_build_object('vendorId', r.id), null);
  end loop;

  update public.vendors v
  set is_active=true, commission_paused=false, commission_pause_reason=null
  where v.deleted_at is null
    and v.verification_status='verified'
    and (p_vendor_id is null or v.id=p_vendor_id)
    and coalesce(v.admin_paused,false)=false
    and coalesce(v.commission_paused,false)=true
    and v.commission_pause_reason in ('commission_owed','commission_overdue')
    and not (
      exists(select 1 from public.commission_charges c join public.orders o on o.id=c.order_id
             where c.vendor_id=v.id and c.status='owed' and o.status='completed' and c.due_at <= now())
      and coalesce((select sum(c2.amount) from public.commission_charges c2 join public.orders o2 on o2.id=c2.order_id
                    where c2.vendor_id=v.id and c2.status='owed' and o2.status='completed'),0) >= 100);
  get diagnostics v_rows=row_count;
  v_changed := v_changed + v_rows;
  return v_changed;
end;
$$;


--
-- Name: enforce_message_pin_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_message_pin_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  active_count integer;
begin
  delete from public.message_pins
  where user_id = new.user_id
    and conversation_id = new.conversation_id
    and expires_at is not null
    and expires_at <= now();

  select count(*) into active_count
  from public.message_pins
  where user_id = new.user_id
    and conversation_id = new.conversation_id
    and (expires_at is null or expires_at > now());

  if active_count >= 4 then
    raise exception 'You can pin a maximum of 4 messages in this chat.';
  end if;
  return new;
end;
$$;


--
-- Name: enforce_vendor_onboarding_requirements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_vendor_onboarding_requirements() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Administrators can intentionally override payout onboarding when approving
  -- a vendor. Normal vendor-side writes still enforce the requirements below.
  if public.is_admin() then
    return new;
  end if;

  if new.verification_status = 'pending'::public.vendor_verification_status then
    if nullif(trim(coalesce(new.whatsapp_number,'')),'') is null then
      raise exception 'WhatsApp number is required for a vendor application.' using errcode='22023';
    end if;
  elsif new.verification_status = 'verified'::public.vendor_verification_status then
    if nullif(trim(coalesce(new.bank_name,'')),'') is null
       or nullif(trim(coalesce(new.bank_code,'')),'') is null
       or nullif(trim(coalesce(new.account_number,'')),'') is null then
      raise exception 'Bank, bank code, and account number are required before a vendor can be verified.' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: ensure_default_category(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_default_category(p_sector_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_parent uuid; v_name text; v_cat uuid;
begin
  if p_sector_id is null then return null; end if;
  select name into v_name from public.sectors where id=p_sector_id; if v_name is null then return null; end if;
  select id into v_parent from public.categories where sector_id=p_sector_id and parent_category_id is null and lower(name)='other' limit 1;
  if v_parent is null then insert into public.categories(name,sector_id,parent_category_id) values('Other',p_sector_id,null) returning id into v_parent; end if;
  select id into v_cat from public.categories where sector_id=p_sector_id and parent_category_id=v_parent and lower(name)=lower(v_name) limit 1;
  if v_cat is null then insert into public.categories(name,sector_id,parent_category_id) values(v_name,p_sector_id,v_parent) returning id into v_cat; end if;
  return v_cat;
end $$;


--
-- Name: escalate_unresolved_payment_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.escalate_unresolved_payment_orders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record; a record; v_count integer:=0; v_payment_id uuid;
begin
  for r in select o.id,o.buyer_id,o.vendor_id,o.payment_unresolved_at,v.business_name vendor_name,bu.name buyer_name,p.id payment_id,p.amount,p.payment_type,p.created_at payment_reported_at
    from public.orders o join public.payments p on p.order_id=o.id and p.status='pending' and p.provider_reference in ('buyer_report','service_offer_report')
    left join public.vendors v on v.id=o.vendor_id left join public.users bu on bu.id=o.buyer_id
    where o.status='payment_unresolved' and o.payment_unresolved_at is not null and o.payment_unresolved_at<=now()-interval '24 hours' and o.payment_escalated_at is null
    order by o.payment_unresolved_at asc for update of o loop
      v_payment_id:=r.payment_id;
      for a in select id from public.users where role='admin' loop
        perform public.create_notification(a.id,'payment_unresolved_24h','Payment unresolved — 24h vendor action overdue',coalesce(r.vendor_name,'Vendor')||' has not confirmed or disputed the reported payment for order '||r.id::text||' within 24 hours. Customer: '||coalesce(r.buyer_name,'Buyer')||'. Please investigate and contact the vendor.','adminDisputes',jsonb_build_object('orderId',r.id,'vendorId',r.vendor_id,'buyerId',r.buyer_id,'paymentId',v_payment_id),null);
      end loop;
      update public.orders set payment_escalated_at=now() where id=r.id;
      v_count:=v_count+1;
  end loop;
  for r in select o.id,o.buyer_id,o.vendor_id,o.created_at,o.status_changed_at,o.delivery_method,o.payment_timing,o.total_amount,v.business_name vendor_name,bu.name buyer_name
    from public.orders o left join public.vendors v on v.id=o.vendor_id left join public.users bu on bu.id=o.buyer_id
    where o.status='confirmed' and o.payment_escalated_at is null and coalesce(o.status_changed_at,o.created_at)<=now()-interval '24 hours'
      and not exists(select 1 from public.payments p where p.order_id=o.id and p.payment_type in ('sale_price','rental_fee') and p.status='paid')
      and not (o.delivery_method='delivery' and o.payment_timing='pay_after' and exists(select 1 from public.payments p where p.order_id=o.id and p.payment_type='delivery_deposit_20' and p.status='paid'))
    order by coalesce(o.status_changed_at,o.created_at) asc for update of o loop
      for a in select id from public.users where role='admin' loop
        perform public.create_notification(a.id,'confirmed_order_24h','Confirmed order — 24h payment follow-up',coalesce(r.vendor_name,'Vendor')||' has a confirmed order '||r.id::text||' that has had no verified payment for 24 hours. Customer: '||coalesce(r.buyer_name,'Buyer')||'. Please investigate.','adminDisputes',jsonb_build_object('orderId',r.id,'vendorId',r.vendor_id,'buyerId',r.buyer_id),null);
      end loop;
      perform public.create_notification(r.buyer_id,'confirmed_order_24h','Payment still required','This confirmed order has been waiting for payment for 24 hours. Please complete the transfer and tap “I’ve paid the vendor”, or cancel the order.','orderDetail',jsonb_build_object('orderId',r.id),null);
      perform public.create_notification((select user_id from public.vendors where id=r.vendor_id),'confirmed_order_24h','Payment follow-up required','This confirmed order has been waiting for payment for 24 hours. Confirm payment if the customer has paid, or raise a dispute.','orderDetail',jsonb_build_object('orderId',r.id),null);
      update public.orders set payment_escalated_at=now() where id=r.id;
      v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;


--
-- Name: finalize_points_weeks(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_points_weeks() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare w record; win record; v_top jsonb; v_rows int; cur date := public.points_week_start();
begin
  perform public.points_reconcile_listings();
  for w in
    select distinct pw.week_start ws from public.points_weekly pw
     where pw.week_start < cur and not exists (select 1 from public.vendor_week_winners ww where ww.week_start = pw.week_start)
  loop
    with ranked as (
      select pw.user_id, v.id vid, v.business_name bn, pw.points pts, pw.tx_count tx,
             row_number() over (order by pw.points desc, pw.tx_count desc, pw.last_at asc) rn
        from public.points_weekly pw
        join public.vendors v on v.user_id = pw.user_id and v.deleted_at is null
         and v.verification_status = 'verified' and coalesce(v.admin_paused, false) = false
       where pw.week_start = w.ws and pw.points > 0)
    select jsonb_agg(jsonb_build_object('rank', rn, 'user_id', user_id, 'vendor_id', vid, 'business_name', bn, 'points', pts) order by rn)
      into v_top from ranked where rn <= 3;
    if v_top is null then continue; end if;
    select (v_top->0->>'user_id')::uuid uid, (v_top->0->>'vendor_id')::uuid vid, (v_top->0->>'points')::int pts,
           coalesce((select tx_count from public.points_weekly where user_id = (v_top->0->>'user_id')::uuid and week_start = w.ws), 0) tx
      into win;
    insert into public.vendor_week_winners (week_start, user_id, vendor_id, points, tx_count, top3)
    values (w.ws, win.uid, win.vid, win.pts, win.tx, v_top) on conflict (week_start) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      perform public.create_notification(win.uid, 'points_winner', 'You are Vendor of the Week!',
        'You finished first with ' || win.pts || ' points. Your shop is being promoted all week.', 'leaderboard', '{"tab":"winners"}'::jsonb, null);
    end if;
  end loop;
end $$;


--
-- Name: generate_referral_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_referral_code(p_name text) RETURNS text
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
    exit when not exists (select 1 from public.vendors where referral_code = v_code);
  end loop;
  return v_code;
end $$;


--
-- Name: get_call_party(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_call_party(p_conversation_id uuid) RETURNS TABLE(name text, avatar_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when c.buyer_id = auth.uid() then v.business_name else bu.name end,
         case when c.buyer_id = auth.uid() then coalesce(v.logo_url, vu.avatar_url) else bu.avatar_url end
  from public.conversations c
  join public.vendors v on v.id = c.vendor_id
  left join public.users bu on bu.id = c.buyer_id
  left join public.users vu on vu.id = v.user_id
  where c.id = p_conversation_id and (c.buyer_id = auth.uid() or v.user_id = auth.uid());
$$;


--
-- Name: get_comment_authors(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_comment_authors(p_user_ids uuid[]) RETURNS TABLE(user_id uuid, name text, avatar_url text, vendor_id uuid, business_name text, logo_url text, verification_status text, student_verified boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select u.id, nullif(trim(u.name),''), u.avatar_url, v.id, v.business_name, v.logo_url, v.verification_status, v.student_verified
  from public.users u
  left join lateral (select * from public.vendors vv where vv.user_id = u.id and vv.deleted_at is null order by vv.created_at limit 1) v on true
  where u.id = any(p_user_ids)
$$;


--
-- Name: get_conversation_other_party(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_other_party(p_conversation_id uuid) RETURNS TABLE(id uuid, name text, avatar_url text, phone text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select u.id, u.name, u.avatar_url, u.phone
  from conversations c
  join vendors v on v.id = c.vendor_id
  join users u on u.id = (case when c.buyer_id = auth.uid() then v.user_id else c.buyer_id end)
  where c.id = p_conversation_id
    and (c.buyer_id = auth.uid() or v.user_id = auth.uid());
$$;


--
-- Name: get_conversation_presence(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_presence(p_conversation_id uuid) RETURNS timestamp with time zone
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with other as (
    select (case when c.buyer_id = auth.uid() then v.user_id else c.buyer_id end) as uid
    from conversations c join vendors v on v.id = c.vendor_id
    where c.id = p_conversation_id and (c.buyer_id = auth.uid() or v.user_id = auth.uid())
  )
  select greatest(
    (select p.last_seen_at from user_presence p join other o on o.uid = p.user_id),
    (select max(m.created_at) from messages m join other o on o.uid = m.sender_id),
    (select u.last_sign_in_at from auth.users u join other o on o.uid = u.id)
  );
$$;


--
-- Name: get_favorite_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_favorite_count(p_product_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select count(*)::int from public.favorites where product_id = p_product_id;
$$;


--
-- Name: get_favorite_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_favorite_counts(p_product_ids uuid[]) RETURNS TABLE(product_id uuid, count integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select f.product_id, count(*)::int
  from public.favorites f
  where f.product_id = any(p_product_ids)
  group by f.product_id;
$$;


--
-- Name: get_legal_terms_consent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_legal_terms_consent() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  u public.users%rowtype;
  current_version constant text := '2026-10-02';
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into u from public.users where id = auth.uid();
  if not found then raise exception 'Account profile not found'; end if;
  return jsonb_build_object(
    'accepted', coalesce(u.legal_terms_version, '') = current_version and u.legal_terms_accepted_at is not null,
    'version', u.legal_terms_version,
    'accepted_at', u.legal_terms_accepted_at,
    'current_version', current_version
  );
end;
$$;


--
-- Name: get_manual_password_reset_status(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_manual_password_reset_status(p_request_id uuid, p_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  r public.password_reset_requests%rowtype;
begin
  select * into r from public.password_reset_requests
  where id=p_request_id and token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex') limit 1;
  if not found then
    return jsonb_build_object('status','invalid');
  end if;
  if r.status='pending' and r.expires_at < now() then
    update public.password_reset_requests set status='expired' where id=r.id and status='pending';
    return jsonb_build_object('status','expired');
  end if;
  return jsonb_build_object('status',r.status,'email',r.email,'expires_at',r.expires_at);
end;
$$;


--
-- Name: get_my_account_appeal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_account_appeal() RETURNS TABLE(id uuid, message text, status text, admin_response text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select id, message, status, admin_response, created_at
  from account_appeals
  where user_id = auth.uid()
  order by created_at desc
  limit 1;
$$;


--
-- Name: get_my_points_activity(integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_points_activity(p_limit integer DEFAULT 40, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id uuid, kind text, label text, icon text, points integer, note text, source_name text, created_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select l.id, l.kind, coalesce(r.label, initcap(replace(l.kind,'_',' '))), coalesce(r.icon,'fa-star'), l.points, l.note,
         nullif(split_part(coalesce(u.name,''),' ',1),''), l.created_at
    from public.points_ledger l
    left join public.points_rules r on r.kind = l.kind
    left join public.users u on u.id = l.source_user_id
   where l.user_id = auth.uid() and (p_before is null or l.created_at < p_before)
   order by l.created_at desc limit greatest(1, least(coalesce(p_limit,40), 100))
$$;


--
-- Name: get_my_points_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_points_summary() RETURNS jsonb
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
    'referred_by', (select vv.business_name from public.referrals rf join public.vendors vv on vv.id = rf.referrer_vendor_id where rf.referred_user_id = uid and rf.code <> 'VOID')
  ) into refs;

  select coalesce(jsonb_agg(substring(event_key from 8)), '[]'::jsonb) into socials from public.points_ledger where user_id = uid and event_key like 'social:%';

  return jsonb_build_object(
    'signed_in', true, 'is_vendor', v.id is not null, 'vendor_id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url,
    'referral_code', v.referral_code,
    'today', s_today, 'week', s_week, 'month', s_month, 'all', s_all,
    'rank', my_rank, 'vendor_total', total_v, 'week_leader_points', lead_pts,
    'next_name', nxt_name, 'next_points', nxt_pts,
    'breakdown_all', bd_all, 'breakdown_week', bd_week, 'daily', daily, 'weekly', weekly,
    'streak', streak, 'weeks_won', won, 'referrals', coalesce(refs, '{}'::jsonb), 'socials', socials,
    'week_start', cur, 'week_ends_at', ((cur + 7)::timestamp at time zone tz));
end $$;


--
-- Name: get_or_create_conversation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_conversation(p_vendor_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_id uuid := auth.uid();
  v_id uuid;
begin
  if v_buyer_id is null then
    raise exception 'must be signed in';
  end if;
  if is_admin() then
    raise exception 'admin accounts cannot message vendors';
  end if;
  if not public.buyer_can_message_vendor(v_buyer_id, p_vendor_id) then
    raise exception 'You can message this vendor once you have placed an order and they have accepted it.' using errcode = '42501';
  end if;
  select id into v_id from conversations where buyer_id = v_buyer_id and vendor_id = p_vendor_id;
  if v_id is null then
    insert into conversations (buyer_id, vendor_id) values (v_buyer_id, p_vendor_id) returning id into v_id;
  end if;
  return v_id;
end;
$$;


--
-- Name: get_or_create_custom_sector(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_custom_sector(p_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare clean_name text:=regexp_replace(trim(coalesce(p_name,'')),'\s+',' ','g'); existing_id uuid; slug_value text; begin if auth.uid() is null then raise exception 'Authentication required'; end if; if is_admin() then raise exception 'Admins do not need a vendor sector'; end if; if clean_name='' then raise exception 'Enter your business sector'; end if; select id into existing_id from public.sectors where lower(trim(name))=lower(clean_name) limit 1; if existing_id is not null then return existing_id; end if; slug_value:='custom-'||substr(md5(lower(clean_name)),1,20); insert into public.sectors(slug,name,icon,sort_order) values(slug_value,clean_name,'fa-shapes',coalesce((select max(sort_order) from public.sectors),0)+1) on conflict(slug) do update set name=excluded.name returning id into existing_id; return existing_id; end; $$;


--
-- Name: get_order_buyer_contact(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_order_buyer_contact(p_order_id uuid) RETURNS TABLE(name text, phone text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when o.status::text in ('pending','cancelled') and not is_admin() then null else u.name end,
         case when is_admin() then u.phone else null end
  from orders o
  join vendors v on v.id = o.vendor_id
  join users u on u.id = o.buyer_id
  where o.id = p_order_id and (v.user_id = auth.uid() or is_admin());
$$;


--
-- Name: get_order_vendor_payment_details(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_order_vendor_payment_details(p_order_id uuid) RETURNS TABLE(vendor_id uuid, business_name text, bank_code text, bank_name text, account_name text, account_number text, phone text, whatsapp_number text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    v.id,
    v.business_name,
    v.bank_code,
    v.bank_name,
    v.account_name,
    v.account_number,
    v.phone,
    v.whatsapp_number
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  where o.id = p_order_id
    and o.buyer_id = auth.uid()
  limit 1;
$$;


--
-- Name: get_orders_buyer_names(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_orders_buyer_names(p_order_ids uuid[]) RETURNS TABLE(order_id uuid, name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select o.id, case when o.status::text in ('pending','cancelled') and not is_admin() then null else u.name end
  from orders o join vendors v on v.id=o.vendor_id join users u on u.id=o.buyer_id
  where o.id = any(p_order_ids) and (v.user_id = auth.uid() or is_admin());
$$;


--
-- Name: get_owned_product_variants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_owned_product_variants(p_product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in.' using errcode='42501'; end if;
  if not exists(select 1 from public.products p where p.id=p_product_id and (public.owns_vendor(p.vendor_id) or public.is_admin())) then
    raise exception 'You do not have permission to view this product.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(pv) order by pv.sort_order,pv.created_at),'[]'::jsonb) into result from public.product_variants pv where pv.product_id=p_product_id;
  return result;
end;
$$;


--
-- Name: get_package_comment_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_package_comment_counts(p_package_ids uuid[]) RETURNS TABLE(package_id uuid, comment_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.id, count(c.id)::bigint
  from unnest(p_package_ids) ids(id)
  join public.vendor_packages p on p.id=ids.id
  left join public.package_comments c on c.package_id=p.id
  group by p.id
$$;


--
-- Name: get_package_favorite_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_package_favorite_counts(p_package_ids uuid[]) RETURNS TABLE(package_id uuid, favorite_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.id, count(f.id)::bigint
  from unnest(p_package_ids) ids(id)
  join public.vendor_packages p on p.id=ids.id
  left join public.package_favorites f on f.package_id=p.id
  group by p.id
$$;


--
-- Name: get_past_week_winners(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_past_week_winners(p_limit integer DEFAULT 12) RETURNS TABLE(week_start date, vendor_id uuid, business_name text, logo_url text, points integer, top3 jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select ww.week_start, ww.vendor_id, v.business_name, v.logo_url, ww.points, ww.top3
    from public.vendor_week_winners ww join public.vendors v on v.id = ww.vendor_id
   where ww.reward_status <> 'void'
   order by ww.week_start desc limit greatest(1, least(coalesce(p_limit,12), 52))
$$;


--
-- Name: get_platform_suggestions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_platform_suggestions() RETURNS TABLE(id uuid, sender_name text, is_anonymous boolean, message text, status text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return query
    select s.id, case when s.is_anonymous then null else u.name end, s.is_anonymous, s.message, s.status, s.created_at
    from suggestions s
    left join users u on u.id = s.sender_id
    where s.target_type = 'platform'
    order by s.created_at desc;
end;
$$;


--
-- Name: get_points_leaderboard(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_points_leaderboard(p_period text DEFAULT 'week'::text, p_limit integer DEFAULT 100) RETURNS TABLE(rank integer, user_id uuid, vendor_id uuid, business_name text, logo_url text, city text, avg_rating numeric, review_count integer, points bigint, tx_count bigint, is_me boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
declare cur date := public.points_week_start(); lim int := greatest(1, least(coalesce(p_limit,100), 300));
begin
  perform public.finalize_points_weeks();
  if p_period = 'month' then
    return query
    with agg as (
      select l.user_id uid, sum(l.points)::bigint pts, (count(*) filter (where l.kind = 'order_completed'))::bigint tx, max(l.created_at) la
        from public.points_ledger l
       where l.created_at >= (date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')
       group by l.user_id)
    select (row_number() over (order by coalesce(a.pts,0) desc, coalesce(a.tx,0) desc, a.la asc nulls last, v.business_name))::int,
           v.user_id, v.id, v.business_name, v.logo_url, v.city, v.avg_rating, v.review_count,
           greatest(coalesce(a.pts,0),0)::bigint, coalesce(a.tx,0)::bigint, coalesce(v.user_id = auth.uid(), false)
      from public.vendors v left join agg a on a.uid = v.user_id
     where v.is_active and v.deleted_at is null and v.verification_status = 'verified' and coalesce(v.admin_paused,false) = false
     order by 1 limit lim;
  else
    return query
    with agg as (
      select pw.user_id uid, sum(pw.points)::bigint pts, sum(pw.tx_count)::bigint tx, max(pw.last_at) la
        from public.points_weekly pw
       where p_period = 'all' or pw.week_start = case when p_period = 'last_week' then cur - 7 else cur end
       group by pw.user_id)
    select (row_number() over (order by coalesce(a.pts,0) desc, coalesce(a.tx,0) desc, a.la asc nulls last, v.business_name))::int,
           v.user_id, v.id, v.business_name, v.logo_url, v.city, v.avg_rating, v.review_count,
           greatest(coalesce(a.pts,0),0)::bigint, coalesce(a.tx,0)::bigint, coalesce(v.user_id = auth.uid(), false)
      from public.vendors v left join agg a on a.uid = v.user_id
     where v.is_active and v.deleted_at is null and v.verification_status = 'verified' and coalesce(v.admin_paused,false) = false
     order by 1 limit lim;
  end if;
end $$;


--
-- Name: get_product_comment_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_product_comment_counts(p_product_ids uuid[]) RETURNS TABLE(product_id uuid, comment_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select pc.product_id,count(*)::bigint from public.product_comments pc where pc.product_id=any(coalesce(p_product_ids,'{}'::uuid[])) group by pc.product_id; $$;


--
-- Name: get_product_reviews(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_product_reviews(p_product_id uuid) RETURNS TABLE(id uuid, rating integer, comment text, buyer_name text, buyer_avatar_url text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT r.id, r.rating, r.comment, r.buyer_name, r.buyer_avatar_url, r.created_at
  FROM public.reviews r
  JOIN public.order_items oi ON oi.order_id = r.order_id
  WHERE oi.product_id = p_product_id
  ORDER BY r.created_at DESC;
$$;


--
-- Name: get_reviewable_order_for_product(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_reviewable_order_for_product(p_product_id uuid) RETURNS TABLE(order_id uuid, vendor_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT o.id, o.vendor_id
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.product_id = p_product_id
    AND o.buyer_id = auth.uid()
    AND o.status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM public.reviews r WHERE r.order_id = o.id)
  ORDER BY o.created_at DESC
  LIMIT 1;
$$;


--
-- Name: get_service_price_hint(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_service_price_hint(p_listing_id uuid) RETURNS TABLE(booking_count bigint, min_price numeric, max_price numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select count(*)::bigint,
         min(current_price)::numeric,
         max(current_price)::numeric
  from public.service_offers
  where listing_id=p_listing_id
    and status='completed';
$$;


--
-- Name: get_shared_ai_conversation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_shared_ai_conversation(p_token uuid) RETURNS TABLE(title text, role text, content text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select c.title, m.role, m.content, m.created_at
  from ai_conversations c
  join ai_messages m on m.conversation_id = c.id
  where c.share_token = p_token
  order by m.created_at asc;
$$;


--
-- Name: get_vendor_commission_breakdown(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_commission_breakdown(p_vendor_id uuid) RETURNS TABLE(charge_id uuid, order_id uuid, payment_id uuid, sold_at timestamp with time zone, payment_type text, payment_amount numeric, commission_amount numeric, commission_rate numeric, buyer_name text, products jsonb, auto_completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid();
begin
 if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
 if not exists(select 1 from public.vendors where id=p_vendor_id and user_id=v_uid and deleted_at is null) then raise exception 'Not authorized.' using errcode='42501'; end if;
 return query
 select cc.id,cc.order_id,cc.payment_id,coalesce(o.completed_at,o.created_at),coalesce(p.payment_type::text,'order_total'),coalesce(o.total_amount,0)::numeric,round(greatest(0,coalesce(o.total_amount,0))*0.03,2)::numeric,3::numeric,coalesce(u.name,'Buyer')::text,
 coalesce((select jsonb_agg(jsonb_build_object('product_name',coalesce(pr.name,'Unnamed product'),'quantity',oi.quantity,'unit_price',oi.unit_price,'line_total',round(coalesce(oi.quantity,0)*coalesce(oi.unit_price,0),2)) order by pr.name) from public.order_items oi left join public.products pr on pr.id=oi.product_id where oi.order_id=cc.order_id),'[]'::jsonb),o.auto_completed_at
 from public.commission_charges cc left join public.payments p on p.id=cc.payment_id left join public.orders o on o.id=cc.order_id left join public.users u on u.id=o.buyer_id
 where cc.vendor_id=p_vendor_id and cc.status='owed' and o.status='completed'
 order by coalesce(o.completed_at,o.created_at) desc,cc.created_at desc;
end;
$$;


--
-- Name: get_vendor_commission_deadline(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_commission_deadline(p_vendor_id uuid) RETURNS TABLE(total_owed numeric, earliest_due_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
 select coalesce(sum(c.amount),0),min(c.due_at)
 from public.commission_charges c join public.orders o on o.id=c.order_id join public.vendors v on v.id=c.vendor_id
 where c.vendor_id=p_vendor_id and c.status='owed' and o.status='completed' and v.user_id=auth.uid() and v.deleted_at is null;
$$;


--
-- Name: get_vendor_commission_owed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_commission_owed(p_vendor_id uuid) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_owed numeric := 0;
  v_is_admin boolean := false;
begin
  if not (public.owns_vendor(p_vendor_id) or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  v_is_admin := public.is_admin();

  select coalesce(sum(c.amount),0) into v_owed
  from public.commission_charges c
  join public.orders o on o.id=c.order_id
  where c.vendor_id=p_vendor_id
    and c.status='owed'
    and o.status='completed';

  -- Reading the balance must never automatically suspend a vendor.
  -- Suspension is handled exclusively by enforce_commission_deadlines(),
  -- which checks the actual due_at timestamp.
  return v_owed;
end;
$$;


--
-- Name: get_vendor_follow_state(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_follow_state(p_vendor_id uuid) RETURNS TABLE(follower_count bigint, following boolean, muted_until timestamp with time zone, mute_mode text, notify_new_listing boolean, notify_new_service boolean, notify_new_package boolean, notify_new_variety boolean, notify_price_change boolean, notify_discount boolean)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select (select count(*) from public.vendor_follows vf where vf.vendor_id=p_vendor_id),
    exists(select 1 from public.vendor_follows vf where vf.vendor_id=p_vendor_id and vf.follower_id=auth.uid()),
    p.muted_until,coalesce(p.mute_mode,'none'),coalesce(p.notify_new_listing,true),coalesce(p.notify_new_service,true),coalesce(p.notify_new_package,true),coalesce(p.notify_new_variety,true),coalesce(p.notify_price_change,true),coalesce(p.notify_discount,true)
  from (select 1) x left join public.vendor_follow_preferences p on p.vendor_id=p_vendor_id and p.follower_id=auth.uid();
$$;


--
-- Name: get_vendor_follow_states(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_follow_states(p_vendor_ids uuid[]) RETURNS TABLE(vendor_id uuid, follower_count bigint, following boolean, muted_until timestamp with time zone, mute_mode text, notify_new_listing boolean, notify_new_service boolean, notify_new_package boolean, notify_new_variety boolean, notify_price_change boolean, notify_discount boolean)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    requested.id as vendor_id,
    (select count(*) from public.vendor_follows vf where vf.vendor_id = requested.id) as follower_count,
    exists(select 1 from public.vendor_follows vf where vf.vendor_id = requested.id and vf.follower_id = auth.uid()) as following,
    p.muted_until,
    coalesce(p.mute_mode, 'none') as mute_mode,
    coalesce(p.notify_new_listing, true) as notify_new_listing,
    coalesce(p.notify_new_service, true) as notify_new_service,
    coalesce(p.notify_new_package, true) as notify_new_package,
    coalesce(p.notify_new_variety, true) as notify_new_variety,
    coalesce(p.notify_price_change, true) as notify_price_change,
    coalesce(p.notify_discount, true) as notify_discount
  from unnest(coalesce(p_vendor_ids, '{}'::uuid[])) as requested(id)
  left join public.vendor_follow_preferences p
    on p.vendor_id = requested.id and p.follower_id = auth.uid();
$$;


--
-- Name: get_vendor_follower_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_follower_counts(p_vendor_ids uuid[]) RETURNS TABLE(vendor_id uuid, follower_count bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select v.id as vendor_id, count(vf.follower_id)::bigint as follower_count
  from unnest(coalesce(p_vendor_ids, '{}'::uuid[])) as requested(id)
  join public.vendors v on v.id = requested.id
  left join public.vendor_follows vf on vf.vendor_id = v.id
  group by v.id;
$$;


--
-- Name: get_vendor_follower_network(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_follower_network(p_vendor_id uuid) RETURNS TABLE(vendor_id uuid, business_name text, logo_url text, city text, sector_name text, follower_count bigint, is_following boolean, is_me boolean, link_level smallint, via_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with viewer as (select auth.uid() as uid),
  live as (select v.id, v.user_id, v.business_name, v.logo_url, v.city, v.sector_id from public.vendors v
           where v.deleted_at is null and v.is_active = true and v.verification_status = 'verified'),
  edges as (select l.id as src, vf.vendor_id as dst from public.vendor_follows vf join live l on l.user_id = vf.follower_id),
  f1 as (select vf.vendor_id as v from public.vendor_follows vf, viewer where vf.follower_id = viewer.uid),
  d2 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
         from f1 join edges e on e.src = f1.v join live l on l.id = f1.v
         where e.dst not in (select v from f1) group by e.dst),
  d3 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
         from d2 join edges e on e.src = d2.v join live l on l.id = d2.v
         where e.dst not in (select v from f1) and e.dst not in (select v from d2) group by e.dst),
  fans as (select l.id, l.business_name, l.logo_url, l.city, l.sector_id, l.user_id
           from public.vendor_follows vf join live l on l.user_id = vf.follower_id where vf.vendor_id = p_vendor_id),
  out as (
    select fa.id as vendor_id, fa.business_name, fa.logo_url, fa.city, s.name as sector_name,
         (select count(*) from public.vendor_follows x where x.vendor_id = fa.id) as follower_count,
         exists(select 1 from f1 where f1.v = fa.id) as is_following,
         (fa.user_id = (select uid from viewer)) as is_me,
         (case when exists(select 1 from f1 where f1.v = fa.id) then 1
               when exists(select 1 from d2 where d2.v = fa.id) then 2
               when exists(select 1 from d3 where d3.v = fa.id) then 3 else 0 end)::smallint as link_level,
         coalesce((select via from d2 where d2.v = fa.id), (select via from d3 where d3.v = fa.id)) as via_name
    from fans fa left join public.sectors s on s.id = fa.sector_id)
  select * from out order by (case link_level when 0 then 9 else link_level end), follower_count desc, business_name;
$$;


--
-- Name: get_vendor_followers(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_followers(p_vendor_id uuid) RETURNS TABLE(name text, avatar_url text, followed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare owner_id uuid; begin select v.user_id into owner_id from public.vendors v where v.id=p_vendor_id and v.deleted_at is null; if owner_id is null or auth.uid() is distinct from owner_id then raise exception 'Only the vendor owner can view the follower list'; end if; return query select coalesce(u.name,'Levromart user'),u.avatar_url,vf.created_at from public.vendor_follows vf join public.users u on u.id=vf.follower_id where vf.vendor_id=p_vendor_id order by vf.created_at desc; end; $$;


--
-- Name: get_vendor_followers_v2(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_followers_v2(p_vendor_id uuid) RETURNS TABLE(follower_id uuid, name text, avatar_url text, followed_at timestamp with time zone, is_vendor boolean, vendor_id uuid, business_name text, sector_name text, city text, link_level smallint, via_name text, is_following boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare owner_id uuid;
begin
  select v.user_id into owner_id from public.vendors v where v.id = p_vendor_id and v.deleted_at is null;
  if owner_id is null or auth.uid() is distinct from owner_id then raise exception 'Only the vendor owner can view the follower list'; end if;
  return query
  with live as (select v.id, v.user_id, v.business_name, v.city, v.sector_id from public.vendors v where v.deleted_at is null and v.is_active = true and v.verification_status = 'verified'),
  edges as (select l.id as src, vf.vendor_id as dst from public.vendor_follows vf join live l on l.user_id = vf.follower_id),
  f1 as (select vf.vendor_id as v from public.vendor_follows vf where vf.follower_id = owner_id),
  d2 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via from f1 join edges e on e.src = f1.v join live l on l.id = f1.v where e.dst not in (select v from f1) group by e.dst),
  d3 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via from d2 join edges e on e.src = d2.v join live l on l.id = d2.v where e.dst not in (select v from f1) and e.dst not in (select v from d2) group by e.dst)
  select u.id, coalesce(l.business_name, u.name, 'Levromart user'), coalesce(u.avatar_url, null), vf.created_at, (l.id is not null), l.id, l.business_name, s.name, l.city,
    (case when l.id is not null then
        (case when exists(select 1 from f1 where f1.v = l.id) then 1 when exists(select 1 from d2 where d2.v = l.id) then 2 when exists(select 1 from d3 where d3.v = l.id) then 3 else 0 end)
      else (case when exists(select 1 from public.vendor_follows c join f1 on f1.v = c.vendor_id where c.follower_id = u.id) then 2 else 0 end) end)::smallint,
    (case when l.id is not null then coalesce((select via from d2 where d2.v = l.id), (select via from d3 where d3.v = l.id))
      else (select (array_agg(x.business_name order by x.business_name))[1] from public.vendor_follows c join f1 on f1.v = c.vendor_id join public.vendors x on x.id = c.vendor_id where c.follower_id = u.id) end),
    (l.id is not null and exists(select 1 from f1 where f1.v = l.id))
  from public.vendor_follows vf join public.users u on u.id = vf.follower_id left join live l on l.user_id = u.id left join public.sectors s on s.id = l.sector_id
  where vf.vendor_id = p_vendor_id
  order by (case when l.id is not null then 0 else 1 end), 10, vf.created_at desc;
end $$;


--
-- Name: get_vendor_payment_details(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_payment_details(p_vendor_id uuid) RETURNS TABLE(id uuid, business_name text, bank_code text, bank_name text, account_number text, account_name text, phone text, whatsapp_number text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select v.id, v.business_name, v.bank_code, v.bank_name, v.account_number, v.account_name, v.phone, v.whatsapp_number
  from public.vendors v
  where v.id = p_vendor_id
    and v.deleted_at is null
    and v.verification_status = 'verified'
    and (v.is_active = true or v.commission_paused = true);
$$;


--
-- Name: get_vendor_product_regions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_product_regions(p_vendor_id uuid) RETURNS TABLE(product_id uuid, product_name text, city text, order_count bigint, total_units bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not exists (
    select 1 from vendors v where v.id = p_vendor_id and v.user_id = auth.uid()
  ) and not exists (
    select 1 from users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    raise exception 'Not authorized to view this vendor''s data';
  end if;

  return query
  select
    oi.product_id,
    p.name as product_name,
    coalesce(nullif(trim(u.city), ''), 'Unknown area') as city,
    count(distinct oi.order_id) as order_count,
    sum(oi.quantity) as total_units
  from order_items oi
  join orders o on o.id = oi.order_id
  join products p on p.id = oi.product_id
  join users u on u.id = o.buyer_id
  where o.vendor_id = p_vendor_id
    and o.status != 'cancelled'
  group by oi.product_id, p.name, coalesce(nullif(trim(u.city), ''), 'Unknown area')
  order by p.name, order_count desc;
end;
$$;


--
-- Name: get_vendor_spotlight(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_spotlight() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare cur date := public.points_week_start(); w record; leaders jsonb;
begin
  perform public.finalize_points_weeks();
  select ww.week_start, ww.points, ww.tx_count, v.id vid, v.business_name, v.logo_url, coalesce(v.cover_url, v.cover_image_url) cover,
         v.city, v.avg_rating, v.review_count, v.bio
    into w from public.vendor_week_winners ww join public.vendors v on v.id = ww.vendor_id
   where ww.week_start = cur - 7 and ww.reward_status <> 'void' and v.deleted_at is null and v.is_active = true;
  select coalesce(jsonb_agg(jsonb_build_object('rank', t.rank, 'vendor_id', t.vendor_id, 'business_name', t.business_name,
          'logo_url', t.logo_url, 'points', t.points) order by t.rank), '[]'::jsonb)
    into leaders from (select * from public.get_points_leaderboard('week', 3) where points > 0) t;
  return jsonb_build_object(
    'winner', case when w.vid is null then null else jsonb_build_object('vendor_id', w.vid, 'business_name', w.business_name,
        'logo_url', w.logo_url, 'cover', w.cover, 'city', w.city, 'avg_rating', w.avg_rating, 'review_count', w.review_count,
        'bio', left(coalesce(w.bio,''), 140), 'points', w.points, 'week_start', w.week_start) end,
    'leaders', leaders, 'week_ends_at', ((cur + 7)::timestamp at time zone 'Africa/Lagos'));
end $$;


--
-- Name: get_vendor_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_stats(p_vendor_id uuid) RETURNS TABLE(completed_orders integer, avg_rating numeric, review_count integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    (select count(*)::int from public.orders where vendor_id = p_vendor_id and status = 'completed'),
    (select coalesce(avg(rating), 0)::numeric(3,2) from public.reviews where vendor_id = p_vendor_id),
    (select count(*)::int from public.reviews where vendor_id = p_vendor_id);
$$;


--
-- Name: get_vendor_suggestions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_vendor_suggestions() RETURNS TABLE(id uuid, sender_name text, is_anonymous boolean, message text, status text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_id uuid;
begin
  select vendors.id into v_vendor_id from vendors where user_id = auth.uid() and deleted_at is null;
  if v_vendor_id is null then raise exception 'No vendor profile found.'; end if;
  return query
    select s.id, case when s.is_anonymous then null else u.name end, s.is_anonymous, s.message, s.status, s.created_at
    from suggestions s
    left join users u on u.id = s.sender_id
    where s.target_type = 'vendor' and s.target_vendor_id = v_vendor_id
    order by s.created_at desc;
end;
$$;


--
-- Name: guard_unverified_order_completion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_unverified_order_completion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_fee_paid boolean:=false; v_deposit_paid boolean:=true; v_timing text;
begin
  if NEW.status='completed' and OLD.status is distinct from 'completed' and NEW.order_type in ('sale','rental') then
    select exists(select 1 from public.payments where order_id=NEW.id and payment_type=case when NEW.order_type='sale' then 'sale_price'::public.payment_type else 'rental_fee'::public.payment_type end and status='paid') into v_fee_paid;
    v_timing:=case when NEW.payment_timing in ('pay_before','pay_after') then NEW.payment_timing else 'pay_before' end;
    if NEW.delivery_method='delivery' and v_timing='pay_after' then select exists(select 1 from public.payments where order_id=NEW.id and payment_type='delivery_deposit_20' and status='paid') into v_deposit_paid; end if;
    if not v_fee_paid or not v_deposit_paid then NEW.status:='payment_unresolved'::public.order_status; NEW.payment_unresolved_at:=coalesce(NEW.payment_unresolved_at,now()); NEW.payment_escalated_at:=null; NEW.completed_at:=null; end if;
  end if;
  return NEW;
end;$$;


--
-- Name: handle_new_levromart_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_levromart_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  clean_email text := nullif(lower(coalesce(new.email, '')), '');
  clean_phone text := nullif(coalesce(meta->>'phone', ''), '');
  clean_name text := coalesce(nullif(meta->>'name',''), nullif(meta->>'full_name',''), nullif(split_part(coalesce(new.email,''),'@',1),''), 'Levromart User');
  clean_city text := nullif(coalesce(meta->>'city',''), '');
  clean_role public.user_role := (case when meta->>'role'='vendor' then 'vendor' else 'buyer' end)::public.user_role;
  has_real_password boolean := (new.encrypted_password is not null and new.encrypted_password <> '');
  selected_role boolean := (nullif(meta->>'role','') is not null) or has_real_password;
begin
  insert into public.users (id,name,email,phone,city,role,role_selected,has_password)
  values (new.id,clean_name,clean_email,clean_phone,clean_city,clean_role,selected_role,has_real_password)
  on conflict do nothing;

  if not exists (select 1 from public.users where id=new.id) then
    insert into public.users (id,name,email,phone,city,role,role_selected,has_password)
    values (new.id,clean_name,null,null,clean_city,clean_role,selected_role,has_real_password)
    on conflict do nothing;
  end if;
  return new;
end;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.users (id, name, email, phone, role, city, avatar_url, role_selected, has_password, otp_verified_at)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), nullif(new.raw_user_meta_data->>'full_name', ''), ''),
    new.email,
    new.raw_user_meta_data->>'phone',
    coalesce(nullif(new.raw_user_meta_data->>'role','')::user_role, 'buyer'),
    new.raw_user_meta_data->>'city',
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    (nullif(new.raw_user_meta_data->>'role', '') is not null),
    (new.encrypted_password is not null and new.encrypted_password != ''),
    now()
  );
  return new;
end;
$$;


--
-- Name: increment_chat_usage(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_chat_usage(p_user_id uuid, p_limit integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_count int;
begin
  insert into chat_usage (user_id, day, count) values (p_user_id, current_date, 1)
  on conflict (user_id, day) do update set count = chat_usage.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;


--
-- Name: increment_product_view(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_product_view(p_product_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.products set view_count = view_count + 1 where id = p_product_id;
$$;


--
-- Name: increment_tts_usage(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_tts_usage(p_user_id uuid, p_chars integer, p_daily_char_limit integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_chars int;
begin
  insert into tts_usage (user_id, day, chars) values (p_user_id, current_date, p_chars)
  on conflict (user_id, day) do update set chars = tts_usage.chars + p_chars
  returning chars into v_chars;
  return v_chars <= p_daily_char_limit;
end;
$$;


--
-- Name: increment_vendor_profile_view(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_vendor_profile_view(p_vendor_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.vendors set profile_view_count = profile_view_count + 1 where id = p_vendor_id;
  insert into public.vendor_profile_view_events (vendor_id) values (p_vendor_id);
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select role = 'admin' from public.users where id = auth.uid()), false);
$$;


--
-- Name: is_blocked_between(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_blocked_between(a uuid, b uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(
    select 1 from public.blocked_users
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;


--
-- Name: is_conversation_participant(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_conversation_participant(p_conversation_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.buyer_id = auth.uid() or (select v.user_id from public.vendors v where v.id = c.vendor_id) = auth.uid())
  );
$$;


--
-- Name: is_vendor_follower(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_vendor_follower(p_vendor_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(select 1 from public.vendor_follows f where f.vendor_id=p_vendor_id and f.follower_id=auth.uid())
$$;


--
-- Name: is_vendor_owner(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_vendor_owner(p_vendor_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(select 1 from public.vendors v where v.id=p_vendor_id and v.user_id=auth.uid())
$$;


--
-- Name: levro_remove_monthly_submission_on_listing_removal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.levro_remove_monthly_submission_on_listing_removal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if TG_TABLE_NAME = 'products' then
    if (TG_OP = 'DELETE') or (TG_OP = 'UPDATE' and NEW.status = 'removed' and OLD.status <> 'removed') then
      delete from public.monthly_listing_submissions
      where kind = 'product' and listing_id = coalesce(NEW.id, OLD.id);
    end if;
  elsif TG_TABLE_NAME = 'vendor_packages' then
    if (TG_OP = 'DELETE') or (TG_OP = 'UPDATE' and NEW.status = 'removed' and OLD.status <> 'removed') then
      delete from public.monthly_listing_submissions
      where kind = 'package' and listing_id = coalesce(NEW.id, OLD.id);
    end if;
  end if;
  return coalesce(NEW, OLD);
end;
$$;


--
-- Name: levromart_stamp_order_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.levromart_stamp_order_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  status_time timestamptz;

BEGIN

  IF NEW.status IS DISTINCT FROM OLD.status THEN

    -- PostgreSQL server time at the exact status transition.
    status_time := clock_timestamp();


    NEW.status_changed_at := status_time;


    IF NEW.status = 'completed'
       AND NEW.completed_at IS NULL
    THEN
      NEW.completed_at := status_time;
    END IF;


    IF NEW.status = 'cancelled'
       AND NEW.cancelled_at IS NULL
    THEN
      NEW.cancelled_at := status_time;
    END IF;

  END IF;


  RETURN NEW;

END;
$$;


--
-- Name: list_my_chat_lists(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_chat_lists() RETURNS TABLE(id uuid, name text, conversation_ids uuid[])
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select cl.id, cl.name, coalesce(array_agg(clc.conversation_id) filter (where clc.conversation_id is not null), '{}')
  from chat_lists cl
  left join chat_list_conversations clc on clc.list_id = cl.id
  where cl.user_id = auth.uid()
  group by cl.id, cl.name, cl.created_at
  order by cl.created_at;
$$;


--
-- Name: list_my_conversations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_conversations() RETURNS TABLE(conversation_id uuid, other_id uuid, other_name text, other_avatar text, last_message text, last_message_at timestamp with time zone, unread_count integer, pinned boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    c.id,
    case when c.buyer_id = auth.uid() then v.user_id else bu.id end,
    case when c.buyer_id = auth.uid() then coalesce(v.business_name, vu.name) else bu.name end,
    case when c.buyer_id = auth.uid() then coalesce(v.logo_url, vu.avatar_url) else bu.avatar_url end,
    lm.body,
    lm.created_at,
    greatest(
      (select count(*)::int from messages m2 where m2.conversation_id = c.id and m2.read_at is null and m2.sender_id <> auth.uid()),
      case when (case when c.buyer_id = auth.uid() then c.marked_unread_by_buyer else c.marked_unread_by_vendor end) then 1 else 0 end
    ),
    case when c.buyer_id = auth.uid() then c.pinned_by_buyer else c.pinned_by_vendor end
  from conversations c
  join vendors v on v.id = c.vendor_id
  left join users bu on bu.id = c.buyer_id
  left join users vu on vu.id = v.user_id
  left join lateral (
    select body, created_at from messages m
    where m.conversation_id = c.id
    order by m.created_at desc limit 1
  ) lm on true
  where (c.buyer_id = auth.uid() or v.user_id = auth.uid())
    and public.buyer_can_message_vendor(c.buyer_id, c.vendor_id)
  order by (case when c.buyer_id = auth.uid() then c.pinned_by_buyer else c.pinned_by_vendor end) desc,
    coalesce(lm.created_at, c.created_at) desc;
$$;


--
-- Name: listing_drafts_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.listing_drafts_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$ begin new.updated_at=now(); return new; end; $$;


--
-- Name: log_auth_session_start(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_auth_session_start() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.auth_activity_logs(session_id,user_id,event_type,occurred_at,user_agent,ip,source)
  values(new.id,new.user_id,'login',new.created_at,new.user_agent,new.ip,'supabase_session')
  on conflict (session_id) do nothing;
  return new;
end; $$;


--
-- Name: lv_norm_school(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lv_norm_school(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ select lower(regexp_replace(coalesce(p,''),'[^a-zA-Z0-9]','','g')) $$;


--
-- Name: mark_conversation_opened(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_conversation_opened(p_conversation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_is_buyer boolean;
  v_buyer_id uuid;
  v_vendor_id uuid;
begin
  select c.buyer_id, c.vendor_id, (c.buyer_id = auth.uid())
    into v_buyer_id, v_vendor_id, v_is_buyer
  from public.conversations c
  join public.vendors v on v.id = c.vendor_id
  where c.id = p_conversation_id
    and (c.buyer_id = auth.uid() or v.user_id = auth.uid());

  if v_is_buyer is null then
    raise exception 'Conversation not found';
  end if;

  -- Clear unread state across any legacy duplicate buyer↔vendor threads.
  -- Older data can contain more than one conversation row for the same pair;
  -- opening one must not leave the inbox badge alive from another duplicate.
  update public.messages m
     set read_at = now(), delivered_at = coalesce(delivered_at, now())
   where m.sender_id <> auth.uid()
     and m.conversation_id in (
       select c2.id
       from public.conversations c2
       join public.vendors v2 on v2.id = c2.vendor_id
       where c2.buyer_id = v_buyer_id
         and c2.vendor_id = v_vendor_id
         and (c2.buyer_id = auth.uid() or v2.user_id = auth.uid())
     )
     and m.read_at is null;

  update public.conversations c
     set marked_unread_by_buyer = false,
         marked_unread_by_vendor = false
   where c.buyer_id = v_buyer_id
     and c.vendor_id = v_vendor_id;
end;
$$;


--
-- Name: mark_order_payment_unresolved_from_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_payment_unresolved_from_claim() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status='pending' AND NEW.provider_reference IN ('buyer_report','service_offer_report') AND NEW.order_id IS NOT NULL THEN
    UPDATE public.orders SET status='payment_unresolved'::public.order_status, payment_unresolved_at=COALESCE(payment_unresolved_at,now()), payment_escalated_at=NULL, completed_at=NULL
    WHERE id=NEW.order_id AND status<>'cancelled';
    IF NEW.provider_reference='service_offer_report' THEN
      UPDATE public.service_offers SET expires_at=NULL, updated_at=now()
      WHERE order_id=NEW.order_id AND status='payment_reported';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: mark_suggestion_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_suggestion_read(p_suggestion_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row suggestions%rowtype;
  v_vendor_id uuid;
begin
  select * into v_row from suggestions where id = p_suggestion_id;
  if v_row is null then raise exception 'Not found.'; end if;
  if v_row.target_type = 'platform' then
    if not is_admin() then raise exception 'Not allowed.'; end if;
  else
    select id into v_vendor_id from vendors where user_id = auth.uid() and deleted_at is null;
    if v_vendor_id is null or v_vendor_id != v_row.target_vendor_id then raise exception 'Not allowed.'; end if;
  end if;
  update suggestions set status = 'read' where id = p_suggestion_id;
end;
$$;


--
-- Name: nearby_vendors(double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nearby_vendors(p_lat double precision, p_lng double precision, p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, business_name text, city text, avg_rating numeric, review_count integer, logo_url text, lat double precision, lng double precision, distance_km double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select
    v.id, v.business_name, v.city, v.avg_rating, v.review_count, v.logo_url, v.lat, v.lng,
    (6371 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(v.lat)) * cos(radians(v.lng) - radians(p_lng))
      + sin(radians(p_lat)) * sin(radians(v.lat))
    )))) as distance_km
  from vendors v
  where v.verification_status = 'verified'
    and v.is_active = true
    and v.lat is not null
    and v.lng is not null
  order by distance_km asc
  limit p_limit
$$;


--
-- Name: normalize_commission_for_billing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_commission_for_billing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare v_pct numeric; v_base numeric; begin select coalesce(v.commission_pct,5) into v_pct from public.vendors v where v.id=new.vendor_id; select coalesce(sum(oi.quantity*oi.unit_price) filter (where coalesce(p.billing_model,'commission') <> 'monthly'),0) into v_base from public.order_items oi join public.products p on p.id=oi.product_id where oi.order_id=new.order_id; if v_base <= 0 then delete from public.commission_charges where id=new.id; return null; end if; update public.commission_charges set amount=round(v_base*v_pct/100,2) where id=new.id; return new; end; $$;


--
-- Name: normalize_order_payment_terms(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_order_payment_terms() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$ BEGIN IF NEW.payment_timing = 'pay_before' THEN NEW.payment_deposit_percent := 100; NEW.deposit_amount := COALESCE(NEW.total_amount, 0); ELSE IF NEW.payment_deposit_percent IS NULL OR NEW.payment_deposit_percent <= 0 OR NEW.payment_deposit_percent >= 100 THEN RAISE EXCEPTION 'Pay-after-delivery orders require a deposit percentage greater than 0 and less than 100.' USING ERRCODE='22023'; END IF; NEW.deposit_amount := ROUND((COALESCE(NEW.total_amount, 0) * NEW.payment_deposit_percent / 100), 2); END IF; RETURN NEW; END; $$;


--
-- Name: notify_admins(text, text, text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_admins(p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_admin_id uuid;
begin
  for v_admin_id in select id from users where role = 'admin' loop
    perform create_notification(v_admin_id, 'admin_alert', p_title, p_body, p_target_view, coalesce(p_target_params, '{}'::jsonb), p_actor_id);
  end loop;
end;
$$;


--
-- Name: notify_admins_on_action(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_admins_on_action() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_admin_id uuid;
begin
  for v_admin_id in select id from users where role = 'admin' and id <> new.admin_id loop
    perform create_notification(
      v_admin_id, 'admin_action_alert',
      coalesce(new.admin_name, 'An admin') || ' ' || replace(new.action, '_', ' '),
      coalesce(new.target_label, ''),
      'adminLog', '{}'::jsonb, new.admin_id
    );
  end loop;
  return new;
end;
$$;


--
-- Name: notify_comment_mentions(text, uuid, uuid, uuid, text, text, text, text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_comment_mentions(p_kind text, p_item_id uuid, p_comment_id uuid, p_author uuid, p_author_name text, p_author_avatar text, p_content text, p_item_name text, p_skip uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v record;
begin
  if p_content is null or position('@' in p_content) = 0 then return; end if;
  for v in
    select id, user_id, business_name from public.vendors
    where user_id is not null and verification_status = 'verified' and coalesce(is_active, true)
      and length(business_name) >= 2
      and strpos(lower(p_content), lower('@' || business_name)) > 0
  loop
    if v.user_id = p_author or v.user_id = any(coalesce(p_skip, '{}'::uuid[])) then continue; end if;
    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata)
    values (v.user_id,'comment_mention', p_author_name || ' mentioned you in a comment on "' || coalesce(p_item_name,'a listing') || '"', left(p_content,180),
      case when p_kind='package' then 'packageDetail' else 'productDetail' end,
      case when p_kind='package' then jsonb_build_object('packageId',p_item_id,'openComments',true) else jsonb_build_object('productId',p_item_id,'openComments',true) end,
      p_author, p_author_name, p_author_avatar, v.id, 'comment_mention', 'comment-mention:' || p_comment_id::text || ':' || v.id::text,
      jsonb_build_object('comment_id',p_comment_id,'kind',p_kind));
  end loop;
end $$;


--
-- Name: notify_email_on_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_email_on_notification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- One Vercel function now handles both email and native push delivery.
  perform net.http_post(
    url := 'https://levromart.vercel.app/api/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '<WEBHOOK_SECRET>'),
    body := jsonb_build_object('notificationId', NEW.id)
  );
  return NEW;
end;
$$;


--
-- Name: notify_new_dispute(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_dispute() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record;
begin
  for r in select id from users where role = 'admin' loop
    perform create_notification(r.id, 'new_dispute', 'New dispute raised', left(NEW.reason, 140), 'adminDisputes', '{}'::jsonb, null);
  end loop;
  return NEW;
end $$;


--
-- Name: notify_new_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_id uuid; v_vendor_user_id uuid; v_vendor_name text; v_vendor_logo text;
  v_recipient_id uuid; v_sender_name text; v_sender_avatar text; v_preview text;
begin
  select c.buyer_id, v.user_id, v.business_name, v.logo_url
    into v_buyer_id, v_vendor_user_id, v_vendor_name, v_vendor_logo
  from conversations c join vendors v on v.id = c.vendor_id
  where c.id = new.conversation_id;

  v_recipient_id := case when new.sender_id = v_buyer_id then v_vendor_user_id else v_buyer_id end;
  if new.sender_id = v_vendor_user_id then
    -- a vendor writes as their shop: shop name and logo
    v_sender_name := v_vendor_name;
    v_sender_avatar := coalesce(v_vendor_logo, (select avatar_url from users where id = new.sender_id));
  else
    select coalesce(name, email), avatar_url into v_sender_name, v_sender_avatar from users where id = new.sender_id;
  end if;
  v_preview := left(new.body, 80);

  perform create_notification(v_recipient_id, 'new_message', 'New message from ' || coalesce(v_sender_name, 'someone'),
    v_preview, 'messages',
    jsonb_build_object('conversationId', new.conversation_id, 'senderName', v_sender_name, 'senderAvatar', v_sender_avatar), new.sender_id);
  return new;
end;
$$;


--
-- Name: notify_new_offer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_offer() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_buyer_id uuid; v_vendor_name text; v_req_title text; v_vendor_user_id uuid;
begin
  select buyer_id, title into v_buyer_id, v_req_title from equipment_requests where id = NEW.request_id;
  select business_name, user_id into v_vendor_name, v_vendor_user_id from vendors where id = NEW.vendor_id;
  perform create_notification(v_buyer_id, 'new_offer', 'New offer on your request',
    coalesce(v_vendor_name, 'A vendor') || ' sent an offer for "' || v_req_title || '".',
    'requestEquipment', '{}'::jsonb, v_vendor_user_id);
  return NEW;
end $$;


--
-- Name: notify_new_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_order() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_user_id uuid; v_buyer_name text; v_vendor_name text; v_items text;
begin
  select user_id, business_name into v_vendor_user_id, v_vendor_name from vendors where id = NEW.vendor_id;
  select name into v_buyer_name from users where id = NEW.buyer_id;

  select string_agg(oi.quantity || '× ' || p.name, ', ') into v_items
  from order_items oi join products p on p.id = oi.product_id
  where oi.order_id = NEW.id;

  perform create_notification(v_vendor_user_id, 'new_order', 'New order received',
    'A customer placed a ' || NEW.order_type || ' order for ' || coalesce(v_items, 'an item') || '.',
    'vendorOrders', jsonb_build_object('status','pending'), NULL);

  perform create_notification(NEW.buyer_id, 'order_placed', 'Your order has been placed',
    'Your order for ' || coalesce(v_items, 'your item') || ' with ' || coalesce(v_vendor_name, 'the vendor') || ' is waiting for confirmation.',
    'orderDetail', jsonb_build_object('orderId', NEW.id), NULL);

  return NEW;
end $$;


--
-- Name: notify_new_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_buyer_name text; r record; v_sector_id uuid;
begin
  select name into v_buyer_name from users where id = new.buyer_id;
  if new.category_id is not null then
    select sector_id into v_sector_id from categories where id = new.category_id;
    for r in
      select distinct v.user_id, v.id as vendor_id from vendors v
      left join products p on p.vendor_id=v.id and p.status='active'
      where v.verification_status='verified' and v.is_active and v.deleted_at is null
        and coalesce(v.request_pref,'all') <> 'none'
        and (
          (coalesce(v.request_pref,'all')='all' and (p.category_id=new.category_id or v.sector_id=v_sector_id))
          or (v.request_pref='sector' and v.sector_id=v_sector_id)
        )
        and (
          coalesce(v.request_campus_scope,'all')='all'
          or (v.request_campus_scope='mine' and new.campus_id is not null and new.campus_id = v.campus_id)
          or (v.request_campus_scope='selected' and new.campus_id is not null and new.campus_id = any(coalesce(v.operating_campuses,'{}') || array[coalesce(v.campus_id,'')]))
        )
    loop
      perform create_notification(r.user_id,'new_request',
        case when exists(select 1 from products p where p.vendor_id=r.vendor_id and p.category_id=new.category_id and p.status='active') then 'New buyer request matching your category' else 'New buyer request in your sector' end,
        coalesce(v_buyer_name,'A buyer') || ' needs: ' || new.title,'vendorRequests',jsonb_build_object('request_id',new.id),new.buyer_id);
    end loop;
  end if;
  return new;
end $$;


--
-- Name: notify_new_review(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_review() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_user_id uuid;
  v_buyer_name text;
  v_avg numeric;
  v_count int;
begin
  select user_id into v_vendor_user_id from vendors where id = NEW.vendor_id;
  select name into v_buyer_name from users where id = NEW.buyer_id;

  select coalesce(avg(rating), 0)::numeric(3,2), count(*)
    into v_avg, v_count
    from reviews where vendor_id = NEW.vendor_id;

  perform create_notification(v_vendor_user_id, 'new_review', 'New review received',
    coalesce(v_buyer_name, 'A buyer') || ' left a ' || NEW.rating || '-star review' ||
    case when NEW.comment is not null and length(trim(NEW.comment)) > 0 then ': "' || left(NEW.comment, 80) || '"' else '.' end ||
    ' Your rating is now ' || round(v_avg, 1)::text || ' (' || v_count || ' review' || case when v_count = 1 then '' else 's' end || ').',
    'storefront', jsonb_build_object('vendorId', NEW.vendor_id), NEW.buyer_id);

  return NEW;
end;
$$;


--
-- Name: notify_new_user_signup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_user_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform notify_admins('New account signup',coalesce(new.name,'Someone') || ' signed up as a ' || case when new.role='vendor' then 'vendor applicant' else 'customer' end || '.', 'adminPeople', jsonb_build_object('user_id',new.id,'role',new.role,'signup_at',new.created_at), new.id);
  return new;
end $$;


--
-- Name: notify_new_vendor_application(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_vendor_application() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ begin perform notify_admins('New vendor application requires review.','A new vendor application from ' || coalesce(new.business_name,'an applicant') || ' is waiting for administrator review.','adminPanel',jsonb_build_object('vendorId',new.id,'applicationId',new.id),new.user_id); return new; end; $$;


--
-- Name: notify_offer_accepted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_offer_accepted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_vendor_user_id uuid; v_req_title text;
begin
  if NEW.status = 'accepted' and OLD.status is distinct from 'accepted' then
    select user_id into v_vendor_user_id from vendors where id = NEW.vendor_id;
    select title into v_req_title from equipment_requests where id = NEW.request_id;
    perform create_notification(v_vendor_user_id, 'offer_accepted', 'Your offer was accepted!',
      'Your offer on "' || v_req_title || '" was accepted. Contact the buyer to finalize.',
      'vendorRequests', '{}'::jsonb, null);
  elsif NEW.status = 'declined' and OLD.status is distinct from 'declined' then
    select user_id into v_vendor_user_id from vendors where id = NEW.vendor_id;
    select title into v_req_title from equipment_requests where id = NEW.request_id;
    perform create_notification(v_vendor_user_id, 'offer_declined', 'An offer was declined',
      'Your offer on "' || v_req_title || '" was not accepted this time.',
      'vendorRequests', '{}'::jsonb, null);
  end if;
  return NEW;
end $$;


--
-- Name: notify_order_status_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_order_status_changed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_user_id uuid;
  v_title text;
  v_body text;
  v_items text;
begin
  if NEW.status = OLD.status then
    return NEW;
  end if;

  select user_id into v_vendor_user_id from vendors where id = NEW.vendor_id;

  select string_agg(oi.quantity || '× ' || p.name, ', ') into v_items
  from order_items oi join products p on p.id = oi.product_id
  where oi.order_id = NEW.id;

  v_title := case NEW.status
    when 'confirmed' then 'Order confirmed'
    when 'handed_over' then 'Item handed over'
    when 'returned' then 'Item marked returned'
    when 'completed' then 'Order completed'
    when 'cancelled' then 'Order cancelled'
    when 'disputed' then 'Dispute raised on order'
    when 'payment_unresolved' then 'Payment unresolved'
    else 'Order status updated'
  end;
  v_body := coalesce(v_items, 'Your order') || ' — status changed to "' || replace(NEW.status::text, '_', ' ') || '".';

  if not (NEW.status::text = 'cancelled' and nullif(trim(coalesce(NEW.cancellation_reason,'')),'') is not null) then
    perform create_notification(NEW.buyer_id, 'order_status_changed', v_title, v_body,
      'orderDetail', jsonb_build_object('orderId', NEW.id), NULL);
  end if;
  perform create_notification(v_vendor_user_id, 'order_status_changed', v_title, v_body,
    'orderDetail', jsonb_build_object('orderId', NEW.id), NULL);

  return NEW;
end $$;


--
-- Name: notify_package_comment_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_package_comment_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare vendor_user uuid; vendor_id_value uuid; pkg_name text; parent_author uuid; skip uuid[] := '{}';
begin
  select v.user_id,v.id,p.name into vendor_user,vendor_id_value,pkg_name from public.vendor_packages p join public.vendors v on v.id=p.vendor_id where p.id=new.package_id;
  if vendor_user is not null and vendor_user<>new.user_id then
    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata)
    values(vendor_user,'product_comment',new.author_name||' commented on your package "'||coalesce(pkg_name,'your package')||'"',left(new.content,180),'packageDetail',jsonb_build_object('packageId',new.package_id,'openComments',true),new.user_id,new.author_name,new.author_avatar_url,vendor_id_value,'product_comment','package-comment:'||new.id::text,jsonb_build_object('package_id',new.package_id,'comment_id',new.id));
    skip := skip || vendor_user;
  end if;
  if new.parent_comment_id is not null then
    select pc.user_id into parent_author from public.package_comments pc where pc.id=new.parent_comment_id;
    if parent_author is not null and parent_author<>new.user_id then
      insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,notification_category,group_key,metadata)
      values(parent_author,'comment_reply',new.author_name||' replied to your comment',left(new.content,180),'packageDetail',jsonb_build_object('packageId',new.package_id,'openComments',true,'commentId',new.parent_comment_id),new.user_id,new.author_name,new.author_avatar_url,'comment_reply','comment-reply:'||new.id::text,jsonb_build_object('package_id',new.package_id,'comment_id',new.id,'parent_comment_id',new.parent_comment_id));
      skip := skip || parent_author;
    end if;
  end if;
  perform public.notify_comment_mentions('package',new.package_id,new.id,new.user_id,new.author_name,new.author_avatar_url,new.content,pkg_name,skip);
  return new;
end $$;


--
-- Name: notify_payment_paid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_payment_paid() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order orders%rowtype;
  v_vendor_user_id uuid;
  v_vendor_name text;
  v_buyer_name text;
  v_items text;
  v_label text;
begin
  if NEW.status <> 'paid' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'paid' then
    return NEW;
  end if;
  if NEW.payment_type not in ('sale_price', 'rental_fee', 'delivery_deposit_20') then
    return NEW;
  end if;

  select * into v_order from orders where id = NEW.order_id;
  if v_order.id is null then
    return NEW;
  end if;

  select user_id, business_name into v_vendor_user_id, v_vendor_name from vendors where id = v_order.vendor_id;
  select name into v_buyer_name from users where id = v_order.buyer_id;

  select string_agg(oi.quantity || '× ' || p.name, ', ') into v_items
  from order_items oi join products p on p.id = oi.product_id
  where oi.order_id = v_order.id;

  v_label := case NEW.payment_type
    when 'delivery_deposit_20' then '20% delivery deposit'
    when 'rental_fee' then 'rental fee'
    else 'remaining balance'
  end;

  perform create_notification(v_order.buyer_id, 'payment_received', 'Payment successful',
    'Your ' || v_label || ' for ' || coalesce(v_items, 'your order') || ' was received. ' || coalesce(v_vendor_name, 'The vendor') || ' has been notified.',
    'orderDetail', jsonb_build_object('orderId', v_order.id), NULL);

  perform create_notification(v_vendor_user_id, 'payment_received', 'Buyer paid for their order',
    coalesce(v_buyer_name, 'A buyer') || ' paid the ' || v_label || ' for ' || coalesce(v_items, 'their order') || '.',
    'orderDetail', jsonb_build_object('orderId', v_order.id), v_order.buyer_id);

  return NEW;
end;
$$;


--
-- Name: notify_points(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_points(p_user uuid, p_pts integer, p_note text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n record; v_total int; v_cnt int;
begin
  select id, metadata into n from public.notifications
   where user_id = p_user and type = 'points' and read = false and archived = false
     and created_at > now() - interval '3 hours'
   order by created_at desc limit 1 for update;
  if found then
    v_total := coalesce((n.metadata->>'total')::int, 0) + p_pts;
    v_cnt := coalesce((n.metadata->>'count')::int, 1) + 1;
    update public.notifications set
      title = '+' || v_total || ' points',
      body = v_cnt || ' new activities. Tap to see your breakdown.',
      metadata = jsonb_build_object('total', v_total, 'count', v_cnt),
      created_at = now()
    where id = n.id;
  else
    insert into public.notifications (user_id, type, title, body, target_view, target_params, notification_category, group_key, metadata)
    values (p_user, 'points', '+' || p_pts || ' points', coalesce(p_note, 'You earned points'), 'leaderboard',
            '{"tab":"activity"}'::jsonb, 'points', 'points:' || (now() at time zone 'Africa/Lagos')::date,
            jsonb_build_object('total', p_pts, 'count', 1));
  end if;
end $$;


--
-- Name: notify_product_comment_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_product_comment_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare vendor_user uuid; vendor_id_value uuid; product_name text; parent_author uuid; skip uuid[] := '{}';
begin
  select v.user_id,v.id,p.name into vendor_user,vendor_id_value,product_name from public.products p join public.vendors v on v.id=p.vendor_id where p.id=new.product_id;
  if vendor_user is not null and vendor_user<>new.user_id then
    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata)
    values(vendor_user,'product_comment',new.author_name||' commented on your product "'||coalesce(product_name,'your product')||'"',left(new.content,180),'productDetail',jsonb_build_object('productId',new.product_id,'openComments',true),new.user_id,new.author_name,new.author_avatar_url,vendor_id_value,'product_comment','product-comment:'||new.id::text,jsonb_build_object('product_id',new.product_id,'comment_id',new.id));
    skip := skip || vendor_user;
  end if;
  if new.parent_comment_id is not null then
    select pc.user_id into parent_author from public.product_comments pc where pc.id=new.parent_comment_id;
    if parent_author is not null and parent_author<>new.user_id then
      insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,notification_category,group_key,metadata)
      values(parent_author,'comment_reply',new.author_name||' replied to your comment',left(new.content,180),'productDetail',jsonb_build_object('productId',new.product_id,'openComments',true,'commentId',new.parent_comment_id),new.user_id,new.author_name,new.author_avatar_url,'comment_reply','comment-reply:'||new.id::text,jsonb_build_object('product_id',new.product_id,'comment_id',new.id,'parent_comment_id',new.parent_comment_id));
      skip := skip || parent_author;
    end if;
  end if;
  perform public.notify_comment_mentions('product',new.product_id,new.id,new.user_id,new.author_name,new.author_avatar_url,new.content,product_name,skip);
  return new;
end $$;


--
-- Name: notify_product_comment_like_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_product_comment_like_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare author_id uuid; product_id_value uuid; product_name text; actor_name_value text; actor_avatar text; comment_text text; begin select pc.user_id,pc.product_id,pc.content into author_id,product_id_value,comment_text from public.product_comments pc where pc.id=new.comment_id; if author_id is null or author_id=new.user_id then return new; end if; select name into product_name from public.products where id=product_id_value; select coalesce(nullif(trim(u.name),''),'A Levromart user'),u.avatar_url into actor_name_value,actor_avatar from public.users u where u.id=new.user_id; insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,notification_category,group_key,metadata) values(author_id,'comment_liked',actor_name_value||' liked your comment',left(coalesce(product_name,'Product')||': '||coalesce(comment_text,''),180),'productDetail',jsonb_build_object('productId',product_id_value,'openComments',true,'commentId',new.comment_id),new.user_id,actor_name_value,actor_avatar,'comment_liked','comment-liked:'||new.comment_id::text||':'||new.user_id::text,jsonb_build_object('product_id',product_id_value,'comment_id',new.comment_id)); return new; end; $$;


--
-- Name: notify_product_favorite_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_product_favorite_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare vendor_user uuid; vendor_id_value uuid; product_name text; actor_name_value text; actor_avatar text; begin select v.user_id,v.id,p.name into vendor_user,vendor_id_value,product_name from public.products p join public.vendors v on v.id=p.vendor_id where p.id=new.product_id; if vendor_user is null or vendor_user=new.buyer_id then return new; end if; select coalesce(nullif(trim(u.name),''),'A Levromart user'),u.avatar_url into actor_name_value,actor_avatar from public.users u where u.id=new.buyer_id; if exists(select 1 from public.notifications n where n.user_id=vendor_user and n.type='product_wishlisted' and n.group_key='product-wishlisted:'||new.product_id::text||':'||new.buyer_id::text and n.deleted_at is null and n.read=false) then return new; end if; insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata) values(vendor_user,'product_wishlisted',actor_name_value||' saved your product "'||coalesce(product_name,'your product')||'" to their wishlist.',coalesce(product_name,'Your product'),'productDetail',jsonb_build_object('productId',new.product_id),new.buyer_id,actor_name_value,actor_avatar,vendor_id_value,'product_wishlisted','product-wishlisted:'||new.product_id::text||':'||new.buyer_id::text,jsonb_build_object('product_id',new.product_id,'action','wishlist')); return new; end; $$;


--
-- Name: notify_product_variety_batch(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_product_variety_batch(p_product_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_id uuid;
  v_vendor_user_id uuid;
  v_vendor_name text;
  v_product_name text;
  v_product_active boolean;
  v_variant_count integer;
  r record;
begin
  if auth.uid() is null then return; end if;

  select p.vendor_id, p.name, p.status='active'
    into v_vendor_id, v_product_name, v_product_active
  from public.products p
  where p.id=p_product_id;

  if v_vendor_id is null or not v_product_active then return; end if;
  if not public.owns_vendor(v_vendor_id) and not public.is_admin() then return; end if;

  select count(*)::integer into v_variant_count
  from public.product_variants pv
  where pv.product_id=p_product_id;

  select v.user_id, v.business_name
    into v_vendor_user_id, v_vendor_name
  from public.vendors v
  where v.id=v_vendor_id;
  if v_vendor_user_id is null then return; end if;

  begin
    for r in
      select vf.follower_id,
        coalesce(fp.muted_until,'epoch'::timestamptz) as muted_until,
        coalesce(fp.mute_mode,'none') as mute_mode,
        coalesce(fp.notify_new_variety,true) as notify_new_variety
      from public.vendor_follows vf
      left join public.vendor_follow_preferences fp
        on fp.follower_id=vf.follower_id and fp.vendor_id=vf.vendor_id
      where vf.vendor_id=v_vendor_id
        and vf.follower_id<>v_vendor_user_id
    loop
      if r.mute_mode='always' or r.muted_until > now() then continue; end if;
      if not r.notify_new_variety then continue; end if;

      insert into public.notifications(
        user_id,type,title,body,target_view,target_params,actor_id,actor_name,
        actor_avatar_url,vendor_id,notification_category,group_key,metadata
      ) values(
        r.follower_id,
        'vendor_follow_update',
        'Varieties updated from '||coalesce(v_vendor_name,'a vendor you follow'),
        'Varieties updated for '||coalesce(v_product_name,'a product')||'.',
        'storefront',
        jsonb_build_object('vendorId',v_vendor_id,'productId',p_product_id),
        v_vendor_user_id,
        v_vendor_name,
        (select avatar_url from public.users where id=v_vendor_user_id),
        v_vendor_id,
        'new_variety',
        v_vendor_id::text||':new_variety:'||extract(epoch from clock_timestamp())::bigint::text,
        jsonb_build_object('count',v_variant_count,'latest','Varieties updated for '||coalesce(v_product_name,'a product')||'.','details','Varieties updated for '||coalesce(v_product_name,'a product')||'.')
      );
    end loop;
  exception when others then
    -- Notifications must never make a successfully saved product fail.
    null;
  end;
end;
$$;


--
-- Name: notify_rank_upsert(uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_rank_upsert(p_user uuid, p_title text, p_body text, p_meta jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_id uuid;
begin
  select id into v_id from public.notifications
   where user_id = p_user and type = 'rank_change' and read = false and archived = false
     and created_at > now() - interval '20 minutes'
   order by created_at desc limit 1 for update;
  if v_id is not null then
    update public.notifications set title = p_title, body = p_body, metadata = p_meta, created_at = now() where id = v_id;
  else
    insert into public.notifications (user_id, type, title, body, target_view, target_params, notification_category, group_key, metadata)
    values (p_user, 'rank_change', p_title, p_body, 'leaderboard', '{"tab":"ranking"}'::jsonb, 'points', 'rank:' || p_user, p_meta);
  end if;
end $$;


--
-- Name: notify_request_cancelled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_request_cancelled() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_name text;
  r record;
  v_sector_id uuid;
begin
  if NEW.status <> 'cancelled' or OLD.status = 'cancelled' then
    return NEW;
  end if;

  select name into v_buyer_name from users where id = NEW.buyer_id;

  if NEW.category_id is not null then
    for r in
      select distinct v.user_id
      from vendors v
      join products p on p.vendor_id = v.id
      where v.verification_status = 'verified' and v.is_active
        and p.status = 'active' and p.category_id = NEW.category_id
    loop
      perform create_notification(r.user_id, 'request_cancelled', 'Buyer request cancelled',
        coalesce(v_buyer_name, 'A buyer') || ' cancelled their request: ' || NEW.title,
        'vendorRequests', '{}'::jsonb, NEW.buyer_id);
    end loop;

    select sector_id into v_sector_id from categories where id = NEW.category_id;
    if v_sector_id is not null then
      for r in
        select distinct v.user_id
        from vendors v
        join products p on p.vendor_id = v.id
        join categories c on c.id = p.category_id
        where v.verification_status = 'verified' and v.is_active
          and p.status = 'active' and c.sector_id = v_sector_id
          and not exists (
            select 1 from products p2
            where p2.vendor_id = v.id and p2.status = 'active' and p2.category_id = NEW.category_id
          )
      loop
        perform create_notification(r.user_id, 'request_cancelled', 'Buyer request cancelled',
          coalesce(v_buyer_name, 'A buyer') || ' cancelled their request: ' || NEW.title,
          'vendorRequests', '{}'::jsonb, NEW.buyer_id);
      end loop;
    end if;
  end if;

  return NEW;
end $$;


--
-- Name: notify_variant_followers_batch_aware(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_variant_followers_batch_aware() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_table_name = 'product_variants' and current_setting('levromart.batch_variant_save', true) = '1' then
    return new;
  end if;
  return public.notify_vendor_followers_event();
end;
$$;


--
-- Name: notify_vendor_application_submitted(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_application_submitted(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Not authorized.' using errcode='42501';
  end if;
  perform public.create_notification(
    p_user_id,
    'vendor_application_submitted',
    'Vendor application submitted',
    'Your vendor application has been submitted successfully. We will notify you when there is an update on your application.',
    'home',
    '{}'::jsonb,
    null
  );
end;
$$;


--
-- Name: notify_vendor_follow_created(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_follow_created() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare target_user uuid; actor_name text; actor_avatar text; vendor_name text; begin select v.user_id,v.business_name into target_user,vendor_name from public.vendors v where v.id=new.vendor_id; if target_user is null or target_user=new.follower_id then return new; end if; select u.name,u.avatar_url into actor_name,actor_avatar from public.users u where u.id=new.follower_id; insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,read,archived,vendor_id,notification_category,metadata) values(target_user,'vendor_follow',coalesce(actor_name,'Someone')||' followed your shop',coalesce(actor_name,'Someone')||' is now following '||coalesce(vendor_name,'your shop')||'.','storefront',jsonb_build_object('vendorId',new.vendor_id),new.follower_id,actor_name,actor_avatar,false,false,new.vendor_id,'social',jsonb_build_object('follow_id',new.id)); return new; end; $$;


--
-- Name: notify_vendor_followers_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_followers_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_id uuid;
  v_vendor_user_id uuid;
  v_vendor_name text;
  v_category text;
  v_title text;
  v_body text;
  v_target_view text := 'storefront';
  v_target_params jsonb;
  v_product_name text;
  v_old_price numeric;
  v_new_price numeric;
  v_variant_name text;
  v_price_text text;
  r record;
begin
  if tg_table_name = 'products' then
    v_vendor_id := coalesce(new.vendor_id, old.vendor_id);
    v_product_name := coalesce(new.name, old.name, 'A listing');
    if tg_op = 'INSERT' then
      if new.status <> 'active' then return new; end if;
      v_category := case when coalesce(new.is_service,false) then 'new_service' else 'new_listing' end;
      v_title := case when coalesce(new.is_service,false) then 'New service from a vendor you follow' else 'New listing from a vendor you follow' end;
      v_body := case when coalesce(new.is_service,false) then 'New service: '||v_product_name||'.' else 'New listing: '||v_product_name||'.' end;
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'productId',new.id);
    elsif tg_op = 'UPDATE' then
      if new.status <> 'active' then return new; end if;
      if old.status is distinct from new.status and new.status='active' then
        v_category := case when coalesce(new.is_service,false) then 'new_service' else 'new_listing' end;
        v_title := case when coalesce(new.is_service,false) then 'New service from a vendor you follow' else 'New listing from a vendor you follow' end;
        v_body := case when coalesce(new.is_service,false) then 'New service: '||v_product_name||'.' else 'New listing: '||v_product_name||'.' end;
      elsif old.discount_price is distinct from new.discount_price then
        v_category := 'discount';
        v_title := 'Discount update from a vendor you follow';
        if new.discount_price is null or new.discount_price <= 0 then
          v_body := 'Discount removed from '||v_product_name||'. Regular price: '||coalesce('₦'||to_char(new.sale_price,'FM999G999G999G990D00'),'not set')||'.';
        elsif new.sale_price is not null and new.sale_price > new.discount_price then
          v_body := 'Discount on '||v_product_name||': '||'₦'||to_char(new.discount_price,'FM999G999G999G990D00')||' (was '||'₦'||to_char(new.sale_price,'FM999G999G999G990D00')||').';
        else
          v_body := 'Discount updated on '||v_product_name||' to '||'₦'||to_char(new.discount_price,'FM999G999G999G990D00')||'.';
        end if;
      elsif old.sale_price is distinct from new.sale_price or old.rental_rate is distinct from new.rental_rate then
        v_category := 'price_change';
        v_title := 'Price update from a vendor you follow';
        if old.sale_price is distinct from new.sale_price and new.sale_price is not null then
          v_body := 'Price changed for '||v_product_name||': '||coalesce('₦'||to_char(old.sale_price,'FM999G999G999G990D00'),'not set')||' → '||'₦'||to_char(new.sale_price,'FM999G999G999G990D00')||'.';
        elsif new.rental_rate is not null then
          v_body := 'Rental price changed for '||v_product_name||': '||coalesce('₦'||to_char(old.rental_rate,'FM999G999G999G990D00'),'not set')||' → '||'₦'||to_char(new.rental_rate,'FM999G999G999G990D00')||'/'||coalesce(new.rental_rate_unit,'period')||'.';
        else
          v_body := 'Price updated for '||v_product_name||'.';
        end if;
      elsif old.name is distinct from new.name or old.description is distinct from new.description or old.photos is distinct from new.photos or old.condition is distinct from new.condition or old.listing_type is distinct from new.listing_type or old.quantity_available is distinct from new.quantity_available or old.quantity_total is distinct from new.quantity_total then
        v_category := 'listing_update';
        v_title := 'Listing update from a vendor you follow';
        if old.name is distinct from new.name then
          v_body := 'Listing renamed: '||coalesce(old.name,'listing')||' → '||v_product_name||'.';
        elsif old.quantity_available is distinct from new.quantity_available
              and old.name is not distinct from new.name and old.description is not distinct from new.description
              and old.photos is not distinct from new.photos and old.condition is not distinct from new.condition
              and old.listing_type is not distinct from new.listing_type and old.quantity_total is not distinct from new.quantity_total then
          if coalesce(new.track_quantity,true) = false or coalesce(new.quantity_available,0) >= 100000 then return new; end if;
          if coalesce(new.quantity_available,0) <= 0 and coalesce(old.quantity_available,0) > 0 then
            v_body := v_product_name||' is no longer available.';
          elsif coalesce(old.quantity_available,0) <= 0 and coalesce(new.quantity_available,0) > 0 then
            v_body := v_product_name||' is available again.';
          elsif coalesce(new.quantity_available,0) <= 3 and coalesce(old.quantity_available,0) > 3 then
            v_body := v_product_name||' is almost sold out.';
          else
            return new;
          end if;
        else
          v_body := 'Listing updated: '||v_product_name||'.';
        end if;
      else
        return new;
      end if;
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'productId',new.id);
    else
      return new;
    end if;
  elsif tg_table_name = 'vendor_packages' then
    v_vendor_id := new.vendor_id;
    if tg_op='INSERT' and new.status='active' then
      v_category := 'new_package';
      v_title := 'New package from a vendor you follow';
      v_body := 'New package: '||coalesce(new.name,'A package')||' · '||'₦'||to_char(new.price,'FM999G999G999G990D00')||'.';
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'packageId',new.id);
    elsif tg_op='UPDATE' and new.status='active' and old.status is distinct from new.status then
      v_category := 'new_package';
      v_title := 'New package from a vendor you follow';
      v_body := 'New package: '||coalesce(new.name,'A package')||' · '||'₦'||to_char(new.price,'FM999G999G999G990D00')||'.';
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'packageId',new.id);
    elsif tg_op='UPDATE' and old.price is distinct from new.price and new.status='active' then
      v_category := 'price_change';
      v_title := 'Package price update';
      v_body := 'Package price changed for '||coalesce(new.name,'a package')||': '||coalesce('₦'||to_char(old.price,'FM999G999G999G990D00'),'not set')||' → '||'₦'||to_char(new.price,'FM999G999G999G990D00')||'.';
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'packageId',new.id);
    elsif tg_op='UPDATE' and new.status='active' and (old.name is distinct from new.name or old.description is distinct from new.description or old.photos is distinct from new.photos) then
      v_category := 'listing_update';
      v_title := 'Package update from a vendor you follow';
      v_body := 'Package updated: '||coalesce(new.name,'a package')||'.';
      v_target_params := jsonb_build_object('vendorId',v_vendor_id,'packageId',new.id);
    else
      return new;
    end if;
  elsif tg_table_name = 'product_variants' then
    select p.vendor_id, p.name into v_vendor_id, v_product_name from public.products p where p.id=new.product_id and p.status='active';
    if v_vendor_id is null then return new; end if;
    v_variant_name := coalesce(new.name,'Variety');
    if tg_op='INSERT' then
      v_category := 'new_variety';
      v_title := 'New variety from a vendor you follow';
      v_body := 'New variety: '||v_product_name||' — '||v_variant_name||coalesce(case when new.discount_price is not null and new.discount_price > 0 and new.discount_price < coalesce(new.sale_price,0) then ' · '||'₦'||to_char(new.discount_price,'FM999G999G999G990D00')||' (discounted)' when new.sale_price is not null then ' · '||'₦'||to_char(new.sale_price,'FM999G999G999G990D00') else '' end,'')||'.';
    elsif tg_op='UPDATE' and old.name is distinct from new.name then
      v_category := 'new_variety';
      v_title := 'Variety update from a vendor you follow';
      v_body := 'Variety renamed on '||v_product_name||': '||coalesce(old.name,'variety')||' → '||v_variant_name||'.';
    elsif tg_op='UPDATE' and old.discount_price is distinct from new.discount_price then
      v_category := 'discount';
      v_title := 'Variety discount update';
      v_body := 'Discount updated for '||v_product_name||' — '||v_variant_name||': '||case when new.discount_price is not null and new.discount_price > 0 then '₦'||to_char(new.discount_price,'FM999G999G999G990D00') else 'removed' end||'.';
    elsif tg_op='UPDATE' and old.sale_price is distinct from new.sale_price then
      v_category := 'price_change';
      v_title := 'Variety price update';
      v_body := 'Variety price changed: '||v_product_name||' — '||v_variant_name||': '||coalesce('₦'||to_char(old.sale_price,'FM999G999G999G990D00'),'not set')||' → '||coalesce('₦'||to_char(new.sale_price,'FM999G999G999G990D00'),'not set')||'.';
    elsif tg_op='UPDATE' and old.photo_url is distinct from new.photo_url then
      v_category := 'listing_update';
      v_title := 'Variety update from a vendor you follow';
      v_body := 'Photo updated for '||v_product_name||' — '||v_variant_name||'.';
    else
      return new;
    end if;
    v_target_params := jsonb_build_object('vendorId',v_vendor_id,'productId',new.product_id,'variantId',new.id);
  else
    return new;
  end if;

  select user_id,business_name into v_vendor_user_id,v_vendor_name from public.vendors where id=v_vendor_id;
  if v_vendor_user_id is null then return new; end if;
  v_title := replace(v_title,'a vendor',coalesce(v_vendor_name,'a vendor'));

  for r in
    select vf.follower_id,
      coalesce(p.muted_until,'epoch'::timestamptz) as muted_until,
      coalesce(p.mute_mode,'none') as mute_mode,
      coalesce(p.notify_new_listing,true) as notify_new_listing,
      coalesce(p.notify_new_service,true) as notify_new_service,
      coalesce(p.notify_new_package,true) as notify_new_package,
      coalesce(p.notify_new_variety,true) as notify_new_variety,
      coalesce(p.notify_price_change,true) as notify_price_change,
      coalesce(p.notify_discount,true) as notify_discount
    from public.vendor_follows vf
    left join public.vendor_follow_preferences p on p.follower_id=vf.follower_id and p.vendor_id=vf.vendor_id
    where vf.vendor_id=v_vendor_id and vf.follower_id<>v_vendor_user_id
  loop
    if r.mute_mode='always' or r.muted_until > now() then continue; end if;
    if v_category='new_listing' and not r.notify_new_listing then continue; end if;
    if v_category='new_service' and not r.notify_new_service then continue; end if;
    if v_category='new_package' and not r.notify_new_package then continue; end if;
    if v_category='new_variety' and not r.notify_new_variety then continue; end if;
    if v_category='price_change' and not r.notify_price_change then continue; end if;
    if v_category='discount' and not r.notify_discount then continue; end if;

    insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata)
    values(
      r.follower_id,
      'vendor_follow_update',
      v_title,
      v_body,
      v_target_view,
      v_target_params,
      v_vendor_user_id,
      v_vendor_name,
      (select avatar_url from public.users where id=v_vendor_user_id),
      v_vendor_id,
      v_category,
      v_vendor_id::text||':'||v_category||':'||extract(epoch from clock_timestamp())::bigint::text,
      jsonb_build_object('count',1,'latest',v_body,'details',v_body)
    );
  end loop;
  return new;
end;
$$;


--
-- Name: notify_vendor_low_stock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_low_stock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_vendor_id uuid;
  v_vendor_user_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_track_quantity boolean;
  v_variant_name text;
  v_label text;
  v_title text;
  v_body text;
  v_category text;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    IF NOT COALESCE(NEW.track_quantity, true) THEN RETURN NEW; END IF;
    IF NEW.status <> 'active' THEN RETURN NEW; END IF;
    v_vendor_id := NEW.vendor_id;
    v_product_id := NEW.id;
    v_product_name := NEW.name;
    v_label := v_product_name;
  ELSIF TG_TABLE_NAME = 'product_variants' THEN
    SELECT p.vendor_id, p.name, p.track_quantity INTO v_vendor_id, v_product_name, v_track_quantity
      FROM public.products p WHERE p.id = NEW.product_id AND p.status = 'active';
    IF v_vendor_id IS NULL OR NOT COALESCE(v_track_quantity, true) THEN RETURN NEW; END IF;
    v_product_id := NEW.product_id;
    v_variant_name := COALESCE(NEW.name, 'a variety');
    v_label := v_product_name || ' — ' || v_variant_name;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.quantity_available IS NULL THEN RETURN NEW; END IF;

  IF NEW.quantity_available = 0 AND (OLD.quantity_available IS NULL OR OLD.quantity_available > 0) THEN
    v_category := 'out_of_stock';
    v_title := 'Out of stock';
    v_body := v_label || ' is now out of stock. Restock it or update the listing.';
  ELSIF NEW.quantity_available <= 5 AND NEW.quantity_available > 0 AND (OLD.quantity_available IS NULL OR OLD.quantity_available > 5) THEN
    v_category := 'low_stock';
    v_title := 'Running low on stock';
    v_body := v_label || ' has only ' || NEW.quantity_available || ' left. Consider restocking soon.';
  ELSE
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_vendor_user_id FROM public.vendors WHERE id = v_vendor_id;
  IF v_vendor_user_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.notifications(user_id, type, title, body, target_view, target_params, vendor_id, notification_category, group_key, metadata)
  VALUES (
    v_vendor_user_id, 'stock_alert', v_title, v_body, 'vendorProducts',
    jsonb_build_object('productId', v_product_id),
    v_vendor_id, v_category,
    'stock:' || v_product_id::text || ':' || v_category,
    jsonb_build_object('productId', v_product_id, 'quantity_available', NEW.quantity_available)
  );
  RETURN NEW;
END;
$$;


--
-- Name: notify_vendor_on_follow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_on_follow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare v_user uuid; v_name text; a_name text; a_avatar text; begin select user_id,business_name into v_user,v_name from public.vendors where id=new.vendor_id and deleted_at is null; if v_user is null or v_user=new.follower_id then return new; end if; select name,avatar_url into a_name,a_avatar from public.users where id=new.follower_id; insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,actor_avatar_url,vendor_id,notification_category,group_key,metadata) values(v_user,'vendor_follow','New follower',coalesce(a_name,'Someone')||' started following your shop.','storefront',jsonb_build_object('vendorId',new.vendor_id),new.follower_id,a_name,a_avatar,new.vendor_id,'new_follower','follow:'||new.vendor_id::text||':'||new.follower_id::text,jsonb_build_object('follower_id',new.follower_id)); return new; end; $$;


--
-- Name: notify_vendor_payout_setup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_vendor_payout_setup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform notify_admins(
    'Vendor payout account set up.',
    coalesce(new.business_name, 'A vendor') || ' has set up their payout account and can now receive payments.',
    'adminPanel',
    jsonb_build_object('vendorId', new.id),
    new.user_id
  );
  return new;
end;
$$;


--
-- Name: on_user_profile_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.on_user_profile_updated() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.role <> 'admin' and (
    new.name is distinct from old.name
    or new.phone is distinct from old.phone
    or new.city is distinct from old.city
  ) then
    perform notify_admins(
      'A user updated their details',
      coalesce(old.name, old.email) || ' updated their profile.',
      'adminPeople', '{}'::jsonb, new.id
    );
  end if;
  return new;
end;
$$;


--
-- Name: on_vendor_profile_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.on_vendor_profile_updated() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer_id uuid;
begin
  if new.business_name is distinct from old.business_name
    or new.phone is distinct from old.phone
    or new.address is distinct from old.address
    or new.city is distinct from old.city
    or new.bio is distinct from old.bio
  then
    perform notify_admins(
      'Vendor updated their profile',
      old.business_name || ' updated their business details.',
      'adminPeople', '{}'::jsonb, new.user_id
    );
  end if;

  if new.business_name is distinct from old.business_name then
    new.previous_business_name := old.business_name;
    new.name_changed_at := now();

    for v_buyer_id in
      select distinct buyer_id from orders where vendor_id = new.id
    loop
      perform create_notification(
        v_buyer_id, 'vendor_renamed', 'A vendor you bought from changed their name',
        old.business_name || ' is now called ' || new.business_name || '.',
        'storefront', jsonb_build_object('vendorId', new.id), new.user_id
      );
    end loop;
  end if;

  return new;
end;
$$;


--
-- Name: owns_vendor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.owns_vendor(v_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(select 1 from public.vendors where id = v_id and user_id = auth.uid());
$$;


--
-- Name: points_award_order(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_award_order(p_order uuid, p_notify boolean DEFAULT true) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare o record; v_user uuid; r record; v_cnt int; v_pts int;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.status::text <> 'completed' then return 'not completed'; end if;
  select user_id into v_user from public.vendors where id = o.vendor_id;
  if v_user is null then return 'no vendor'; end if;
  select * into r from public.points_rules where kind = 'order_completed';
  if v_user = o.buyer_id then perform public.points_log_skip(v_user, 'order_completed', p_order::text, 'Your own order does not count'); return 'own order'; end if;
  if coalesce(o.total_amount, 0) < coalesce(r.min_amount, 0) then
    perform public.points_log_skip(v_user, 'order_completed', p_order::text, 'Order total is under the ₦' || coalesce(r.min_amount, 0)::bigint || ' minimum');
    return 'under minimum';
  end if;
  if r.per_source_weekly_cap is not null then
    select count(*) into v_cnt from public.points_ledger
     where user_id = v_user and kind = 'order_completed' and source_user_id = o.buyer_id and week_start = public.points_week_start()
       and event_key <> 'order:' || p_order;
    if v_cnt >= r.per_source_weekly_cap then
      perform public.points_log_skip(v_user, 'order_completed', p_order::text, 'Same customer already counted ' || r.per_source_weekly_cap || ' times this week');
      return 'customer cap';
    end if;
  end if;
  v_pts := public.award_points(v_user, 'order_completed', 'order:' || p_order, o.buyer_id, 'Completed sale',
             jsonb_build_object('order_id', p_order, 'amount', o.total_amount), null, p_notify);
  return case when v_pts > 0 then 'awarded' else 'already counted' end;
end $$;


--
-- Name: points_award_review(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_award_review(p_review uuid, p_notify boolean DEFAULT true) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare rv record; v_user uuid; v_kind text; v_amt numeric; v_min numeric; v_pts int;
begin
  select * into rv from public.reviews where id = p_review;
  if not found then return 'no review'; end if;
  select user_id into v_user from public.vendors where id = rv.vendor_id;
  if v_user is null then return 'no vendor'; end if;
  v_kind := case rv.rating when 5 then 'review_5' when 4 then 'review_4' when 3 then 'review_3' else null end;
  if v_kind is null then return 'low rating'; end if;
  if v_user = rv.buyer_id then perform public.points_log_skip(v_user, v_kind, p_review::text, 'A review from yourself does not count'); return 'own review'; end if;
  select total_amount into v_amt from public.orders where id = rv.order_id;
  select min_amount into v_min from public.points_rules where kind = 'order_completed';
  if coalesce(v_amt, 0) < coalesce(v_min, 0) then
    perform public.points_log_skip(v_user, v_kind, p_review::text, 'Order total is under the ₦' || coalesce(v_min, 0)::bigint || ' minimum');
    return 'under minimum';
  end if;
  v_pts := public.award_points(v_user, v_kind, 'review:' || p_review, rv.buyer_id, rv.rating || '-star review', '{}'::jsonb, null, p_notify);
  return case when v_pts > 0 then 'awarded' else 'already counted' end;
end $$;


--
-- Name: points_for_new_listing(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_for_new_listing(p_vendor uuid, p_listing uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid; ref record; v_cnt int;
begin
  select user_id into v_user from public.vendors where id = p_vendor;
  if v_user is null then return; end if;
  perform public.award_points(v_user, 'product_listed', 'listed:' || p_listing, null, 'New listing');
  select * into ref from public.referrals where referred_user_id = v_user and code <> 'VOID';
  if found then
    select count(*) into v_cnt from public.points_ledger
     where user_id = ref.referrer_user_id and kind = 'ref_vendor_product' and source_user_id = v_user;
    if v_cnt < 10 then
      perform public.award_points(ref.referrer_user_id, 'ref_vendor_product', 'refprod:' || p_listing, v_user, 'Referred vendor listed a product');
    end if;
  end if;
end $$;


--
-- Name: points_log_skip(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_log_skip(p_user uuid, p_kind text, p_ref text, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.points_skips (user_id, kind, ref, reason) values (p_user, p_kind, p_ref, p_reason) on conflict (kind, ref) do nothing;
exception when others then null;
end $$;


--
-- Name: points_reconcile_listings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_reconcile_listings() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare r record; lid uuid;
begin
  for r in select l.user_id, l.event_key, l.kind from public.points_ledger l where l.kind in ('product_listed', 'ref_vendor_product') loop
    lid := nullif(substring(r.event_key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '')::uuid;
    if lid is null then continue; end if;
    if not exists (select 1 from public.products p where p.id = lid and p.status::text <> 'removed' and p.admin_deleted_at is null)
       and not exists (select 1 from public.vendor_packages vp where vp.id = lid and vp.status::text <> 'removed') then
      perform public.revoke_points(r.user_id, r.event_key);
    end if;
  end loop;
end $_$;


--
-- Name: points_revoke_listing(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_revoke_listing(p_vendor uuid, p_listing uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid; ref record;
begin
  select user_id into v_user from public.vendors where id = p_vendor;
  if v_user is null then return; end if;
  perform public.revoke_points(v_user, 'listed:' || p_listing);
  select * into ref from public.referrals where referred_user_id = v_user and code <> 'VOID';
  if found then perform public.revoke_points(ref.referrer_user_id, 'refprod:' || p_listing); end if;
end $$;


--
-- Name: points_week_start(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.points_week_start(p_ts timestamp with time zone DEFAULT now()) RETURNS date
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$ select date_trunc('week', p_ts at time zone 'Africa/Lagos')::date $$;


--
-- Name: prevent_self_role_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_self_role_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
 if new.role<>old.role and not public.is_admin() then
   if new.id<>auth.uid() then raise exception 'You cannot change another account''s role.'; end if;
   if new.role=public.resolve_account_role(new.id) then return new; end if;
   raise exception 'Your account role is controlled by vendor verification status.';
 end if; return new;
end; $$;


--
-- Name: prevent_unverified_order_completion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_unverified_order_completion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_fee_type public.payment_type; v_fee_paid boolean:=false; v_deposit_paid boolean:=true; v_timing text;
begin
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    v_fee_type:=CASE WHEN NEW.order_type='sale' THEN 'sale_price'::public.payment_type ELSE 'rental_fee'::public.payment_type END;
    SELECT EXISTS(SELECT 1 FROM public.payments WHERE order_id=NEW.id AND payment_type=v_fee_type AND status='paid'::public.payment_status) INTO v_fee_paid;
    v_timing:=CASE WHEN NEW.payment_timing IN ('pay_before','pay_after') THEN NEW.payment_timing ELSE 'pay_before' END;
    IF NEW.delivery_method='delivery' AND v_timing='pay_after' THEN
      SELECT EXISTS(SELECT 1 FROM public.payments WHERE order_id=NEW.id AND payment_type='delivery_deposit_20'::public.payment_type AND status='paid'::public.payment_status) INTO v_deposit_paid;
    END IF;
    IF NOT v_fee_paid OR NOT v_deposit_paid THEN
      NEW.status:='disputed'::public.order_status; NEW.payment_unresolved_at:=COALESCE(OLD.payment_unresolved_at,now()); NEW.payment_escalated_at:=NULL; NEW.completed_at:=NULL;
    END IF;
  END IF;
  RETURN NEW;
end;
$$;


--
-- Name: prevent_vendor_activation_with_owed_commission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_vendor_activation_with_owed_commission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_overdue numeric:=0;
begin
  if public.is_admin() then
    return new;
  end if;

  if coalesce(new.is_active,false)=true
     and (coalesce(old.is_active,false)=false or coalesce(new.commission_paused,false)=false) then
    select coalesce(sum(c.amount),0) into v_overdue
    from public.commission_charges c
    join public.orders o on o.id=c.order_id
    where c.vendor_id=new.id
      and c.status='owed'
      and o.status='completed'
      and c.due_at <= now();

    if v_overdue>0 then
      raise exception 'Storefront cannot be activated while commission is overdue. Amount overdue: %',v_overdue using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: prevent_vendor_self_cart_item(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_vendor_self_cart_item() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_user_id uuid;
begin
  select user_id into v_vendor_user_id
  from public.vendors v
  join public.products p on p.vendor_id = v.id
  where p.id = new.product_id;

  if v_vendor_user_id is not null and v_vendor_user_id = new.buyer_id then
    raise exception 'You can''t buy from your own shop.';
  end if;

  return new;
end;
$$;


--
-- Name: prevent_vendor_self_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_vendor_self_order() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_user_id uuid;
begin
  select user_id into v_vendor_user_id
  from public.vendors
  where id = new.vendor_id;

  if v_vendor_user_id is not null and v_vendor_user_id = new.buyer_id then
    raise exception 'You can''t purchase from your own shop.';
  end if;

  return new;
end;
$$;


--
-- Name: process_commission_deadline_reminders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_commission_deadline_reminders() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  now_ts timestamptz := now();
  rec record;
  days_left integer;
  code text;
  inserted_count integer := 0;
  msg text;
begin
  for rec in
    select v.id as vendor_id, v.user_id as vendor_user_id, v.business_name,
           min(c.due_at) as earliest_due_at,
           sum(c.amount) as total_owed
    from public.vendors v
    join public.commission_charges c on c.vendor_id = v.id
    join public.orders o on o.id = c.order_id
    where v.deleted_at is null
      and v.verification_status = 'verified'
      and coalesce(v.admin_paused,false) = false
      and coalesce(v.commission_paused,false) = false
      and v.user_id is not null
      and c.status = 'owed'
      and o.status = 'completed'
    group by v.id, v.user_id, v.business_name
    having sum(c.amount) > 0
  loop
    days_left := ceil(extract(epoch from (rec.earliest_due_at - now_ts)) / 86400.0);
    if days_left in (5,3,2,1) then
      code := days_left::text || 'd';
      insert into public.commission_deadline_reminders(vendor_id, reminder_code, period_key)
      values (rec.vendor_id, code, rec.earliest_due_at)
      on conflict (vendor_id, reminder_code, period_key) do nothing;
      if found then
        msg := case
          when days_left = 1 then format('Your commission of ₦%s is due within 24 hours. Pay today so nothing on your storefront is locked.', to_char(rec.total_owed,'FM999,999,999.00'))
          else format('You owe ₦%s commission. %s days left to pay%s.', to_char(rec.total_owed,'FM999,999,999.00'), days_left, case when rec.total_owed >= 100 then ' before your storefront pauses' else '' end)
        end;
        insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata)
        values (
          rec.vendor_user_id,
          'commission_deadline',
          case when days_left = 1 then 'Commission due today' else format('Commission due in %s days', days_left) end,
          msg,
          'vendorDashboard',
          '{}'::jsonb,
          false, false, null,
          rec.vendor_id, 'commission_deadline',
          format('commission-deadline:%s:%s', rec.vendor_id, code),
          jsonb_build_object('vendor_id', rec.vendor_id, 'days_left', days_left, 'total_owed', rec.total_owed, 'due_at', rec.earliest_due_at)
        );
        inserted_count := inserted_count + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('notifications_created', inserted_count, 'processed_at', now_ts);
end;
$$;


--
-- Name: process_listing_billing_reminders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_listing_billing_reminders() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare now_ts timestamptz:=now(); today date:=(now_ts at time zone 'UTC')::date; rec record; ven record; days_left integer; code text; period_key date; inserted_count integer:=0; paused_count integer:=0; begin for rec in select prod.id,prod.vendor_id,prod.name,prod.billing_paid_until,prod.status,prod.billing_status,vv.user_id as vendor_user_id from public.products prod join public.vendors vv on vv.id=prod.vendor_id where prod.billing_model='monthly' and prod.billing_paid_until is not null and vv.user_id is not null loop period_key:=(rec.billing_paid_until at time zone 'UTC')::date; days_left:=period_key-today; if days_left in (20,15,10,5,4,1) then code:=days_left::text||'d'; if not exists(select 1 from public.listing_billing_reminders r where r.kind='product' and r.listing_id=rec.id and r.reminder_code=code and r.period_key=period_key) then insert into public.listing_billing_reminders(kind,listing_id,reminder_code,period_key) values('product',rec.id,code,period_key); insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata) values(rec.vendor_user_id,'listing_billing','Listing renewal reminder',format('%s expires in %s day%s. Renew for ₦1,000 to keep it live.',rec.name,days_left,case when days_left=1 then '' else 's' end),'vendorProducts',jsonb_build_object('productId',rec.id,'billing_paid_until',rec.billing_paid_until),false,false,null,rec.vendor_id,'listing_billing',format('listing-expiry:%s:%s',rec.id,code),jsonb_build_object('kind','product','listing_id',rec.id,'days_left',days_left)); inserted_count:=inserted_count+1; end if; elsif days_left<=0 then code:='expired'; if rec.status<>'removed' and (rec.status<>'paused' or rec.billing_status<>'past_due') then update public.products set status='paused',billing_status='past_due' where id=rec.id and status<>'removed'; paused_count:=paused_count+1; end if; if not exists(select 1 from public.listing_billing_reminders r where r.kind='product' and r.listing_id=rec.id and r.reminder_code=code and r.period_key=period_key) then insert into public.listing_billing_reminders(kind,listing_id,reminder_code,period_key) values('product',rec.id,code,period_key); insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata) values(rec.vendor_user_id,'listing_billing','Listing expired',format('%s has expired and is paused. Renew for ₦1,000 to restore it.',rec.name),'vendorProducts',jsonb_build_object('productId',rec.id),false,false,null,rec.vendor_id,'listing_billing',format('listing-expiry:%s:expired',rec.id),jsonb_build_object('kind','product','listing_id',rec.id,'expired',true)); inserted_count:=inserted_count+1; end if; end if; end loop; for rec in select pkg.id,pkg.vendor_id,pkg.name,pkg.billing_paid_until,pkg.status,pkg.billing_status,vv.user_id as vendor_user_id from public.vendor_packages pkg join public.vendors vv on vv.id=pkg.vendor_id where pkg.billing_model='monthly' and pkg.billing_paid_until is not null and vv.user_id is not null loop period_key:=(rec.billing_paid_until at time zone 'UTC')::date; days_left:=period_key-today; if days_left in (20,15,10,5,4,1) then code:=days_left::text||'d'; if not exists(select 1 from public.listing_billing_reminders r where r.kind='package' and r.listing_id=rec.id and r.reminder_code=code and r.period_key=period_key) then insert into public.listing_billing_reminders(kind,listing_id,reminder_code,period_key) values('package',rec.id,code,period_key); insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata) values(rec.vendor_user_id,'listing_billing','Package renewal reminder',format('%s expires in %s day%s. Renew for ₦1,000 to keep it live.',rec.name,days_left,case when days_left=1 then '' else 's' end),'vendorPackages',jsonb_build_object('packageId',rec.id,'billing_paid_until',rec.billing_paid_until),false,false,null,rec.vendor_id,'listing_billing',format('package-expiry:%s:%s',rec.id,code),jsonb_build_object('kind','package','listing_id',rec.id,'days_left',days_left)); inserted_count:=inserted_count+1; end if; elsif days_left<=0 then code:='expired'; if rec.status<>'removed' and (rec.status<>'paused' or rec.billing_status<>'past_due') then update public.vendor_packages set status='paused',billing_status='past_due' where id=rec.id and status<>'removed'; paused_count:=paused_count+1; end if; if not exists(select 1 from public.listing_billing_reminders r where r.kind='package' and r.listing_id=rec.id and r.reminder_code=code and r.period_key=period_key) then insert into public.listing_billing_reminders(kind,listing_id,reminder_code,period_key) values('package',rec.id,code,period_key); insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata) values(rec.vendor_user_id,'listing_billing','Package expired',format('%s has expired and is paused. Renew for ₦1,000 to restore it.',rec.name),'vendorPackages',jsonb_build_object('packageId',rec.id),false,false,null,rec.vendor_id,'listing_billing',format('package-expiry:%s:expired',rec.id),jsonb_build_object('kind','package','listing_id',rec.id,'expired',true)); inserted_count:=inserted_count+1; end if; end if; end loop; for ven in select id,user_id,business_name,next_monthly_charge_at from public.vendors where billing_model='monthly' and next_monthly_charge_at is not null and user_id is not null loop period_key:=(ven.next_monthly_charge_at at time zone 'UTC')::date; days_left:=period_key-today; if days_left in (10,5,1,0) then code:=case when days_left=0 then '0d' else days_left::text||'d' end; if not exists(select 1 from public.listing_billing_reminders r where r.kind='vendor' and r.listing_id=ven.id and r.reminder_code=code and r.period_key=period_key) then insert into public.listing_billing_reminders(kind,listing_id,reminder_code,period_key) values('vendor',ven.id,code,period_key); insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata) values(ven.user_id,'listing_billing','Monthly listing billing reminder',case when days_left=0 then format('%s: your combined monthly listing billing is due today. Review your listings and payment method.',ven.business_name) else format('%s: your combined monthly listing billing renews in %s day%s. Review your listings and payment method.',ven.business_name,days_left,case when days_left=1 then '' else 's' end) end,'vendorEditProfile','{}'::jsonb,false,false,null,ven.id,'listing_billing',format('vendor-monthly:%s:%s',ven.id,code),jsonb_build_object('kind','vendor','vendor_id',ven.id,'days_left',days_left)); inserted_count:=inserted_count+1; end if; end if; end loop; return jsonb_build_object('notifications_created',inserted_count,'listings_paused',paused_count,'processed_at',now_ts); end; $$;


--
-- Name: process_payment_unresolved_escalations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_payment_unresolved_escalations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_count integer:=0; r record; a record;
begin
  FOR r IN SELECT o.id,o.buyer_id,o.vendor_id,o.payment_unresolved_at FROM public.orders o WHERE o.status='disputed'::public.order_status AND o.payment_unresolved_at IS NOT NULL AND o.payment_unresolved_at<=now()-interval '24 hours' AND o.payment_escalated_at IS NULL FOR UPDATE OF o LOOP
    UPDATE public.orders SET payment_escalated_at=now() WHERE id=r.id AND payment_escalated_at IS NULL;
    FOR a IN SELECT id FROM public.users WHERE role='admin' LOOP
      PERFORM public.create_notification(a.id,'payment_unresolved_escalated','Payment unresolved — 24h overdue','Order '||r.id::text||' has remained payment unresolved for at least 24 hours. Review the order and contact the parties if necessary.','adminDisputes',jsonb_build_object('orderId',r.id,'paymentUnresolvedAt',r.payment_unresolved_at),NULL);
    END LOOP;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
end;
$$;


--
-- Name: process_service_offer_deadlines(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_service_offer_deadlines() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_count integer:=0; r record; v_vendor_user uuid; v_buyer_name text; v_vendor_name text; v_product_name text;
begin
  for r in select so.*,p.name product_name from public.service_offers so join public.products p on p.id=so.listing_id where so.status in ('pending','countered','awaiting_payment') and so.expires_at<=now() for update of so loop
    update public.service_offers set status='expired',updated_at=now() where id=r.id;
    select user_id,business_name into v_vendor_user,v_vendor_name from public.vendors where id=r.vendor_id; select name into v_buyer_name from public.users where id=r.buyer_id;
    perform public.create_notification(r.buyer_id,'service_offer_expired','Service request expired','The service request for '||coalesce(r.product_name,'the service')||' expired because it was not completed in time.','productDetail',jsonb_build_object('productId',r.listing_id,'serviceOfferId',r.id),null);
    perform public.create_notification(v_vendor_user,'service_offer_expired','Service request expired','The service request for '||coalesce(r.product_name,'the service')||' expired because it was not completed in time.','productDetail',jsonb_build_object('productId',r.listing_id,'serviceOfferId',r.id),null);
    v_count:=v_count+1;
  end loop; return v_count;
end;$$;


--
-- Name: process_vendor_commission_hour_reminders(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_vendor_commission_hour_reminders(p_vendor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  now_ts timestamptz := now();
  rec record;
  hours_left numeric;
  code text;
  inserted_count integer := 0;
begin
  if not (public.owns_vendor(p_vendor_id) or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select v.id as vendor_id, v.user_id as vendor_user_id, v.business_name,
         min(c.due_at) as earliest_due_at,
         sum(c.amount) as total_owed
  into rec
  from public.vendors v
  join public.commission_charges c on c.vendor_id = v.id
  join public.orders o on o.id = c.order_id
  where v.id = p_vendor_id
    and v.deleted_at is null
    and coalesce(v.admin_paused,false) = false
    and coalesce(v.commission_paused,false) = false
    and v.user_id is not null
    and c.status = 'owed'
    and o.status = 'completed'
  group by v.id, v.user_id, v.business_name
  having sum(c.amount) >= 100;

  if rec.vendor_id is null or rec.earliest_due_at is null then
    return jsonb_build_object('notifications_created', 0);
  end if;

  hours_left := extract(epoch from (rec.earliest_due_at - now_ts)) / 3600.0;
  -- Only worth checking inside the final day; the daily cron already
  -- covers the day-level countdown further out.
  if hours_left > 0 and hours_left <= 24 then
    if hours_left <= 10 then code := '10h'; end if;
    if hours_left <= 5 then code := '5h'; end if;
    if hours_left <= 1 then code := '1h'; end if;
    if code is not null then
      insert into public.commission_deadline_reminders(vendor_id, reminder_code, period_key)
      values (rec.vendor_id, code, rec.earliest_due_at)
      on conflict (vendor_id, reminder_code, period_key) do nothing;
      if found then
        insert into public.notifications(user_id,type,title,body,target_view,target_params,read,archived,deleted_at,vendor_id,notification_category,group_key,metadata)
        values (
          rec.vendor_user_id,
          'commission_deadline',
          'Commission payment due soon',
          format('%s: ₦%s commission is owed and your storefront pauses in about %s hour%s unless it''s paid.', rec.business_name, to_char(rec.total_owed,'FM999,999,999'), left(code, length(code)-1), case when left(code, length(code)-1)='1' then '' else 's' end),
          'vendorDashboard',
          '{}'::jsonb,
          false, false, null,
          rec.vendor_id, 'commission_deadline',
          format('commission-deadline:%s:%s', rec.vendor_id, code),
          jsonb_build_object('vendor_id', rec.vendor_id, 'hours_left', hours_left, 'total_owed', rec.total_owed, 'due_at', rec.earliest_due_at)
        );
        inserted_count := 1;
      end if;
    end if;
  end if;

  return jsonb_build_object('notifications_created', inserted_count);
end;
$$;


--
-- Name: products_default_category(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.products_default_category() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_sector uuid;
begin
  if new.category_id is null then
    select sector_id into v_sector from public.vendors where id=new.vendor_id;
    new.category_id := public.ensure_default_category(v_sector);
  end if;
  return new;
end $$;


--
-- Name: raise_dispute(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.raise_dispute(p_order_id uuid, p_reason text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order orders%rowtype;
  v_is_vendor boolean;
  v_raised_by dispute_raised_by;
  v_dispute_id uuid;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_is_vendor := public.owns_vendor(v_order.vendor_id);
  if not v_is_vendor and v_order.buyer_id <> auth.uid() then
    raise exception 'not authorized';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception 'reason is required';
  end if;

  v_raised_by := case when v_is_vendor then 'vendor' else 'buyer' end;

  insert into disputes (order_id, raised_by, reason)
  values (p_order_id, v_raised_by, p_reason)
  returning id into v_dispute_id;

  update orders set status = 'disputed' where id = p_order_id;

  return v_dispute_id;
end;
$$;


--
-- Name: raise_dispute(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.raise_dispute(p_order_id uuid, p_reason text, p_attachments jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order orders%rowtype; v_is_vendor boolean; v_raised_by dispute_raised_by; v_dispute_id uuid; v_att jsonb := '[]'::jsonb; a jsonb;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'order not found'; end if;
  v_is_vendor := public.owns_vendor(v_order.vendor_id);
  if not v_is_vendor and v_order.buyer_id <> auth.uid() then raise exception 'not authorized'; end if;
  if trim(coalesce(p_reason, '')) = '' then raise exception 'reason is required'; end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' then raise exception 'attachments must be a list'; end if;
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then raise exception 'You can attach up to 3 images.'; end if;
  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    if (a->>'path') is null or (a->>'path') not like auth.uid()::text || '/' || p_order_id::text || '/%' then
      raise exception 'invalid attachment';
    end if;
    v_att := v_att || jsonb_build_array(jsonb_build_object('path', a->>'path', 'name', left(coalesce(a->>'name', 'photo'), 80), 'type', coalesce(a->>'type', 'image/jpeg')));
  end loop;
  v_raised_by := case when v_is_vendor then 'vendor' else 'buyer' end;
  insert into disputes (order_id, raised_by, reason, attachments) values (p_order_id, v_raised_by, p_reason, v_att) returning id into v_dispute_id;
  update orders set status = 'disputed' where id = p_order_id;
  return v_dispute_id;
end;
$$;


--
-- Name: record_auth_activity(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_auth_activity(p_event_type text, p_user_agent text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;
  if p_event_type not in ('login','logout') then raise exception 'Invalid auth event.'; end if;
  insert into public.auth_activity_logs(user_id,event_type,occurred_at,user_agent,source)
  values(auth.uid(),p_event_type,now(),left(p_user_agent,1000),'app');
end; $$;


--
-- Name: record_offline_payment(uuid, public.payment_type, numeric, public.payment_method); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_offline_payment(p_order_id uuid, p_payment_type public.payment_type, p_amount numeric, p_method public.payment_method) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_order public.orders%rowtype; v_payment_id uuid; v_existing public.payments%rowtype;
begin
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF NOT public.owns_vendor(v_order.vendor_id) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_method='card' THEN RAISE EXCEPTION 'use online payment for card charges'; END IF;
  IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  SELECT * INTO v_existing FROM public.payments
  WHERE order_id=p_order_id AND payment_type=p_payment_type
    AND status='pending'::public.payment_status AND provider_reference='buyer_report'
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION 'The customer must tap “I’ve paid the vendor” before a vendor can confirm this payment.' USING ERRCODE='22023';
  END IF;
  IF abs(p_amount-v_existing.amount)>0.01 THEN
    RAISE EXCEPTION 'Payment amount does not match the customer reported amount.' USING ERRCODE='22023';
  END IF;
  UPDATE public.payments SET status='paid'::public.payment_status, paid_at=COALESCE(paid_at,now()), method=p_method, provider_reference='vendor_confirmed'
  WHERE id=v_existing.id RETURNING id INTO v_payment_id;
  UPDATE public.orders SET payment_escalated_at=NULL WHERE id=p_order_id;
  RETURN v_payment_id;
end;
$$;


--
-- Name: record_order_completion_commission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_order_completion_commission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_amount numeric(12,2);
begin
 if NEW.status='completed' and OLD.status is distinct from 'completed' and coalesce(NEW.commission_exempt,false)=false then
   v_amount:=round(greatest(0,coalesce(NEW.total_amount,0))*0.03,2);
   delete from public.commission_charges where order_id=NEW.id and status='owed';
   if v_amount>0 then insert into public.commission_charges(vendor_id,payment_id,order_id,amount,status,due_at) values(NEW.vendor_id,NULL,NEW.id,v_amount,'owed',coalesce(NEW.completed_at,now())+interval '7 days'); end if;
 end if;
 return NEW;
end; $$;


--
-- Name: record_social_click(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_social_click(p_platform text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Social points are now confirmed by hand (screenshot on WhatsApp), see admin_award_social_points.
  return jsonb_build_object('ok', true, 'awarded', 0, 'manual', true);
end $$;


--
-- Name: remind_unattended_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remind_unattended_orders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record; n integer := 0;
begin
  -- First 3 minutes of silence, then a reminder to both sides every 3 minutes for the first hour,
  -- then every 30 minutes until the order is answered (or 24 h old).
  for r in
    select o.id, o.buyer_id, v.user_id as vendor_user_id
    from public.orders o join public.vendors v on v.id = o.vendor_id
    where o.status = 'pending'
      and o.created_at <= now() - interval '3 minutes'
      and o.created_at > now() - interval '24 hours'
      and (o.last_reminder_sent_at is null
           or o.last_reminder_sent_at <= now() - (case when o.created_at > now() - interval '1 hour' then interval '170 seconds' else interval '30 minutes' end))
  loop
    if r.vendor_user_id is not null then
      perform public.create_notification(r.vendor_user_id, 'order_reminder', 'Order waiting for you',
        'A customer order is still waiting. Accept or decline it so they know where they stand.',
        'orderDetail', jsonb_build_object('orderId', r.id), null);
    end if;
    if r.buyer_id is not null then
      perform public.create_notification(r.buyer_id, 'order_reminder', 'Your order is still waiting',
        'The vendor has not responded yet. You can send them a reminder from the order page.',
        'orderDetail', jsonb_build_object('orderId', r.id), null);
    end if;
    update public.orders set last_reminder_sent_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;


--
-- Name: report_service_offer_payment(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_service_offer_payment(p_order_id uuid, p_amount numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_offer public.service_offers%rowtype; v_payment_id uuid; v_vendor_user uuid; v_vendor_name text; v_buyer_name text;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select so.* into v_offer from public.service_offers so join public.orders o on o.id=so.order_id where o.id=p_order_id for update;
  if v_offer.id is null or v_offer.buyer_id<>v_uid then raise exception 'You are not authorized to report this service payment.' using errcode='42501'; end if;
  if v_offer.status not in ('awaiting_payment','payment_reported','disputed') then raise exception 'This service offer is not awaiting payment.' using errcode='22023'; end if;
  if p_amount is null or p_amount<=0 or abs(p_amount-v_offer.current_price)>0.01 then raise exception 'Payment amount must match the agreed service price.' using errcode='22023'; end if;
  select user_id,business_name into v_vendor_user,v_vendor_name from public.vendors where id=v_offer.vendor_id; select name into v_buyer_name from public.users where id=v_uid;
  select id into v_payment_id from public.payments where order_id=p_order_id and payment_type='sale_price' and status='pending' and provider_reference='service_offer_report' order by created_at desc limit 1 for update;
  if v_payment_id is null then insert into public.payments(order_id,payment_type,amount,method,status,provider_reference) values(p_order_id,'sale_price',p_amount,'transfer','pending','service_offer_report') returning id into v_payment_id; else update public.payments set amount=p_amount,method='transfer',provider_reference='service_offer_report' where id=v_payment_id; end if;
  update public.service_offers set status='payment_reported',payment_reported_at=coalesce(payment_reported_at,now()),updated_at=now() where id=v_offer.id;
  update public.orders set status='payment_unresolved'::public.order_status,payment_unresolved_at=coalesce(payment_unresolved_at,now()),payment_escalated_at=null,awaiting_confirmation_since=null where id=p_order_id;
  perform public.create_notification(v_vendor_user,'service_payment_reported','Payment unresolved',coalesce(v_buyer_name,'The buyer')||' says they paid '||to_char(p_amount,'FM999G999G999G990.00')||' for '||coalesce(v_vendor_name,'your service')||'. Check your account and either confirm the payment or raise a dispute.','orderDetail',jsonb_build_object('productId',v_offer.listing_id,'serviceOfferId',v_offer.id,'orderId',p_order_id),v_uid);
  return jsonb_build_object('success',true,'status','payment_unresolved','payment_id',v_payment_id);
end;$$;


--
-- Name: request_manual_password_reset(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_manual_password_reset(p_email text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_email text := lower(trim(coalesce(p_email,'')));
  v_user_id uuid;
  v_request_id uuid;
  v_token text;
  v_admin record;
  v_target_view text;
  v_target_params jsonb;
begin
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'Enter a valid email address.';
  end if;

  select id into v_user_id from auth.users where lower(email) = v_email limit 1;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.password_reset_requests(email,user_id,token_hash)
  values (v_email,v_user_id,encode(extensions.digest(v_token,'sha256'),'hex'))
  returning id into v_request_id;

  for v_admin in select id, coalesce(is_super_admin,false) as is_super_admin from public.users where role::text='admin'
  loop
    v_target_view := case when v_admin.is_super_admin then 'adminPasswordResets' else 'adminDisputes' end;
    v_target_params := case when v_admin.is_super_admin then jsonb_build_object('requestId',v_request_id) else '{}'::jsonb end;
    perform public.create_notification(
      v_admin.id,
      'password_reset_request',
      'Password reset request',
      'A password reset request was received for ' || v_email || '. ' || case when v_admin.is_super_admin then 'Your approval is required.' else 'The super admin has been notified.' end,
      v_target_view,
      v_target_params,
      null
    );
  end loop;

  return jsonb_build_object('request_id',v_request_id,'token',v_token,'expires_at',now()+interval '30 minutes');
end;
$$;


--
-- Name: require_buyer_phone_for_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_buyer_phone_for_order() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_phone text;
begin
  SELECT phone INTO v_phone FROM public.users WHERE id=NEW.buyer_id;
  IF trim(coalesce(v_phone,''))='' THEN RAISE EXCEPTION 'A phone number is required before you can place an order.' USING ERRCODE='22023'; END IF;
  RETURN NEW;
end;
$$;


--
-- Name: resolve_account_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_account_role(p_user_id uuid DEFAULT auth.uid()) RETURNS public.user_role
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_role public.user_role;
  v_vendor_exists boolean;
begin
  if p_user_id is null then return null; end if;

  select role into v_role from public.users where id = p_user_id;
  if v_role is null then return null; end if;
  if v_role = 'admin'::public.user_role then return 'admin'::public.user_role; end if;

  -- A paused storefront is still owned by a vendor. Only a non-deleted,
  -- verified vendor identity is authoritative for the vendor role; is_active
  -- controls storefront visibility/order acceptance, not account type.
  select exists(
    select 1 from public.vendors v
    where v.user_id = p_user_id
      and v.verification_status = 'verified'::public.vendor_verification_status
      and v.deleted_at is null
  ) into v_vendor_exists;

  if v_vendor_exists then return 'vendor'::public.user_role; end if;
  return 'buyer'::public.user_role;
end;
$$;


--
-- Name: resolve_dispute(uuid, text, public.order_status); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_dispute(p_dispute_id uuid, p_admin_notes text, p_new_order_status public.order_status DEFAULT NULL::public.order_status) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select order_id into v_order_id from disputes where id = p_dispute_id;
  if v_order_id is null then
    raise exception 'dispute not found';
  end if;

  update disputes set status = 'resolved', admin_notes = p_admin_notes where id = p_dispute_id;

  if p_new_order_status is not null then
    update orders set status = p_new_order_status where id = v_order_id;
  end if;
end;
$$;


--
-- Name: respond_service_offer(uuid, text, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_service_offer(p_offer_id uuid, p_action text, p_price numeric DEFAULT NULL::numeric, p_expected_price numeric DEFAULT NULL::numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_offer public.service_offers%rowtype; v_vendor_user uuid; v_product_name text; v_other_user uuid; v_order_id uuid;
begin
 if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
 select * into v_offer from public.service_offers where id=p_offer_id for update;
 if not found then raise exception 'Offer not found.' using errcode='P0002'; end if;
 select user_id into v_vendor_user from public.vendors where id=v_offer.vendor_id;
 select name into v_product_name from public.products where id=v_offer.listing_id;
 if v_offer.status in ('expired','declined','completed','disputed') then raise exception 'This offer can no longer be changed.' using errcode='22023'; end if;
 if v_offer.expires_at <= now() then update public.service_offers set status='expired' where id=v_offer.id; raise exception 'This offer has expired.' using errcode='22023'; end if;
 if p_expected_price is not null and abs(v_offer.current_price-p_expected_price)>0.01 then raise exception 'This offer changed. Refresh before responding.' using errcode='40001'; end if;
 if v_offer.current_offer_by='vendor' then
   if v_offer.buyer_id<>v_uid then raise exception 'Only the buyer can respond to the vendor offer.' using errcode='42501'; end if;
 else
   if v_vendor_user<>v_uid then raise exception 'Only the vendor can respond to the buyer offer.' using errcode='42501'; end if;
 end if;
 if p_action='accept' then
   insert into public.orders(buyer_id,vendor_id,order_type,status,total_amount,deposit_amount,delivery_method,delivery_address,delivery_phone,buyer_note,payment_timing,payment_deposit_percent,service_offer_id,commission_exempt)
   values(v_offer.buyer_id,v_offer.vendor_id,'sale','confirmed',v_offer.current_price,0,'pickup',null,null,v_offer.description,'pay_before',100,v_offer.id,false) returning id into v_order_id;
   update public.orders set deposit_amount=0 where id=v_order_id;
   insert into public.order_items(order_id,product_id,quantity,unit_price) values(v_order_id,v_offer.listing_id,1,v_offer.current_price);
   update public.service_offers set status='awaiting_payment',accepted_at=now(),order_id=v_order_id,expires_at=now()+interval '48 hours' where id=v_offer.id;
   v_other_user:=case when v_offer.current_offer_by='buyer' then v_offer.buyer_id else v_vendor_user end;
   perform public.create_notification(v_other_user,'service_offer_accepted','Service price accepted','Your agreed price for '||coalesce(v_product_name,'the service')||' is '||to_char(v_offer.current_price,'FM999G999G999G990.00')||'. You can now pay the vendor directly.','orderDetail',jsonb_build_object('orderId',v_order_id,'serviceOfferId',v_offer.id),v_uid);
   return jsonb_build_object('success',true,'status','awaiting_payment','order_id',v_order_id,'price',v_offer.current_price);
 elsif p_action='decline' then
   v_other_user:=case when v_offer.current_offer_by='buyer' then v_vendor_user else v_offer.buyer_id end;
   update public.service_offers set status='declined',expires_at=now() where id=v_offer.id;
   perform public.create_notification(v_other_user,'service_offer_declined','Service request declined','The service request for '||coalesce(v_product_name,'the service')||' was declined.','productDetail',jsonb_build_object('productId',v_offer.listing_id,'serviceOfferId',v_offer.id),v_uid);
   return jsonb_build_object('success',true,'status','declined');
 elsif p_action='counter' then
   if p_price is null or p_price<=0 then raise exception 'Enter a valid counter-offer price.' using errcode='22023'; end if;
   if v_offer.round_count>=7 then raise exception 'The maximum number of counter-offers has been reached. Accept or decline this offer.' using errcode='22023'; end if;
   v_other_user:=case when v_offer.current_offer_by='buyer' then v_offer.buyer_id else v_vendor_user end;
   update public.service_offers set current_price=round(p_price,2),current_offer_by=case when v_offer.current_offer_by='buyer' then 'vendor' else 'buyer' end,status='countered',round_count=round_count+1,expires_at=now()+interval '72 hours' where id=v_offer.id;
   perform public.create_notification(v_other_user,'service_offer_countered','New service price proposed','A new price of '||to_char(round(p_price,2),'FM999G999G999G990.00')||' was proposed for '||coalesce(v_product_name,'the service')||'.','productDetail',jsonb_build_object('productId',v_offer.listing_id,'serviceOfferId',v_offer.id),v_uid);
   return jsonb_build_object('success',true,'status','countered','price',round(p_price,2),'round_count',v_offer.round_count+1);
 else raise exception 'Invalid offer action.' using errcode='22023'; end if;
end; $$;


--
-- Name: restore_product_stock_on_cancelled_sale(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restore_product_stock_on_cancelled_sale() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_item record;
BEGIN
  -- Restore stock exactly once when a sale order transitions into cancelled.
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.order_type = 'sale' THEN
    FOR v_item IN
      SELECT oi.product_id, SUM(oi.quantity)::integer AS quantity
      FROM public.order_items oi
      WHERE oi.order_id = NEW.id
      GROUP BY oi.product_id
    LOOP
      UPDATE public.products
      SET quantity_available = LEAST(
        quantity_total,
        quantity_available + v_item.quantity
      )
      WHERE id = v_item.product_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: revoke_points(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_points(p_user uuid, p_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare l record;
begin
  delete from public.points_ledger where user_id = p_user and event_key = p_key
    returning points, week_start, kind into l;
  if not found then return; end if;
  update public.points_weekly set
    points = points - l.points,
    tx_count = greatest(0, tx_count - case when l.kind = 'order_completed' then 1 else 0 end),
    updated_at = now()
  where user_id = p_user and week_start = l.week_start;
end $$;


--
-- Name: ring_callee_again(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ring_callee_again(p_call_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.voice_calls%rowtype; v_nid uuid;
begin
  select * into r from public.voice_calls where id = p_call_id;
  if not found or r.caller_id <> auth.uid() or r.status <> 'ringing' or r.created_at < now() - interval '45 seconds' or r.rings >= 9 then return false; end if;
  select n.id into v_nid from public.notifications n
    where n.type = 'incoming_call' and n.user_id = r.callee_id and n.target_params->>'callId' = p_call_id::text
    order by n.created_at desc limit 1;
  if v_nid is null then return false; end if;
  update public.voice_calls set rings = rings + 1 where id = p_call_id;
  perform net.http_post(
    url := 'https://levromart.vercel.app/api/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '<WEBHOOK_SECRET>'),
    body := jsonb_build_object('notificationId', v_nid, 'ringAgain', true)
  );
  return true;
end $$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: save_product_variants(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_id uuid;
  item jsonb;
  v_id uuid;
  v_name text;
  v_photo_url text;
  v_sale_price numeric;
  v_discount_price numeric;
  v_rental_rate numeric;
  v_sort_order integer;
  v_quantity integer;
  v_size text;
  v_color text;
  v_description text;
  submitted_ids uuid[] := array[]::uuid[];
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode='42501';
  end if;

  select p.vendor_id into v_vendor_id
  from public.products p
  where p.id = p_product_id;

  if v_vendor_id is null then
    raise exception 'Product not found.' using errcode='P0002';
  end if;

  if not public.owns_vendor(v_vendor_id) and not public.is_admin() then
    raise exception 'You do not have permission to edit this product.' using errcode='42501';
  end if;

  if p_variants is null or jsonb_typeof(p_variants) <> 'array' then
    raise exception 'Invalid varieties payload.' using errcode='22023';
  end if;

  -- This is the critical large-batch path: one transaction, no follower
  -- notification work, and a bounded database execution time. The follower
  -- notification is dispatched separately after a successful save.
  perform set_config('levromart.batch_variant_save', '1', true);
  perform set_config('statement_timeout', '30s', true);

  for item in select value from jsonb_array_elements(p_variants) with ordinality as t(value, ord)
  loop
    v_id := nullif(item->>'id','')::uuid;
    v_name := nullif(trim(item->>'name'),'');
    if v_name is null then
      raise exception 'Every variety needs a variety name.' using errcode='22023';
    end if;

    v_photo_url := nullif(item->>'photo_url','');
    v_sale_price := nullif(item->>'sale_price','')::numeric;
    v_discount_price := nullif(item->>'discount_price','')::numeric;
    v_rental_rate := nullif(item->>'rental_rate','')::numeric;
    v_sort_order := coalesce(nullif(item->>'sort_order','')::integer,0);
    v_quantity := coalesce(nullif(item->>'quantity_available','')::integer,0);
    v_size := nullif(trim(item->>'size'),'');
    v_color := nullif(trim(item->>'color'),'');
    v_description := nullif(trim(item->>'description'),'');

    if v_sale_price is null or v_sale_price <= 0 then
      raise exception 'Enter a valid sale price for %.', v_name using errcode='22023';
    end if;
    if v_discount_price is not null and (v_discount_price <= 0 or v_discount_price >= v_sale_price) then
      raise exception 'Discount price for % must be lower than its regular price.', v_name using errcode='22023';
    end if;
    if v_quantity < 0 then
      raise exception 'Quantity for % cannot be negative.', v_name using errcode='22023';
    end if;

    if v_id is not null and exists(select 1 from public.product_variants where id=v_id and product_id=p_product_id) then
      update public.product_variants
      set name=v_name,
          photo_url=v_photo_url,
          sale_price=v_sale_price,
          discount_price=v_discount_price,
          rental_rate=v_rental_rate,
          sort_order=v_sort_order,
          quantity_available=v_quantity,
          size=v_size,
          color=v_color,
          description=v_description,
          updated_at=now()
      where id=v_id and product_id=p_product_id;
      submitted_ids := array_append(submitted_ids,v_id);
    else
      v_id := coalesce(v_id,gen_random_uuid());
      insert into public.product_variants(
        id,product_id,name,photo_url,sale_price,discount_price,rental_rate,
        sort_order,quantity_available,size,color,description
      ) values(
        v_id,p_product_id,v_name,v_photo_url,v_sale_price,v_discount_price,v_rental_rate,
        v_sort_order,v_quantity,v_size,v_color,v_description
      );
      submitted_ids := array_append(submitted_ids,v_id);
    end if;
  end loop;

  delete from public.product_variants pv
  where pv.product_id=p_product_id
    and not (pv.id = any(submitted_ids));

  select coalesce(jsonb_agg(to_jsonb(pv) order by pv.sort_order,pv.created_at),'[]'::jsonb)
    into result
  from public.product_variants pv
  where pv.product_id=p_product_id;

  return result;
end;
$$;


--
-- Name: search_ai_conversations(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_ai_conversations(p_query text) RETURNS TABLE(id uuid, title text, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select distinct c.id, c.title, c.updated_at
  from ai_conversations c
  left join ai_messages m on m.conversation_id = c.id
  where c.user_id = auth.uid()
    and (c.title ilike '%' || p_query || '%' or m.content ilike '%' || p_query || '%')
  order by c.updated_at desc
  limit 50;
$$;


--
-- Name: search_product_ids(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_product_ids(p_query text) RETURNS TABLE(id uuid, relevance real)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select r.id, r.relevance from public.search_products_full_v2(p_query, 500) r;
$$;


--
-- Name: search_products_full(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_products_full(p_query text, p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, name text, photos text[], sale_price numeric, discount_price numeric, rental_rate numeric, rental_rate_unit text, is_service boolean, vendor_business_name text, vendor_verification_status text, vendor_is_active boolean, vendor_lat double precision, vendor_lng double precision, relevance real)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with words as (
    select distinct w from unnest(string_to_array(trim(regexp_replace(p_query, '\s+', ' ', 'g')), ' ')) as w
    where length(w) > 2
  ),
  expanded_words as (
    select w from words
    union
    select s.synonym as w from words w2 join public.search_synonyms s on s.term = w2.w
  )
  select p.id, p.name, p.photos, p.sale_price, p.discount_price, p.rental_rate, p.rental_rate_unit, p.is_service,
    v.business_name as vendor_business_name, v.verification_status::text as vendor_verification_status,
    v.is_active as vendor_is_active, v.lat as vendor_lat, v.lng as vendor_lng,
    greatest(
      similarity(p.name, p_query),
      coalesce((select max(similarity(p.name, w)) from words), 0)
    ) as relevance
  from products p
  join vendors v on v.id = p.vendor_id
  left join categories c on c.id = p.category_id
  left join categories pc on pc.id = c.parent_category_id
  where p.status = 'active'
    and v.verification_status = 'verified'
    and v.is_active = true
    and (
      p.name ilike '%' || p_query || '%'
      or p.description ilike '%' || p_query || '%'
      or v.business_name ilike '%' || p_query || '%'
      or (v.name_changed_at > now() - interval '14 days' and v.previous_business_name ilike '%' || p_query || '%')
      or c.name ilike '%' || p_query || '%'
      or pc.name ilike '%' || p_query || '%'
      or exists (
        select 1 from expanded_words w
        where p.name ilike '%' || w.w || '%'
          or p.description ilike '%' || w.w || '%'
          or c.name ilike '%' || w.w || '%'
          or pc.name ilike '%' || w.w || '%'
      )
      or similarity(p.name, p_query) > 0.25
    )
  order by relevance desc, p.view_count desc
  limit p_limit;
$$;


--
-- Name: search_products_full_v2(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_products_full_v2(p_query text, p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, name text, photos text[], sale_price numeric, discount_price numeric, rental_rate numeric, rental_rate_unit text, is_service boolean, vendor_business_name text, vendor_verification_status text, vendor_is_active boolean, vendor_lat double precision, vendor_lng double precision, relevance real, vendor_id uuid, vendor_avg_rating numeric, vendor_review_count integer, listing_type text, service_price_unit text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  with q as (select trim(regexp_replace(lower(coalesce(p_query,'')), '[[:space:]]+', ' ', 'g')) as s),
  toks as (select distinct t from q, unnest(string_to_array(q.s,' ')) t where t <> ''),
  nt as (select greatest(count(*),1)::float n from toks),
  syn as (
    select distinct sy.synonym as w from toks join public.search_synonyms sy on sy.term = toks.t
    union select distinct regexp_replace(t,'(es|s)$','') from toks where length(t) > 3
  ),
  scored as (
    select p.id as pid, p.name as pname, p.photos as pphotos, p.sale_price as psale, p.discount_price as pdisc, p.rental_rate as prate, p.rental_rate_unit as punit, p.is_service as psvc,
      v.business_name vname, v.verification_status::text vver, v.is_active vact, v.lat vlat, v.lng vlng, v.id vid, v.avg_rating::numeric vavg, v.review_count::integer vrev,
      p.listing_type::text plt, p.service_price_unit::text psu, p.view_count pview,
      lower(p.name) nl,
      (select count(*) from toks where position(' ' || toks.t in ' ' || lower(p.name)) > 0)::float
        + 0.7 * (select count(*) from toks where position(' ' || toks.t in ' ' || lower(p.name)) = 0 and length(toks.t) > 2 and word_similarity(toks.t, lower(p.name)) >= 0.5)::float as hits,
      (select count(*) from syn where length(w) > 2 and lower(p.name) like '%' || w || '%') as synhits,
      (c.name ilike '%' || (select s from q) || '%' or pc.name ilike '%' || (select s from q) || '%'
        or exists (select 1 from toks where length(t) > 2 and (c.name ilike '%' || t || '%' or pc.name ilike '%' || t || '%' or sc.name ilike '%' || t || '%'))) as catm,
      (v.business_name ilike '%' || (select s from q) || '%' or (v.name_changed_at > now() - interval '14 days' and v.previous_business_name ilike '%' || (select s from q) || '%')) as vendm,
      (p.description ilike '%' || (select s from q) || '%' or exists (select 1 from toks where length(t) > 2 and p.description ilike '%' || t || '%')
        or exists (select 1 from product_variants pv where pv.product_id = p.id and (pv.name ilike '%' || (select s from q) || '%'))) as descm
    from products p
    join vendors v on v.id = p.vendor_id
    left join categories c on c.id = p.category_id
    left join categories pc on pc.id = c.parent_category_id
    left join sectors sc on sc.id = coalesce(c.sector_id, v.sector_id)
    where p.status = 'active' and v.verification_status = 'verified' and v.is_active = true
  )
  select pid, pname, pphotos, psale, pdisc, prate, punit, psvc, vname, vver, vact, vlat, vlng,
    ((case when nl like (select s from q) || '%' then 6 else 0 end)
     + (case when nl like '%' || (select s from q) || '%' then 3 else 0 end)
     + 4.0 * least(hits / (select n from nt), 1)
     + (case when synhits > 0 then 1.5 else 0 end)
     + 2.0 * word_similarity((select s from q), nl)
     + similarity(nl, (select s from q))
     + (case when catm then 0.8 else 0 end) + (case when vendm then 0.6 else 0 end) + (case when descm then 0.3 else 0 end))::real as relevance,
    vid, vavg, vrev, plt, psu
  from scored
  where (select s from q) <> '' and (hits > 0 or synhits > 0 or catm or vendm or descm or word_similarity((select s from q), nl) >= 0.4 or similarity(nl, (select s from q)) > 0.25)
  order by relevance desc, pview desc
  limit p_limit;
$_$;


--
-- Name: send_background_reminders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_background_reminders() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare payload jsonb;
begin
  select coalesce(jsonb_agg(x), '[]'::jsonb) into payload from (
    select u.user_id,
      case when sum(u.msgs) > 0 then 'messages' else 'orders' end as kind,
      case when sum(u.msgs) > 0 then 'You have unread messages' else 'Orders need your attention' end as title,
      concat_ws(' · ',
        case when sum(u.msgs) > 0 then sum(u.msgs) || ' unread message' || case when sum(u.msgs) = 1 then '' else 's' end end,
        case when sum(u.ords) > 0 then sum(u.ords) || ' order' || case when sum(u.ords) = 1 then '' else 's' end || ' not yet completed' end) as body,
      case when sum(u.msgs) > 0 then 'messages' else 'buyerOrders' end as view,
      '{}'::jsonb as params
    from (
      select case when m.sender_id = c.buyer_id then v.user_id else c.buyer_id end as user_id, count(*)::int as msgs, 0 as ords
        from messages m join conversations c on c.id = m.conversation_id join vendors v on v.id = c.vendor_id
       where m.read_at is null and m.created_at > now() - interval '3 days'
       group by 1
      union all
      select o.buyer_id, 0, count(*)::int from orders o
       where o.status in ('pending','confirmed','payment_unresolved','handed_over','returned') and o.created_at > now() - interval '30 days' group by 1
      union all
      -- vendors are not nagged about orders that are already fully paid: only the buyer's confirmation is left
      select v.user_id, 0, count(*)::int from orders o join vendors v on v.id = o.vendor_id
       where o.status in ('pending','confirmed','payment_unresolved','handed_over','returned') and o.created_at > now() - interval '30 days'
         and not (o.status in ('confirmed','handed_over') and (
           case when o.delivery_method = 'delivery'
             then exists (select 1 from payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = 'delivery_deposit_20')
                  and exists (select 1 from payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = case when o.order_type::text = 'sale' then 'sale_price' else 'rental_fee' end)
             else exists (select 1 from payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = case when o.order_type::text = 'sale' then 'sale_price' else 'rental_fee' end)
           end))
       group by 1
    ) u
    where u.user_id is not null and exists (select 1 from push_subscriptions ps where ps.user_id = u.user_id)
    group by u.user_id
  ) x;
  if jsonb_array_length(payload) = 0 then return; end if;
  perform net.http_post(url := 'https://levromart.vercel.app/api/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', '<WEBHOOK_SECRET>'),
    body := jsonb_build_object('reminders', payload));
end $$;


--
-- Name: send_order_reminder(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_order_reminder(p_order_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.orders%rowtype;
  v_vendor_user_id uuid;
  v_notification_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode='42501';
  end if;

  select o.* into v_order from public.orders o
   where o.id = p_order_id and o.buyer_id = auth.uid() and o.status = 'pending';
  if not found then
    raise exception 'This order no longer needs a reminder.' using errcode='22023';
  end if;

  select v.user_id into v_vendor_user_id from public.vendors v
   where v.id = v_order.vendor_id and v.deleted_at is null limit 1;
  if v_vendor_user_id is null then
    raise exception 'Vendor not found.' using errcode='22023';
  end if;

  -- The customer's identity stays hidden from the vendor until the order is accepted.
  insert into public.notifications (
    user_id, type, title, body, target_view, target_params, vendor_id, notification_category
  ) values (
    v_vendor_user_id,
    'order_reminder',
    'Order reminder',
    'A customer is waiting for you to accept or decline their order.',
    'orderDetail',
    jsonb_build_object('orderId', v_order.id, 'vendorId', v_order.vendor_id),
    v_order.vendor_id,
    'order'
  )
  returning id into v_notification_id;

  return v_notification_id;
end;
$$;


--
-- Name: set_ai_conversation_shared(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_ai_conversation_shared(p_conversation_id uuid, p_shared boolean) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_token uuid;
begin
  if not exists (select 1 from ai_conversations where id = p_conversation_id and user_id = auth.uid()) then
    raise exception 'Conversation not found';
  end if;

  if p_shared then
    update ai_conversations
      set share_token = coalesce(share_token, gen_random_uuid())
      where id = p_conversation_id
      returning share_token into v_token;
  else
    update ai_conversations set share_token = null where id = p_conversation_id;
    v_token := null;
  end if;

  return v_token;
end;
$$;


--
-- Name: set_homepage_carousel_slides_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_homepage_carousel_slides_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: set_order_buyer_location(uuid, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_order_buyer_location(p_order_id uuid, p_lat double precision, p_lng double precision) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'invalid location';
  end if;
  update public.orders
  set buyer_lat = p_lat, buyer_lng = p_lng
  where id = p_order_id
    and buyer_id = auth.uid()
    and delivery_method = 'delivery'
    and status = 'pending';
  if not found then raise exception 'Only your pending delivery orders can store a delivery location.'; end if;
end;
$$;


--
-- Name: set_order_buyer_note(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_order_buyer_note(p_order_id uuid, p_note text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  cleaned_note text := NULLIF(
    left(trim(COALESCE(p_note, '')), 500),
    ''
  );

  updated_count integer := 0;

BEGIN

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;


  UPDATE public.orders

  SET buyer_note = cleaned_note

  WHERE id = p_order_id
    AND buyer_id = auth.uid();


  GET DIAGNOSTICS updated_count = ROW_COUNT;


  IF updated_count = 0 THEN
    RAISE EXCEPTION 'You cannot modify this order';
  END IF;


  RETURN true;

END;
$$;


--
-- Name: set_order_item_variant(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_updated integer := 0;
BEGIN

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'You must be logged in.';
  END IF;


  UPDATE public.order_items oi
  SET
    variant_name = NULLIF(TRIM(p_variant_name), ''),
    variant_color = NULLIF(TRIM(p_variant_color), '')
  FROM public.orders o
  LEFT JOIN public.vendors v
    ON v.id = o.vendor_id
  WHERE oi.order_id = p_order_id
    AND oi.product_id = p_product_id
    AND o.id = p_order_id
    AND (
      o.buyer_id = auth.uid()
      OR v.user_id = auth.uid()
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;


  IF v_updated = 0 THEN
    RAISE EXCEPTION
      'The order item could not be found or you do not have permission to update it.';
  END IF;


  RETURN true;

END;
$$;


--
-- Name: set_request_buyer_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_request_buyer_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  select name, avatar_url into NEW.buyer_name, NEW.buyer_avatar_url from users where id = NEW.buyer_id;
  return NEW;
end;
$$;


--
-- Name: set_review_buyer_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_review_buyer_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  select name, avatar_url into NEW.buyer_name, NEW.buyer_avatar_url from users where id = NEW.buyer_id;
  return NEW;
end;
$$;


--
-- Name: set_updated_at_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$ begin new.updated_at=now(); return new; end $$;


--
-- Name: set_vendor_billing_model(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_vendor_billing_model(p_billing_model text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare v_vendor_id uuid; begin if p_billing_model not in ('commission','monthly') then raise exception 'invalid billing model'; end if; select id into v_vendor_id from public.vendors where user_id=auth.uid() and deleted_at is null limit 1; if v_vendor_id is null then raise exception 'no vendor profile found'; end if; update public.vendors set billing_model=p_billing_model where id=v_vendor_id; end; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: vendor_follow_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_follow_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    follower_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    muted_until timestamp with time zone,
    mute_mode text DEFAULT 'none'::text NOT NULL,
    notify_new_listing boolean DEFAULT true NOT NULL,
    notify_new_service boolean DEFAULT true NOT NULL,
    notify_new_package boolean DEFAULT true NOT NULL,
    notify_new_variety boolean DEFAULT true NOT NULL,
    notify_price_change boolean DEFAULT true NOT NULL,
    notify_discount boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_follow_preferences_mute_mode_check CHECK ((mute_mode = ANY (ARRAY['none'::text, '1h'::text, '8h'::text, 'always'::text])))
);


--
-- Name: TABLE vendor_follow_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_follow_preferences IS '[B] Vendors & storefronts - Per-follow notification preferences (new listing, price change, discount, mute window).';


--
-- Name: set_vendor_follow_preferences(uuid, text, boolean, boolean, boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_vendor_follow_preferences(p_vendor_id uuid, p_mute_mode text DEFAULT 'none'::text, p_notify_new_listing boolean DEFAULT true, p_notify_new_service boolean DEFAULT true, p_notify_new_package boolean DEFAULT true, p_notify_new_variety boolean DEFAULT true, p_notify_price_change boolean DEFAULT true, p_notify_discount boolean DEFAULT true) RETURNS public.vendor_follow_preferences
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v public.vendor_follow_preferences; v_until timestamptz; begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if not exists(select 1 from public.vendor_follows where follower_id=auth.uid() and vendor_id=p_vendor_id) then raise exception 'Follow the vendor before changing notification preferences.' using errcode='22023'; end if;
  if p_mute_mode not in('none','1h','8h','always') then raise exception 'Invalid mute duration.' using errcode='22023'; end if;
  v_until:=case p_mute_mode when '1h' then now()+interval '1 hour' when '8h' then now()+interval '8 hours' else null end;
  insert into public.vendor_follow_preferences(follower_id,vendor_id,muted_until,mute_mode,notify_new_listing,notify_new_service,notify_new_package,notify_new_variety,notify_price_change,notify_discount,updated_at)
  values(auth.uid(),p_vendor_id,v_until,p_mute_mode,p_notify_new_listing,p_notify_new_service,p_notify_new_package,p_notify_new_variety,p_notify_price_change,p_notify_discount,now())
  on conflict(follower_id,vendor_id) do update set muted_until=excluded.muted_until,mute_mode=excluded.mute_mode,notify_new_listing=excluded.notify_new_listing,notify_new_service=excluded.notify_new_service,notify_new_package=excluded.notify_new_package,notify_new_variety=excluded.notify_new_variety,notify_price_change=excluded.notify_price_change,notify_discount=excluded.notify_discount,updated_at=now()
  returning * into v; return v;
end;$$;


--
-- Name: snapshot_product_comment_author(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_product_comment_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ declare u public.users%rowtype; begin select * into u from public.users where id=auth.uid(); if u.id is null then raise exception 'Authenticated user profile not found'; end if; new.user_id:=auth.uid(); new.author_name:=coalesce(nullif(trim(u.name),''),'Levromart user'); new.author_avatar_url:=u.avatar_url; new.updated_at:=now(); return new; end; $$;


--
-- Name: start_voice_call(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_voice_call(p_conversation_id uuid) RETURNS TABLE(call_id uuid, callee_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_buyer uuid; v_vendor_user uuid; v_vendor_name text; v_vendor_logo text; v_caller_name text; v_caller_avatar text;
  v_callee uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
  select c.buyer_id, v.user_id, v.business_name, v.logo_url into v_buyer, v_vendor_user, v_vendor_name, v_vendor_logo
    from public.conversations c join public.vendors v on v.id = c.vendor_id where c.id = p_conversation_id;
  if v_buyer is null then raise exception 'Conversation not found.' using errcode = '22023'; end if;
  if auth.uid() not in (v_buyer, v_vendor_user) then raise exception 'Not your conversation.' using errcode = '42501'; end if;
  if not public.can_call_in_conversation(p_conversation_id) then
    raise exception 'Calls are available while you have an accepted order together.' using errcode = '42501';
  end if;
  if exists (select 1 from public.voice_calls where caller_id = auth.uid() and status = 'ringing' and created_at > now() - interval '60 seconds') then
    raise exception 'You already have a call ringing.' using errcode = '22023';
  end if;
  v_callee := case when auth.uid() = v_buyer then v_vendor_user else v_buyer end;
  if auth.uid() = v_vendor_user then
    v_caller_name := v_vendor_name;
    v_caller_avatar := coalesce(v_vendor_logo, (select avatar_url from public.users where id = auth.uid()));
  else
    select name, avatar_url into v_caller_name, v_caller_avatar from public.users where id = auth.uid();
  end if;
  insert into public.voice_calls (conversation_id, caller_id, callee_id) values (p_conversation_id, auth.uid(), v_callee) returning id into v_id;
  perform public.create_notification(v_callee, 'incoming_call', 'Incoming call',
    coalesce(v_caller_name, 'Someone') || ' is calling you.', 'messages',
    jsonb_build_object('conversationId', p_conversation_id, 'callId', v_id, 'callerName', coalesce(v_caller_name, 'Someone'), 'callerAvatar', v_caller_avatar), auth.uid());
  return query select v_id, v_callee;
end $$;


--
-- Name: submit_account_appeal(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_account_appeal(p_message text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_reason text;
  v_user_name text;
  v_recent_count int;
  v_admin_id uuid;
begin
  select suspended_reason into v_reason from users where id = auth.uid() and suspended_at is not null;
  if v_reason is null then
    raise exception 'Your account is not currently suspended.';
  end if;
  if exists (select 1 from account_appeals where user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have an appeal pending review.';
  end if;
  if p_message is null or trim(p_message) = '' then
    raise exception 'Please explain why you''re appealing.';
  end if;

  select count(*) into v_recent_count from account_appeals
    where user_id = auth.uid() and created_at > now() - interval '24 hours';
  if v_recent_count >= 3 then
    raise exception 'You''ve reached the limit of 3 appeals per day. Please try again later.';
  end if;

  insert into account_appeals (user_id, suspension_reason, message)
    values (auth.uid(), v_reason, p_message);

  select name into v_user_name from users where id = auth.uid();
  for v_admin_id in select id from users where role = 'admin' loop
    perform create_notification(
      v_admin_id, 'appeal_submitted', 'New suspension appeal',
      coalesce(v_user_name, 'A user') || ' has appealed their suspension.', 'adminPeople', '{}'::jsonb, auth.uid()
    );
  end loop;
end;
$$;


--
-- Name: submit_campus_school(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_campus_school(p_name text) RETURNS TABLE(status text, merged_into text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n text:=lv_norm_school(p_name); r campus_submissions;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(n)<3 then raise exception 'name too short'; end if;
  insert into campus_submissions(name_norm,name,submitted_by) values(n,left(trim(p_name),80),auth.uid())
  on conflict (name_norm) do update set requests=campus_submissions.requests+1
  returning * into r;
  return query select r.status, r.merged_into;
end $$;


--
-- Name: submit_face_check(text, real, text, boolean, boolean, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_face_check(p_selfie_url text, p_distance real, p_match text, p_liveness boolean, p_ocr_matric boolean DEFAULT NULL::boolean, p_ocr_name boolean DEFAULT NULL::boolean, p_ocr_text text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_id uuid;
begin
  select id into v_id from vendors where user_id=auth.uid() and deleted_at is null limit 1;
  if v_id is null then raise exception 'no vendor profile'; end if;
  if p_match is not null and p_match not in ('strong','possible','mismatch','unchecked') then raise exception 'bad match value'; end if;
  update vendor_student_verification set
    selfie_url=coalesce(p_selfie_url,selfie_url), face_distance=p_distance, face_match=p_match, face_liveness=p_liveness,
    face_checked_at=now(), face_v=2,
    ocr_matric_found=coalesce(p_ocr_matric,ocr_matric_found), ocr_name_found=coalesce(p_ocr_name,ocr_name_found),
    ocr_text=coalesce(left(p_ocr_text,400),ocr_text), ocr_checked_at=case when p_ocr_matric is not null or p_ocr_name is not null or p_ocr_text is not null then now() else ocr_checked_at end
  where vendor_id=v_id;
end $$;


--
-- Name: submit_monthly_listing_payment(text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_monthly_listing_payment(p_kind text, p_listing_id uuid, p_payer_name text, p_receipt_path text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_vendor public.vendors%rowtype; v_id uuid; v_exists boolean;
begin
  if p_kind not in ('product','package') then raise exception 'Invalid listing type.'; end if;
  if length(trim(coalesce(p_payer_name,''))) < 2 then raise exception 'Enter the name of the account that made the transfer.'; end if;
  if length(trim(coalesce(p_receipt_path,''))) < 3 then raise exception 'Upload your payment receipt.'; end if;
  select * into v_vendor from public.vendors where user_id = auth.uid() and deleted_at is null limit 1;
  if v_vendor.id is null then raise exception 'Your vendor profile is unavailable.'; end if;
  if p_kind='product' then
    select exists(select 1 from public.products where id=p_listing_id and vendor_id=v_vendor.id and billing_model='monthly') into v_exists;
  else
    select exists(select 1 from public.vendor_packages where id=p_listing_id and vendor_id=v_vendor.id and billing_model='monthly') into v_exists;
  end if;
  if not v_exists then raise exception 'Monthly listing not found for this vendor.'; end if;
  if not (trim(p_receipt_path) like auth.uid()::text || '/%') then raise exception 'Invalid receipt upload path.'; end if;
  insert into public.monthly_listing_submissions(kind,listing_id,vendor_id,user_id,payer_name,receipt_path,status)
  values(p_kind,p_listing_id,v_vendor.id,auth.uid(),trim(p_payer_name),trim(p_receipt_path),'pending') returning id into v_id;
  if p_kind='product' then
    update public.products set billing_status='pending_payment', status=case when billing_paid_until is null or billing_paid_until <= now() then 'paused' else status end, billing_reference=null where id=p_listing_id and vendor_id=v_vendor.id;
  else
    update public.vendor_packages set billing_status='pending_payment', status=case when billing_paid_until is null or billing_paid_until <= now() then 'paused' else status end, billing_reference=null where id=p_listing_id and vendor_id=v_vendor.id;
  end if;
  insert into public.notifications(user_id,type,title,body,target_view,target_params,actor_id,actor_name,vendor_id,notification_category,metadata)
  select u.id,'monthly_listing_submitted','New monthly listing payment',v_vendor.business_name || ' submitted a ₦1,000 monthly listing payment for review.','adminMonthlyListings',jsonb_build_object('submissionId',v_id),auth.uid(),v_vendor.business_name,v_vendor.id,'system',jsonb_build_object('submission_id',v_id,'kind',p_kind,'listing_id',p_listing_id)
  from public.users u where u.role='admin';
  return v_id;
end; $$;


--
-- Name: submit_suggestion(text, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_suggestion(p_target_type text, p_target_vendor_id uuid, p_message text, p_is_anonymous boolean) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_id uuid;
begin
  if p_message is null or length(trim(p_message)) = 0 then
    raise exception 'Message is required.';
  end if;
  if p_target_type = 'vendor' and p_target_vendor_id is null then
    raise exception 'A vendor must be specified.';
  end if;
  insert into suggestions (sender_id, target_type, target_vendor_id, message, is_anonymous)
  values (auth.uid(), p_target_type, p_target_vendor_id, trim(p_message), coalesce(p_is_anonymous, false))
  returning id into v_id;
  return v_id;
end;
$$;


--
-- Name: submit_vendor_application(uuid, text, text, text, text, text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_whatsapp text DEFAULT NULL::text, p_cac_number text DEFAULT NULL::text, p_bio text DEFAULT NULL::text, p_bank_code text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_account_name text DEFAULT NULL::text, p_account_number text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_vendor_id uuid;
  v_status vendor_verification_status;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit a vendor application.';
  end if;
  if nullif(btrim(p_business_name), '') is null then
    raise exception 'Business name is required.';
  end if;
  if nullif(btrim(p_whatsapp), '') is null then
    raise exception 'WhatsApp number is required.';
  end if;
  if p_sector_id is null then
    raise exception 'Business sector is required.';
  end if;

  select id, verification_status into v_vendor_id, v_status
  from public.vendors
  where user_id = v_uid
  limit 1;

  if v_vendor_id is not null and v_status = 'verified'::vendor_verification_status then
    raise exception 'Your vendor account is already active.';
  end if;

  insert into public.vendors (
    user_id, sector_id, business_name, address, city, phone, whatsapp_number,
    cac_number, bio, bank_code, bank_name, account_name, account_number,
    is_active, verification_status, deleted_at
  ) values (
    v_uid, p_sector_id, btrim(p_business_name), nullif(btrim(p_address), ''),
    nullif(btrim(p_city), ''), nullif(btrim(p_phone), ''), btrim(p_whatsapp),
    nullif(btrim(p_cac_number), ''), nullif(btrim(p_bio), ''),
    nullif(btrim(p_bank_code), ''), nullif(btrim(p_bank_name), ''),
    nullif(btrim(p_account_name), ''), nullif(btrim(p_account_number), ''),
    false, 'pending'::vendor_verification_status, null
  )
  on conflict (user_id) do update set
    sector_id = excluded.sector_id,
    business_name = excluded.business_name,
    address = excluded.address,
    city = excluded.city,
    phone = excluded.phone,
    whatsapp_number = excluded.whatsapp_number,
    cac_number = excluded.cac_number,
    bio = excluded.bio,
    bank_code = excluded.bank_code,
    bank_name = excluded.bank_name,
    account_name = excluded.account_name,
    account_number = excluded.account_number,
    is_active = false,
    verification_status = 'pending'::vendor_verification_status,
    deleted_at = null
  returning id into v_vendor_id;

  perform public.create_notification(
    v_uid,
    'vendor_application_submitted',
    'Application submitted',
    'Your vendor application has been submitted successfully and is now awaiting review.',
    'home',
    jsonb_build_object('vendorId', v_vendor_id),
    null
  );

  -- Admins previously had no way to know a new vendor application had come
  -- in except by manually checking the Vendor tab -- notify every admin
  -- immediately so review isn't delayed.
  perform public.notify_admins(
    'New vendor application',
    btrim(p_business_name) || ' submitted a vendor application awaiting review.',
    'adminPanel',
    jsonb_build_object('vendorId', v_vendor_id),
    v_uid
  );

  return v_vendor_id;
end;
$$;


--
-- Name: sync_current_account_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_current_account_role() RETURNS public.user_role
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_role user_role; begin
 if v_uid is null then raise exception 'Authentication required.'; end if;
 select public.resolve_account_role(v_uid) into v_role; if v_role is null then raise exception 'Account profile not found.'; end if;
 update public.users set role=v_role where id=v_uid and role<>'admin' and role is distinct from v_role; return v_role;
end; $$;


--
-- Name: sync_order_payment_deposit_percent_from_item(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_order_payment_deposit_percent_from_item() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.orders%rowtype;
  v_product public.products%rowtype;
  v_pct numeric(5,2);
begin
  select * into v_order from public.orders where id = new.order_id for update;
  if v_order.id is null or v_order.payment_timing <> 'pay_after' or new.product_id is null then
    return new;
  end if;
  select * into v_product from public.products where id = new.product_id;
  v_pct := greatest(0.01, least(99.99, coalesce(v_product.payment_deposit_percent, 20)));
  if exists (
    select 1 from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = new.order_id
      and oi.id <> new.id
      and coalesce(p.payment_deposit_percent,20) <> v_pct
  ) then
    raise exception 'These cart items use different deposit percentages. Please check out them separately.' using errcode='22023';
  end if;
  update public.orders set payment_deposit_percent = v_pct where id = new.order_id;
  return new;
end;
$$;


--
-- Name: sync_role_from_vendor_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_role_from_vendor_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.user_id is null then return new; end if;
  if new.verification_status='verified'::vendor_verification_status and new.deleted_at is null then
    -- A storefront pause (is_active = false) does NOT turn a vendor into a buyer.
    -- Account type is controlled by verification/deletion; is_active only controls
    -- storefront visibility/order acceptance.
    update public.users set role='vendor', role_selected=true
    where id=new.user_id and role<>'admin';
  elsif new.verification_status in ('rejected'::vendor_verification_status,'pending'::vendor_verification_status) or new.deleted_at is not null then
    update public.users set role='buyer', role_selected=true
    where id=new.user_id and role<>'admin';
  end if;
  return new;
end;
$$;


--
-- Name: sync_vendor_avatar_from_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_vendor_avatar_from_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'UPDATE' and new.avatar_url is not distinct from old.avatar_url then
    return new;
  end if;
  update public.vendors
     set logo_url = new.avatar_url
   where user_id = new.id
     and deleted_at is null;
  return new;
end;
$$;


--
-- Name: sync_vendor_profile_avatar(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_vendor_profile_avatar() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'UPDATE' and new.avatar_url is not distinct from old.avatar_url then
    return new;
  end if;
  update public.vendors
     set logo_url = new.avatar_url
   where user_id = new.id
     and deleted_at is null;
  return new;
end;
$$;


--
-- Name: sync_vendor_review_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_vendor_review_stats() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  target_vendor_id uuid;
begin
  target_vendor_id := coalesce(NEW.vendor_id, OLD.vendor_id);
  update vendors set
    avg_rating = (select coalesce(avg(rating), 0)::numeric(3,2) from reviews where vendor_id = target_vendor_id),
    review_count = (select count(*)::int from reviews where vendor_id = target_vendor_id)
  where id = target_vendor_id;
  return null;
end;
$$;


--
-- Name: toggle_ai_message_reaction(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_ai_message_reaction(p_message_id uuid, p_emoji text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_current text;
  v_new text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_emoji is null or length(p_emoji) = 0 or length(p_emoji) > 8 then
    raise exception 'Invalid emoji';
  end if;

  select c.user_id, am.reaction into v_owner, v_current
  from public.ai_messages am
  join public.ai_conversations c on c.id = am.conversation_id
  where am.id = p_message_id;
  if v_owner is null then
    raise exception 'Message not found';
  end if;
  if v_owner <> v_uid then
    raise exception 'Not your conversation';
  end if;

  v_new := case when v_current = p_emoji then null else p_emoji end;
  update public.ai_messages set reaction = v_new where id = p_message_id;
  return v_new;
end;
$$;


--
-- Name: toggle_conversation_in_list(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_conversation_in_list(p_list_id uuid, p_conversation_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_exists boolean;
begin
  if not exists (select 1 from chat_lists where id = p_list_id and user_id = auth.uid()) then
    raise exception 'List not found';
  end if;
  if not exists (
    select 1 from conversations c
    left join vendors v on v.id = c.vendor_id
    where c.id = p_conversation_id and (c.buyer_id = auth.uid() or v.user_id = auth.uid())
  ) then
    raise exception 'Conversation not found';
  end if;

  select exists(select 1 from chat_list_conversations where list_id = p_list_id and conversation_id = p_conversation_id) into v_exists;
  if v_exists then
    delete from chat_list_conversations where list_id = p_list_id and conversation_id = p_conversation_id;
    return false;
  else
    insert into chat_list_conversations(list_id, conversation_id) values (p_list_id, p_conversation_id);
    return true;
  end if;
end;
$$;


--
-- Name: toggle_conversation_pin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_conversation_pin(p_conversation_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_is_buyer boolean;
  v_is_vendor boolean;
  v_new boolean;
begin
  select c.buyer_id = auth.uid(), v.user_id = auth.uid()
    into v_is_buyer, v_is_vendor
  from conversations c join vendors v on v.id = c.vendor_id
  where c.id = p_conversation_id;

  if not (v_is_buyer or v_is_vendor) then
    raise exception 'not part of this conversation';
  end if;

  if v_is_buyer then
    update conversations set pinned_by_buyer = not pinned_by_buyer where id = p_conversation_id returning pinned_by_buyer into v_new;
  else
    update conversations set pinned_by_vendor = not pinned_by_vendor where id = p_conversation_id returning pinned_by_vendor into v_new;
  end if;
  return v_new;
end;
$$;


--
-- Name: toggle_conversation_unread(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_conversation_unread(p_conversation_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_is_buyer boolean;
  v_new_value boolean;
begin
  select (c.buyer_id = auth.uid())
    into v_is_buyer
  from conversations c
  join vendors v on v.id = c.vendor_id
  where c.id = p_conversation_id and (c.buyer_id = auth.uid() or v.user_id = auth.uid());

  if v_is_buyer is null then
    raise exception 'Conversation not found';
  end if;

  if v_is_buyer then
    update conversations set marked_unread_by_buyer = not marked_unread_by_buyer where id = p_conversation_id
      returning marked_unread_by_buyer into v_new_value;
  else
    update conversations set marked_unread_by_vendor = not marked_unread_by_vendor where id = p_conversation_id
      returning marked_unread_by_vendor into v_new_value;
  end if;

  return v_new_value;
end;
$$;


--
-- Name: toggle_message_reaction(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_conversation_id uuid;
  v_is_participant boolean;
  v_current jsonb;
  v_updated jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_emoji is null or length(p_emoji) = 0 or length(p_emoji) > 8 then
    raise exception 'Invalid emoji';
  end if;

  select m.conversation_id, m.reactions into v_conversation_id, v_current
  from public.messages m where m.id = p_message_id;
  if v_conversation_id is null then
    raise exception 'Message not found';
  end if;

  select exists (
    select 1 from public.conversations c
    where c.id = v_conversation_id
      and (c.buyer_id = v_uid or (select vendors.user_id from public.vendors where vendors.id = c.vendor_id) = v_uid)
  ) into v_is_participant;
  if not v_is_participant then
    raise exception 'Not a participant in this conversation';
  end if;

  if v_current->>v_uid::text = p_emoji then
    v_updated := v_current - v_uid::text;
  else
    v_updated := v_current || jsonb_build_object(v_uid::text, p_emoji);
  end if;

  update public.messages set reactions = v_updated where id = p_message_id;
  return v_updated;
end;
$$;


--
-- Name: toggle_vendor_follow(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_vendor_follow(p_vendor_id uuid, p_following boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_vendor public.vendors%rowtype; begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_vendor from public.vendors where id=p_vendor_id and deleted_at is null and verification_status='verified' and is_active=true;
  if not found then raise exception 'Vendor is not currently available.' using errcode='P0002'; end if;
  if v_vendor.user_id=auth.uid() then raise exception 'You cannot follow your own shop.' using errcode='22023'; end if;
  if coalesce(p_following,false) then
    insert into public.vendor_follows(follower_id,vendor_id) values(auth.uid(),p_vendor_id) on conflict do nothing;
    insert into public.vendor_follow_preferences(follower_id,vendor_id) values(auth.uid(),p_vendor_id) on conflict(follower_id,vendor_id) do nothing;
    return true;
  else
    delete from public.vendor_follows where follower_id=auth.uid() and vendor_id=p_vendor_id;
    delete from public.vendor_follow_preferences where follower_id=auth.uid() and vendor_id=p_vendor_id;
    return false;
  end if;
end;$$;


--
-- Name: touch_ai_conversation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_ai_conversation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update ai_conversations set updated_at = now() where id = NEW.conversation_id;
  return NEW;
end;
$$;


--
-- Name: touch_last_seen(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_last_seen() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into public.user_presence (user_id, last_seen_at) select auth.uid(), now() where auth.uid() is not null
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
$$;


--
-- Name: touch_presence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_presence() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ insert into public.app_presence(user_id,seen_at) values(auth.uid(),now()) on conflict (user_id) do update set seen_at=now() where auth.uid() is not null $$;


--
-- Name: touch_service_offer_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_service_offer_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin new.updated_at := now(); return new; end; $$;


--
-- Name: touch_support_request_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_support_request_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: transition_order_status(uuid, public.order_status); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transition_order_status(p_order_id uuid, p_new_status public.order_status) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_is_vendor boolean; v_fee_paid boolean; v_delivery_deposit_paid boolean; v_pct numeric;
begin
  select * into v_order from public.orders where id=p_order_id for update; if v_order.id is null then raise exception 'order not found'; end if;
  v_is_vendor:=public.owns_vendor(v_order.vendor_id); if not v_is_vendor and v_order.buyer_id<>v_uid then raise exception 'not authorized'; end if;
  v_pct:=greatest(1,least(99,coalesce(v_order.payment_deposit_percent,20)));
  if not v_is_vendor and not ((v_order.status='pending' and p_new_status='cancelled') or (v_order.status='confirmed' and p_new_status='cancelled') or (v_order.status='handed_over' and p_new_status='returned' and v_order.order_type='rental')) then raise exception 'buyers may only cancel eligible orders or return handed-over rentals'; end if;
  if v_is_vendor and not ((v_order.status='pending' and p_new_status in ('confirmed','cancelled')) or (v_order.status='confirmed' and p_new_status in ('completed','cancelled')) or (v_order.status='handed_over' and p_new_status='returned' and v_order.order_type='rental') or (v_order.status='handed_over' and p_new_status='completed' and v_order.delivery_method='delivery')) then raise exception 'invalid status transition from % to %',v_order.status,p_new_status; end if;
  if p_new_status='completed' then
    select exists(select 1 from public.payments where order_id=p_order_id and payment_type in ('sale_price','rental_fee') and status='paid') into v_fee_paid;
    if v_order.delivery_method='delivery' then
      select exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid') into v_delivery_deposit_paid;
      if not v_delivery_deposit_paid or not v_fee_paid then raise exception 'Required delivery payments must be verified before this order can be completed.'; end if;
      if not v_is_vendor then raise exception 'Only the vendor can complete a delivery order after required payment is verified.'; end if;
    elsif v_order.order_type in ('sale','rental') then
      if not v_fee_paid then raise exception 'The required sale/rental payment must be verified before this order can be completed.'; end if;
      if not v_is_vendor then raise exception 'Only the vendor can complete this order after payment is verified.'; end if;
    end if;
  end if;
  update public.orders set status=p_new_status where id=p_order_id;
  if p_new_status in ('handed_over','returned') then update public.orders set awaiting_confirmation_since=now() where id=p_order_id; end if;
end;$$;


--
-- Name: trg_apply_signup_referral(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_apply_signup_referral() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c text := nullif(NEW.raw_user_meta_data->>'referral_code', '');
begin
  begin
    if c is not null then
      perform public.apply_referral_internal(NEW.id, c, coalesce(NEW.raw_user_meta_data->>'requested_role', NEW.raw_user_meta_data->>'role') = 'vendor');
    end if;
  exception when others then raise warning 'signup referral: %', sqlerrm;
  end;
  return NEW;
end $$;


--
-- Name: trg_points_follow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_follow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid;
begin
  begin
    select user_id into v_user from public.vendors where id = NEW.vendor_id;
    if v_user is not null and v_user <> NEW.follower_id then
      perform public.award_points(v_user, 'follower', 'follow:' || NEW.follower_id || ':' || NEW.vendor_id, NEW.follower_id, 'New follower');
    end if;
  exception when others then raise warning 'points follow: %', sqlerrm;
  end;
  return NEW;
end $$;


--
-- Name: trg_points_listing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_listing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_removed boolean;
begin
  begin
    v_removed := NEW.status::text = 'removed' or coalesce(to_jsonb(NEW)->>'admin_deleted_at', '') <> '';
    if v_removed then
      perform public.points_revoke_listing(NEW.vendor_id, NEW.id);
    elsif NEW.status::text = 'active' and (tg_op = 'INSERT' or OLD.status::text is distinct from 'active') then
      perform public.points_for_new_listing(NEW.vendor_id, NEW.id);
    end if;
  exception when others then raise warning 'points listing: %', sqlerrm;
  end;
  return NEW;
end $$;


--
-- Name: trg_points_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_order() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid;
begin
  begin
    if NEW.status::text = 'completed' and OLD.status::text is distinct from 'completed' then
      perform public.points_award_order(NEW.id, true);
    elsif OLD.status::text = 'completed' and NEW.status::text in ('cancelled', 'disputed') then
      select user_id into v_user from public.vendors where id = NEW.vendor_id;
      perform public.revoke_points(v_user, 'order:' || NEW.id);
    end if;
  exception when others then raise warning 'points order: %', sqlerrm;
  end;
  return NEW;
end $$;


--
-- Name: trg_points_rank_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_rank_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_old int := coalesce(case when tg_op = 'UPDATE' then old.points end, 0);
        v_rank_new int; v_rank_old int; v_name text; r record; v_r int;
begin
  begin
    if new.week_start <> public.points_week_start() or new.points <= v_old or new.points <= 0 then return new; end if;
    if not exists (select 1 from public.vendors where user_id = new.user_id) then return new; end if;
    select business_name into v_name from public.vendors where user_id = new.user_id limit 1;
    select 1 + count(*) into v_rank_new from public.points_weekly w join public.vendors v on v.user_id = w.user_id
      where w.week_start = new.week_start and w.user_id <> new.user_id and w.points > new.points;
    select 1 + count(*) into v_rank_old from public.points_weekly w join public.vendors v on v.user_id = w.user_id
      where w.week_start = new.week_start and w.user_id <> new.user_id and w.points > v_old;
    if v_rank_new >= v_rank_old then return new; end if;
    if v_rank_new <= 10 then
      perform public.notify_rank_upsert(new.user_id,
        case when v_rank_new = 1 then 'You are #1 this week' else 'You moved up to #' || v_rank_new end,
        case when v_rank_new = 1 then 'You are leading the Vendor of the Week race. Keep going.' else 'You passed ' || (v_rank_old - v_rank_new) || ' vendor' || case when v_rank_old - v_rank_new > 1 then 's' else '' end || ' on the leaderboard.' end,
        jsonb_build_object('rank', v_rank_new, 'dir', 'up'));
    end if;
    for r in
      select w.user_id, w.points from public.points_weekly w join public.vendors v on v.user_id = w.user_id
       where w.week_start = new.week_start and w.user_id <> new.user_id and w.points > v_old and w.points < new.points and w.points > 0
    loop
      select 1 + count(*) into v_r from public.points_weekly w join public.vendors v on v.user_id = w.user_id
        where w.week_start = new.week_start and w.user_id <> r.user_id and w.points > r.points;
      perform public.notify_rank_upsert(r.user_id,
        coalesce(v_name, 'Another vendor') || ' passed you',
        'You are now #' || v_r || ' this week. ' || coalesce(v_name, 'They') || ' has ' || new.points || ' pts. Earn more to move back up.',
        jsonb_build_object('rank', v_r, 'dir', 'down'));
    end loop;
  exception when others then
    null;
  end;
  return new;
end $$;


--
-- Name: trg_points_review(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_review() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid;
begin
  begin
    if tg_op = 'DELETE' then
      select user_id into v_user from public.vendors where id = OLD.vendor_id;
      perform public.revoke_points(v_user, 'review:' || OLD.id);
      return OLD;
    end if;
    if tg_op = 'UPDATE' then
      if OLD.rating is not distinct from NEW.rating then return NEW; end if;
      select user_id into v_user from public.vendors where id = NEW.vendor_id;
      perform public.revoke_points(v_user, 'review:' || NEW.id);
      perform public.points_award_review(NEW.id, false);
    else
      perform public.points_award_review(NEW.id, true);
    end if;
  exception when others then raise warning 'points review: %', sqlerrm;
  end;
  return coalesce(NEW, OLD);
end $$;


--
-- Name: trg_points_vendor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_points_vendor() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare ref record; ref2 record; was_done boolean := false; now_done boolean;
begin
  begin
    if NEW.verification_status::text = 'verified' and (tg_op = 'INSERT' or OLD.verification_status::text is distinct from 'verified') then
      select * into ref from public.referrals where referred_user_id = NEW.user_id and vendor_awarded = false;
      if found then
        perform public.award_points(ref.referrer_user_id, 'ref_vendor', 'refv:' || NEW.user_id, NEW.user_id, 'Vendor joined with your code');
        select * into ref2 from public.referrals where referred_user_id = ref.referrer_user_id and code <> 'VOID';
        if found then
          perform public.award_points(ref2.referrer_user_id, 'ref2_vendor', 'refv2:' || NEW.user_id, NEW.user_id, 'Your referred vendor brought in a vendor');
        end if;
        update public.referrals set vendor_awarded = true where referred_user_id = NEW.user_id;
      end if;
    end if;
    -- only when the profile BECOMES complete (logo, bio, address, city), never for a vendor who already had them
    now_done := coalesce(NEW.logo_url,'') <> '' and coalesce(NEW.bio,'') <> '' and coalesce(NEW.address,'') <> '' and coalesce(NEW.city,'') <> '';
    if tg_op = 'UPDATE' then
      was_done := coalesce(OLD.logo_url,'') <> '' and coalesce(OLD.bio,'') <> '' and coalesce(OLD.address,'') <> '' and coalesce(OLD.city,'') <> '';
    end if;
    if now_done and not was_done and tg_op = 'UPDATE' then
      perform public.award_points(NEW.user_id, 'profile_complete', 'profile:' || NEW.id, null, 'Shop profile completed');
    end if;
  exception when others then raise warning 'points vendor: %', sqlerrm;
  end;
  return NEW;
end $$;


--
-- Name: trg_vendor_referral_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_vendor_referral_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    if NEW.referral_code is null or NEW.referral_code = '' then
      NEW.referral_code := public.generate_referral_code(NEW.business_name);
    end if;
  else
    if OLD.referral_code is not null then NEW.referral_code := OLD.referral_code;
    elsif NEW.referral_code is null then NEW.referral_code := public.generate_referral_code(NEW.business_name); end if;
  end if;
  return NEW;
end $$;


--
-- Name: update_voice_call(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_voice_call(p_call_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.voice_calls%rowtype;
begin
  select * into r from public.voice_calls where id = p_call_id;
  if not found or auth.uid() not in (r.caller_id, r.callee_id) then raise exception 'Call not found.' using errcode = '42501'; end if;
  if r.status in ('ended','missed','declined') then return; end if;
  if p_status = 'active' and auth.uid() = r.callee_id and r.status = 'ringing' then
    update public.voice_calls set status = 'active', answered_at = now() where id = p_call_id;
  elsif p_status = 'declined' and auth.uid() = r.callee_id and r.status = 'ringing' then
    update public.voice_calls set status = 'declined', ended_at = now() where id = p_call_id;
  elsif p_status = 'missed' and auth.uid() = r.caller_id and r.status = 'ringing' then
    update public.voice_calls set status = 'missed', ended_at = now() where id = p_call_id;
    perform public.create_notification(r.callee_id, 'missed_call', 'Missed call', 'You missed a call. Open the chat to call back.', 'messages',
      jsonb_build_object('conversationId', r.conversation_id), r.caller_id);
  elsif p_status = 'ended' then
    update public.voice_calls set status = 'ended', ended_at = now() where id = p_call_id;
  end if;
end $$;


--
-- Name: users_campus_to_vendor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.users_campus_to_vendor() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.campus_id is distinct from old.campus_id then
    update public.vendors set campus_id = new.campus_id where user_id = new.id;
  end if;
  return new;
end $$;


--
-- Name: validate_referral_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_referral_code(p_code text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v record; c text := upper(regexp_replace(coalesce(p_code,''), '\s', '', 'g'));
begin
  if length(c) < 4 then return jsonb_build_object('valid', false); end if;
  select business_name, logo_url into v from public.vendors where referral_code = c and deleted_at is null and is_active = true;
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', true, 'business_name', v.business_name, 'logo_url', v.logo_url);
end $$;


--
-- Name: validate_vendor_phone_numbers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_vendor_phone_numbers() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE p text; w text;
BEGIN
  IF NEW.phone IS NOT NULL THEN
    p := regexp_replace(NEW.phone, '[[:space:]().-]', '', 'g');
    IF p ~ '^\+234' THEN p := '0' || substring(p from 5); END IF;
    IF p ~ '^234' THEN p := '0' || substring(p from 4); END IF;
    IF p !~ '^0(70|71|80|81|90|91)[0-9]{8}$' THEN RAISE EXCEPTION 'Enter a valid Nigerian mobile phone number.'; END IF;
  END IF;
  IF NEW.whatsapp_number IS NOT NULL THEN
    w := regexp_replace(NEW.whatsapp_number, '[[:space:]().-]', '', 'g');
    IF w ~ '^\+234' THEN w := '0' || substring(w from 5); END IF;
    IF w ~ '^234' THEN w := '0' || substring(w from 4); END IF;
    IF w !~ '^0(70|71|80|81|90|91)[0-9]{8}$' THEN RAISE EXCEPTION 'Enter a valid Nigerian WhatsApp mobile number.'; END IF;
  END IF;
  RETURN NEW;
END;
$_$;


--
-- Name: vendor_confirm_reported_payment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_confirm_reported_payment(p_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_payment public.payments%rowtype; v_vendor_name text; v_payment_label text; v_should_complete boolean:=false; v_await boolean:=false; v_dispute_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update; if not found then raise exception 'Order not found.'; end if;
  if not exists(select 1 from public.vendors where id=v_order.vendor_id and user_id=v_uid and deleted_at is null) then raise exception 'Only the vendor can confirm this payment.' using errcode='42501'; end if;
  select * into v_payment from public.payments where order_id=p_order_id and status='pending' and provider_reference in ('buyer_report','service_offer_report') order by created_at desc limit 1 for update; if v_payment.id is null then raise exception 'There is no buyer-reported payment awaiting confirmation.' using errcode='22023'; end if;
  update public.payments set status='paid'::public.payment_status,paid_at=coalesce(paid_at,now()),provider_reference=case when provider_reference='service_offer_report' then 'service_offer_confirmed' else 'vendor_confirmed' end where id=v_payment.id;
  if v_payment.payment_type='delivery_deposit_20' then
    update public.orders set status='confirmed'::public.order_status,payment_unresolved_at=null,payment_escalated_at=null where id=p_order_id;
  elsif v_payment.payment_type in ('sale_price','rental_fee') then
    if v_order.delivery_method='delivery' and v_order.payment_timing='pay_after' then v_should_complete:=exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid'); else v_should_complete:=true; end if;
    if v_should_complete and v_order.order_type<>'rental' and v_order.service_offer_id is null and coalesce(v_order.payout_status,'not_applicable')='not_applicable' then v_should_complete:=false; v_await:=true; update public.orders set status=case when status='payment_unresolved' then 'confirmed'::public.order_status else status end,payment_unresolved_at=null,payment_escalated_at=null,awaiting_confirmation_since=now() where id=p_order_id; end if;
    if v_should_complete then update public.orders set status='completed'::public.order_status,completed_at=coalesce(completed_at,now()),payment_unresolved_at=null,payment_escalated_at=null,awaiting_confirmation_since=null where id=p_order_id and status<>'cancelled';
    elsif not v_await then update public.orders set status='confirmed'::public.order_status,payment_unresolved_at=null,payment_escalated_at=null where id=p_order_id; end if;
  end if;
  select id into v_dispute_id from public.disputes where order_id=p_order_id and status='open' order by created_at desc limit 1; if v_dispute_id is not null then update public.disputes set status='resolved',admin_notes=coalesce(admin_notes,'') || case when coalesce(admin_notes,'')='' then '' else E'\n' end || 'Vendor later confirmed the reported payment.' where id=v_dispute_id; end if;
  if v_order.service_offer_id is not null and v_should_complete then update public.service_offers set status='completed',completed_at=now(),updated_at=now() where id=v_order.service_offer_id; end if;
  select business_name into v_vendor_name from public.vendors where id=v_order.vendor_id; v_payment_label:=case v_payment.payment_type when 'delivery_deposit_20' then 'delivery deposit' when 'rental_fee' then 'rental fee' when 'deposit' then 'refundable deposit' else 'payment' end;
  perform public.create_notification(v_order.buyer_id,'payment_confirmed','Payment confirmed',coalesce(v_vendor_name,'The vendor')||' confirmed receipt of your '||v_payment_label||'.'||case when v_should_complete then ' The order is now complete and ready for review.' when v_await then ' Please confirm once you have received your order. It completes automatically in 24 hours if no issue is reported.' else '' end,'orderDetail',jsonb_build_object('orderId',p_order_id,'reviewEligible',v_should_complete),v_uid);
  return jsonb_build_object('success',true,'payment_id',v_payment.id,'order_completed',v_should_complete,'awaiting_buyer_confirmation',v_await,'status',case when v_should_complete then 'completed' else 'confirmed' end);
end;$$;


--
-- Name: vendor_confirm_unreported_payment(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_confirm_unreported_payment(p_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_payment_type public.payment_type;
  v_expected numeric:=0; v_pct numeric; v_vendor_name text; v_payment_id uuid; v_completed boolean:=false;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if not exists(select 1 from public.vendors where id=v_order.vendor_id and user_id=v_uid and deleted_at is null) then raise exception 'Only the vendor can confirm payment for this order.' using errcode='42501'; end if;
  if v_order.status<>'confirmed' then raise exception 'This order is no longer awaiting payment confirmation.' using errcode='22023'; end if;
  if v_order.payment_escalated_at is null then raise exception 'This order has not reached the payment follow-up stage yet.' using errcode='22023'; end if;
  if v_order.delivery_method='delivery' and v_order.payment_timing='pay_after' and not exists(select 1 from public.payments where order_id=p_order_id and payment_type='delivery_deposit_20' and status='paid') then
    v_payment_type:='delivery_deposit_20'::public.payment_type;
    v_pct:=greatest(1,least(99,coalesce(v_order.payment_deposit_percent,20)));
    v_expected:=round(greatest(0,coalesce(v_order.total_amount,0)-coalesce(v_order.delivery_fee,0))*v_pct/100,2);
  else
    v_payment_type:=case when v_order.order_type='rental' then 'rental_fee'::public.payment_type else 'sale_price'::public.payment_type end;
    v_expected:=greatest(0,coalesce(v_order.total_amount,0));
  end if;
  if v_expected<=0 then raise exception 'There is no outstanding payment amount on this order.' using errcode='22023'; end if;
  insert into public.payments(order_id,payment_type,amount,method,status,provider_reference,paid_at)
  values(p_order_id,v_payment_type,v_expected,'transfer'::public.payment_method,'paid'::public.payment_status,'vendor_confirmed_direct',now())
  returning id into v_payment_id;
  if v_payment_type='delivery_deposit_20' then
    update public.orders set payment_escalated_at=null,payment_unresolved_at=null where id=p_order_id;
  else
    v_completed:=true;
    if v_order.order_type<>'rental' and v_order.service_offer_id is null and coalesce(v_order.payout_status,'not_applicable')='not_applicable' then v_completed:=false; update public.orders set status=case when status='payment_unresolved' then 'confirmed'::public.order_status else status end,payment_escalated_at=null,payment_unresolved_at=null,awaiting_confirmation_since=now() where id=p_order_id; else update public.orders set status='completed'::public.order_status,completed_at=coalesce(completed_at,now()),payment_escalated_at=null,payment_unresolved_at=null,awaiting_confirmation_since=null where id=p_order_id; end if;
  end if;
  select business_name into v_vendor_name from public.vendors where id=v_order.vendor_id;
  perform public.create_notification(v_order.buyer_id,'payment_confirmed','Payment confirmed',coalesce(v_vendor_name,'The vendor')||' confirmed that your payment was received. '||case when v_completed then 'Your order is now complete.' else 'Payment recorded. Please confirm once you have received your order; it completes automatically in 24 hours if no issue is reported.' end,'orderDetail',jsonb_build_object('orderId',p_order_id,'reviewEligible',v_completed),v_uid);
  return jsonb_build_object('success',true,'payment_id',v_payment_id,'order_completed',v_completed,'status',case when v_completed then 'completed' else 'confirmed' end);
end;
$$;


--
-- Name: vendor_decline_order(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_decline_order(p_order_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'order not found'; end if;
  if not public.owns_vendor(v_order.vendor_id) then raise exception 'not authorized'; end if;
  if v_order.status not in ('pending','confirmed') then raise exception 'This order can no longer be declined or cancelled here.'; end if;

  update public.orders
    set status = 'cancelled', cancellation_reason = nullif(trim(coalesce(p_reason,'')), ''), cancelled_at = now()
    where id = p_order_id;

  perform public.create_notification(
    v_order.buyer_id,
    'order_cancelled_by_vendor',
    'Order declined',
    case when nullif(trim(coalesce(p_reason,'')), '') is not null
      then 'The vendor declined your order: ' || trim(p_reason)
      else 'The vendor declined your order.'
    end,
    'orderDetail',
    jsonb_build_object('orderId', p_order_id),
    null
  );
end;
$$;


--
-- Name: vendor_dispute_reported_payment(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_dispute_reported_payment(p_order_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_payment public.payments%rowtype; v_dispute_id uuid; v_vendor_name text;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update; if not found then raise exception 'Order not found.'; end if;
  if not exists(select 1 from public.vendors where id=v_order.vendor_id and user_id=v_uid and deleted_at is null) then raise exception 'Only the vendor can dispute this payment.' using errcode='42501'; end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Please explain why you are disputing the reported payment.'; end if;
  select * into v_payment from public.payments where order_id=p_order_id and status='pending' and provider_reference in ('buyer_report','service_offer_report') order by created_at desc limit 1 for update; if v_payment.id is null then raise exception 'There is no buyer-reported payment awaiting dispute.' using errcode='22023'; end if;
  select id into v_dispute_id from public.disputes where order_id=p_order_id and status='open' order by created_at desc limit 1;
  if v_dispute_id is null then insert into public.disputes(order_id,raised_by,reason,status) values(p_order_id,'vendor'::public.dispute_raised_by,p_reason,'open'::public.dispute_status) returning id into v_dispute_id; else update public.disputes set reason=p_reason,raised_by='vendor'::public.dispute_raised_by where id=v_dispute_id; end if;
  update public.orders set status='payment_unresolved'::public.order_status,payment_unresolved_at=coalesce(payment_unresolved_at,now()) where id=p_order_id and status<>'completed';
  select business_name into v_vendor_name from public.vendors where id=v_order.vendor_id;
  perform public.create_notification(v_order.buyer_id,'payment_disputed','Payment unresolved',coalesce(v_vendor_name,'The vendor')||' could not verify your reported payment. Levromart will review the payment claim.','orderDetail',jsonb_build_object('orderId',p_order_id,'disputeId',v_dispute_id),v_uid);
  return jsonb_build_object('success',true,'status','payment_unresolved','dispute_id',v_dispute_id);
end;$$;


--
-- Name: vendor_dispute_unreported_payment(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_dispute_unreported_payment(p_order_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid:=auth.uid(); v_order public.orders%rowtype; v_dispute_id uuid; v_vendor_name text;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if not exists(select 1 from public.vendors where id=v_order.vendor_id and user_id=v_uid and deleted_at is null) then raise exception 'Only the vendor can dispute this order.' using errcode='42501'; end if;
  if v_order.status<>'confirmed' then raise exception 'This order is no longer in the confirmed payment-follow-up state.' using errcode='22023'; end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Please explain why you cannot confirm the payment.'; end if;
  select id into v_dispute_id from public.disputes where order_id=p_order_id and status='open' order by created_at desc limit 1;
  if v_dispute_id is null then
    insert into public.disputes(order_id,raised_by,reason,status) values(p_order_id,'vendor'::public.dispute_raised_by,p_reason,'open'::public.dispute_status) returning id into v_dispute_id;
  else
    update public.disputes set reason=p_reason,raised_by='vendor'::public.dispute_raised_by where id=v_dispute_id;
  end if;
  update public.orders set status='payment_unresolved'::public.order_status,payment_unresolved_at=coalesce(payment_unresolved_at,now()),payment_escalated_at=null where id=p_order_id;
  select business_name into v_vendor_name from public.vendors where id=v_order.vendor_id;
  perform public.create_notification(v_order.buyer_id,'payment_disputed','Payment unresolved',coalesce(v_vendor_name,'The vendor')||' could not confirm the payment for this order. Levromart will review the issue.','orderDetail',jsonb_build_object('orderId',p_order_id,'disputeId',v_dispute_id),v_uid);
  return jsonb_build_object('success',true,'status','payment_unresolved','dispute_id',v_dispute_id);
end;
$$;


--
-- Name: vendor_respond_to_dispute(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_respond_to_dispute(p_dispute_id uuid, p_response text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor_id uuid;
begin
  select o.vendor_id into v_vendor_id
  from disputes d
  join orders o on o.id = d.order_id
  where d.id = p_dispute_id;

  if v_vendor_id is null then
    raise exception 'Dispute not found';
  end if;
  if not owns_vendor(v_vendor_id) then
    raise exception 'Not authorized';
  end if;

  update disputes set vendor_response = p_response where id = p_dispute_id;
end;
$$;


--
-- Name: vendor_set_storefront_active(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_set_storefront_active(p_active boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_vendor public.vendors%rowtype;
  v_owed numeric:=0;
begin
  select * into v_vendor
  from public.vendors
  where user_id=auth.uid() and deleted_at is null
  order by created_at desc nulls last limit 1
  for update;
  if not found then raise exception 'Vendor profile not found.' using errcode='P0002'; end if;

  if p_active=true and coalesce(v_vendor.admin_paused,false) then
    raise exception 'Your storefront was paused by an administrator. Only an administrator can reactivate it.' using errcode='42501';
  end if;

  select public.get_vendor_commission_owed(v_vendor.id) into v_owed;
  if p_active=true and v_owed>0 then
    raise exception 'Your storefront is locked until your outstanding commission of % is paid.',v_owed using errcode='42501';
  end if;

  update public.vendors
  set is_active=p_active,
      admin_paused=case when p_active then false else coalesce(admin_paused,false) end,
      commission_paused=case when p_active then false else commission_paused end,
      commission_pause_reason=case when p_active then null else commission_pause_reason end
  where id=v_vendor.id;

  return jsonb_build_object('success',true,'is_active',p_active,'admin_paused',coalesce(v_vendor.admin_paused,false),'commission_owed',v_owed);
end;
$$;


--
-- Name: vendor_suggest_order_quantity(uuid, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendor_suggest_order_quantity(p_order_id uuid, p_items jsonb, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid(); v_order public.orders%rowtype; v_vendor_user uuid; v_vendor_name text;
  v_oi record; v_new int; v_lines jsonb := '[]'::jsonb; v_changed boolean := false; v_left boolean := false;
  v_summary text := ''; v_note text;
begin
  if v_uid is null then raise exception 'You must be logged in.' using errcode='42501'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Enter the quantity you can supply.' using errcode='22023';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.' using errcode='P0002'; end if;
  select user_id, business_name into v_vendor_user, v_vendor_name from public.vendors where id = v_order.vendor_id;
  if v_vendor_user is distinct from v_uid then raise exception 'Only the vendor can suggest a quantity.' using errcode='42501'; end if;
  if v_order.status <> 'pending' then raise exception 'You can only suggest a quantity while the order is pending.' using errcode='22023'; end if;
  if v_order.order_type <> 'sale' or v_order.package_id is not null then raise exception 'A quantity can only be suggested on product orders.' using errcode='22023'; end if;
  if exists (select 1 from public.payments where order_id = p_order_id and status = 'paid') then
    raise exception 'This order has already been paid for.' using errcode='22023';
  end if;
  for v_oi in
    select oi.id, oi.quantity, p.name from public.order_items oi join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id order by p.name, oi.id
  loop
    v_new := coalesce((select (e->>'quantity')::int from jsonb_array_elements(p_items) e where (e->>'id')::uuid = v_oi.id limit 1), v_oi.quantity);
    if v_new < 0 or v_new > v_oi.quantity then
      raise exception 'You can only suggest the same or a smaller quantity than was ordered.' using errcode='22023';
    end if;
    if v_new <> v_oi.quantity then v_changed := true; end if;
    if v_new > 0 then v_left := true; end if;
    v_lines := v_lines || jsonb_build_object('id', v_oi.id, 'name', v_oi.name, 'requested', v_oi.quantity, 'suggested', v_new);
    v_summary := v_summary || case when v_summary = '' then '' else ', ' end || v_new || ' of ' || v_oi.quantity || ' ' || v_oi.name;
  end loop;
  if not v_changed then raise exception 'Change at least one quantity first.' using errcode='22023'; end if;
  if not v_left then raise exception 'Suggest at least one item, or use Decline to refuse the whole order.' using errcode='22023'; end if;
  v_note := nullif(left(trim(coalesce(p_note, '')), 300), '');
  update public.orders set quantity_proposal = jsonb_build_object('items', v_lines, 'note', v_note, 'proposed_at', now()) where id = p_order_id;
  insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, vendor_id, notification_category, metadata)
  values (v_order.buyer_id, 'order_quantity_suggestion', 'The vendor suggested a different quantity',
    coalesce(v_vendor_name, 'The vendor') || ' can supply ' || v_summary || '. Open your order to accept it or keep your original order.',
    'orderDetail', jsonb_build_object('orderId', p_order_id), null, null, v_order.vendor_id, 'order',
    jsonb_build_object('order_id', p_order_id, 'kind', 'order_quantity_suggestion'));
  return jsonb_build_object('order_id', p_order_id, 'summary', v_summary);
end; $$;


--
-- Name: vendors_default_campus(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vendors_default_campus() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.campus_id is null then
    select u.campus_id into new.campus_id from public.users u where u.id = new.user_id;
  end if;
  return new;
end $$;


--
-- Name: account_appeals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_appeals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    suspension_reason text,
    message text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    admin_response text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    CONSTRAINT account_appeals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


--
-- Name: TABLE account_appeals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.account_appeals IS '[A] Accounts, identity & security - Appeals written by suspended users; reviewed by admins.';


--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    admin_name text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    target_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE admin_actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admin_actions IS '[A] Accounts, identity & security - Audit log of admin actions (who did what to which record).';


--
-- Name: admin_login_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_login_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE admin_login_otps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admin_login_otps IS '[A] Accounts, identity & security - One-time email codes for admin login (verified by api/auth-otp.js). Short-lived, no client access.';


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    share_token uuid
);


--
-- Name: TABLE ai_conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_conversations IS '[I] Levi (AI assistant) & usage limits - Levi conversations per user (optional share token).';


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reaction text,
    attachment_url text,
    attachment_name text,
    attachment_type text,
    attachment_size integer,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: TABLE ai_messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_messages IS '[I] Levi (AI assistant) & usage limits - Messages in a Levi conversation, with reaction and attachment fields.';


--
-- Name: app_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_presence (
    user_id uuid NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE app_presence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_presence IS '[A] Accounts, identity & security - Is the app open right now heartbeat (touch_presence / clear_presence RPCs). api/notify.js skips system pushes for 45 s after the last beat so notifications stay in-app. Different purpose from user_presence.';


--
-- Name: auth_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_activity_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    user_id uuid NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    ip inet,
    source text DEFAULT 'app'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_activity_logs_event_type_check CHECK ((event_type = ANY (ARRAY['login'::text, 'logout'::text])))
);


--
-- Name: TABLE auth_activity_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_activity_logs IS '[A] Accounts, identity & security - Sign-in / sign-out / session events for the admin Login logs page.';


--
-- Name: blocked_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_users (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE blocked_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.blocked_users IS '[A] Accounts, identity & security - Pairs (blocker, blocked) that stop two users messaging each other.';


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    date_range daterange NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bookings_quantity_check CHECK ((quantity > 0))
);


--
-- Name: TABLE bookings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bookings IS '[C] Catalogue, engagement & search - Date ranges reserved for rental order items (exclusion constraint prevents double booking).';


--
-- Name: campus_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campus_submissions (
    name_norm text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    merged_into text,
    submitted_by uuid,
    requests integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT campus_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'merged'::text, 'rejected'::text])))
);


--
-- Name: cart_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    variant_id uuid,
    CONSTRAINT cart_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: TABLE cart_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cart_items IS '[D] Cart, orders & disputes - Items a buyer has in the cart (product + optional variant + quantity).';


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    parent_category_id uuid,
    sector_id uuid NOT NULL
);


--
-- Name: TABLE categories; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.categories IS '[B] Vendors & storefronts - Two-level tree under a sector: parent_category_id is null for a parent (''Other''), set for sub-categories. Products point at sub-categories. A trigger gives uncategorised products a default sub-category named after the vendor''s sector.';


--
-- Name: chat_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_archive (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    buyer_id uuid,
    vendor_id uuid,
    conversation jsonb NOT NULL,
    messages jsonb NOT NULL,
    archived_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE chat_archive; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_archive IS '[F] Messaging & calls - Private archive of chats removed 24 h after an order completes (kept 30 days).';


--
-- Name: chat_list_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_list_conversations (
    list_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE chat_list_conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_list_conversations IS '[F] Messaging & calls - Which conversations belong to which list.';


--
-- Name: chat_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_lists_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 1) AND (char_length(TRIM(BOTH FROM name)) <= 40)))
);


--
-- Name: TABLE chat_lists; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_lists IS '[F] Messaging & calls - User-made chat folders (''lists'').';


--
-- Name: chat_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_usage (
    user_id uuid NOT NULL,
    day date DEFAULT CURRENT_DATE NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE chat_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_usage IS '[I] Levi (AI assistant) & usage limits - Messages sent to Levi per user per day (limit enforced by increment_chat_usage).';


--
-- Name: comment_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    comment_id uuid NOT NULL,
    reporter_id uuid DEFAULT auth.uid() NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comment_reports_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'package'::text])))
);


--
-- Name: commission_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    payment_id uuid,
    order_id uuid,
    amount numeric(12,2) NOT NULL,
    status text DEFAULT 'owed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    due_at timestamp with time zone DEFAULT (now() + '7 days'::interval),
    CONSTRAINT commission_charges_status_check CHECK ((status = ANY (ARRAY['owed'::text, 'paid'::text, 'waived'::text])))
);


--
-- Name: TABLE commission_charges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commission_charges IS '[E] Commission & vendor billing - Commission owed per completed order.';


--
-- Name: COLUMN commission_charges.due_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_charges.due_at IS 'Commission payment deadline; new commission charges are due 7 days after creation. An unpaid overdue charge pauses the vendor storefront until the owed commission is settled.';


--
-- Name: commission_deadline_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_deadline_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    reminder_code text NOT NULL,
    period_key timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE commission_deadline_reminders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commission_deadline_reminders IS '[E] Commission & vendor billing - De-duplication log so each deadline reminder is sent once.';


--
-- Name: commission_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    CONSTRAINT commission_settlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text])))
);


--
-- Name: TABLE commission_settlements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commission_settlements IS '[E] Commission & vendor billing - Payments a vendor makes to settle commission.';


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned_by_buyer boolean DEFAULT false NOT NULL,
    pinned_by_vendor boolean DEFAULT false NOT NULL,
    marked_unread_by_buyer boolean DEFAULT false NOT NULL,
    marked_unread_by_vendor boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversations IS '[F] Messaging & calls - A buyer-vendor thread with pin/unread flags per side.';


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    raised_by public.dispute_raised_by NOT NULL,
    reason text NOT NULL,
    status public.dispute_status DEFAULT 'open'::public.dispute_status NOT NULL,
    admin_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vendor_response text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: TABLE disputes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.disputes IS '[D] Cart, orders & disputes - Issues raised on an order by a buyer or vendor; admin resolves.';


--
-- Name: equipment_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    category_id uuid,
    city text,
    needed_from date,
    needed_to date,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_type text DEFAULT 'rent'::text NOT NULL,
    buyer_name text,
    buyer_avatar_url text,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    campus_id text,
    CONSTRAINT equipment_requests_request_type_check CHECK ((request_type = ANY (ARRAY['rent'::text, 'buy'::text]))),
    CONSTRAINT equipment_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fulfilled'::text, 'cancelled'::text])))
);


--
-- Name: TABLE equipment_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.equipment_requests IS '[D] Cart, orders & disputes - ''Request an item'' posts from customers (also called customer requests).';


--
-- Name: favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    product_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE favorites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.favorites IS '[C] Catalogue, engagement & search - Customer wishlist (products).';


--
-- Name: homepage_carousel_slides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.homepage_carousel_slides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage_path text NOT NULL,
    image_url text NOT NULL,
    link_url text,
    alt_text text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE homepage_carousel_slides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.homepage_carousel_slides IS '[J] Site content & support - Home-page banner slides (image in storage bucket homepage-carousel).';


--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    category text NOT NULL,
    item_name text NOT NULL,
    blood_group text,
    quantity integer DEFAULT 1 NOT NULL,
    urgency text NOT NULL,
    hospital_name text NOT NULL,
    phone text NOT NULL,
    lat double precision,
    lng double precision,
    description text,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id uuid,
    CONSTRAINT inventory_category_check CHECK ((category = ANY (ARRAY['blood'::text, 'equipment'::text, 'medication'::text]))),
    CONSTRAINT inventory_type_check CHECK ((type = ANY (ARRAY['supply'::text, 'sos'::text]))),
    CONSTRAINT inventory_urgency_check CHECK ((urgency = ANY (ARRAY['Critical'::text, 'High'::text, 'Moderate'::text])))
);


--
-- Name: TABLE inventory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inventory IS '[C] Catalogue, engagement & search - Legacy healthcare-equipment / blood-stock listings from the first version of the app. Not used by the marketplace flows; candidate for removal.';


--
-- Name: listing_billing_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_billing_reminders (
    kind text NOT NULL,
    listing_id uuid NOT NULL,
    reminder_code text NOT NULL,
    period_key date NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT listing_billing_reminders_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'package'::text, 'vendor'::text])))
);


--
-- Name: TABLE listing_billing_reminders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_billing_reminders IS '[E] Commission & vendor billing - De-duplication log for listing-billing reminders.';


--
-- Name: listing_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    kind text NOT NULL,
    draft_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT listing_drafts_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'package'::text])))
);


--
-- Name: TABLE listing_drafts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_drafts IS '[E] Commission & vendor billing - Unfinished listings saved while a vendor pays.';


--
-- Name: listing_payment_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_payment_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference text NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    kind text NOT NULL,
    amount_naira numeric(12,2) DEFAULT 999 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    listing_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    consumed_at timestamp with time zone,
    draft_data jsonb,
    CONSTRAINT listing_payment_intents_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'package'::text]))),
    CONSTRAINT listing_payment_intents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'consumed'::text, 'failed'::text])))
);


--
-- Name: TABLE listing_payment_intents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_payment_intents IS '[E] Commission & vendor billing - Paystack payment intents for listing activation.';


--
-- Name: message_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: TABLE message_pins; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_pins IS '[F] Messaging & calls - Pinned messages with expiry.';


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    delivered_at timestamp with time zone,
    reactions jsonb DEFAULT '{}'::jsonb NOT NULL,
    attachment_url text,
    attachment_name text,
    attachment_type text,
    attachment_size integer,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    reply_to_id uuid,
    CONSTRAINT messages_body_check CHECK (((char_length(body) <= 2000) AND ((attachment_url IS NOT NULL) OR (char_length(TRIM(BOTH FROM body)) > 0))))
);


--
-- Name: TABLE messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.messages IS '[F] Messaging & calls - Chat messages (text, attachments, reactions, replies, edit/delete flags). Immutable for evidence: edits are limited by trigger.';


--
-- Name: monthly_listing_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_listing_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    listing_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    user_id uuid NOT NULL,
    payer_name text NOT NULL,
    receipt_path text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_listing_submissions_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'package'::text]))),
    CONSTRAINT monthly_listing_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'deactivated'::text])))
);


--
-- Name: TABLE monthly_listing_submissions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.monthly_listing_submissions IS '[E] Commission & vendor billing - Receipts a vendor uploads to activate a monthly listing; admin approves or rejects.';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    target_view text,
    target_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    actor_name text,
    actor_avatar_url text,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    vendor_id uuid,
    notification_category text DEFAULT 'system'::text NOT NULL,
    group_key text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notifications IS '[G] Notifications - In-app notifications (type, title, body, target_view + target_params for deep links, read/archived/deleted flags). Largest table; types include new_message, order_status_changed, vendor_follow_update, incoming_call, points, rank_change.';


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric NOT NULL,
    rental_start_date date,
    rental_end_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    variant_id uuid,
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_items_unit_price_check CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT rental_dates_check CHECK ((((rental_start_date IS NULL) AND (rental_end_date IS NULL)) OR ((rental_start_date IS NOT NULL) AND (rental_end_date IS NOT NULL) AND (rental_end_date >= rental_start_date))))
);


--
-- Name: TABLE order_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.order_items IS '[D] Cart, orders & disputes - Line items of an order with the unit price at purchase time.';


--
-- Name: order_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_notes_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 500)))
);


--
-- Name: TABLE order_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.order_notes IS '[D] Cart, orders & disputes - Free-text notes exchanged on an order.';


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    order_type public.order_type NOT NULL,
    status public.order_status DEFAULT 'pending'::public.order_status NOT NULL,
    total_amount numeric DEFAULT 0 NOT NULL,
    deposit_amount numeric DEFAULT 0 NOT NULL,
    delivery_method public.delivery_method NOT NULL,
    delivery_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_phone text,
    delivery_fee numeric DEFAULT 0 NOT NULL,
    package_id uuid,
    payout_status text DEFAULT 'not_applicable'::text NOT NULL,
    auto_release_at timestamp with time zone,
    payout_released_at timestamp with time zone,
    payout_transfer_code text,
    awaiting_confirmation_since timestamp with time zone,
    last_reminder_sent_at timestamp with time zone,
    buyer_note text,
    status_changed_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    auto_completed_at timestamp with time zone,
    payment_timing text DEFAULT 'pay_before'::text NOT NULL,
    payment_deposit_percent numeric(5,2) DEFAULT 20 NOT NULL,
    buyer_lat double precision,
    buyer_lng double precision,
    service_offer_id uuid,
    commission_exempt boolean DEFAULT false NOT NULL,
    payment_unresolved_at timestamp with time zone,
    payment_escalated_at timestamp with time zone,
    cancellation_reason text,
    quantity_proposal jsonb,
    CONSTRAINT orders_payment_deposit_percent_check CHECK (((payment_deposit_percent > (0)::numeric) AND (payment_deposit_percent <= (100)::numeric))),
    CONSTRAINT orders_payment_timing_check CHECK ((payment_timing = ANY (ARRAY['pay_before'::text, 'pay_after'::text]))),
    CONSTRAINT orders_payout_status_check CHECK ((payout_status = ANY (ARRAY['not_applicable'::text, 'held'::text, 'released'::text, 'refunded'::text])))
);


--
-- Name: TABLE orders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.orders IS '[D] Cart, orders & disputes - One order per vendor. Money fields, delivery fields, payment_timing / payment_deposit_percent, status timestamps, payout fields (legacy card flow), awaiting_confirmation_since (24 h auto-complete timer).';


--
-- Name: package_comment_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.package_comment_likes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    comment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE package_comment_likes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.package_comment_likes IS '[C] Catalogue, engagement & search - Likes on package comments.';


--
-- Name: package_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.package_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    package_id uuid NOT NULL,
    user_id uuid NOT NULL,
    parent_comment_id uuid,
    content text NOT NULL,
    author_name text DEFAULT 'Levromart user'::text NOT NULL,
    author_avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT package_comments_content_check CHECK (((char_length(TRIM(BOTH FROM content)) >= 1) AND (char_length(TRIM(BOTH FROM content)) <= 2000)))
);


--
-- Name: TABLE package_comments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.package_comments IS '[C] Catalogue, engagement & search - Comments and replies on packages.';


--
-- Name: package_engagement_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.package_engagement_settings (
    package_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    like_visibility text DEFAULT 'everyone'::text NOT NULL,
    allow_comments boolean DEFAULT true NOT NULL,
    comment_audience text DEFAULT 'everyone'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT package_engagement_settings_comment_audience_check CHECK ((comment_audience = ANY (ARRAY['everyone'::text, 'followers'::text]))),
    CONSTRAINT package_engagement_settings_like_visibility_check CHECK ((like_visibility = ANY (ARRAY['everyone'::text, 'followers'::text, 'no_one'::text])))
);


--
-- Name: TABLE package_engagement_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.package_engagement_settings IS '[C] Catalogue, engagement & search - Vendor controls per package (same options as products).';


--
-- Name: package_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.package_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    buyer_id uuid NOT NULL,
    package_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE package_favorites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.package_favorites IS '[C] Catalogue, engagement & search - Customer wishlist (packages).';


--
-- Name: package_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.package_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    package_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT package_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: TABLE package_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.package_items IS '[C] Catalogue, engagement & search - Which products (and quantities) make up a package.';


--
-- Name: password_reset_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejected_by uuid,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    CONSTRAINT password_reset_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'completed'::text, 'expired'::text])))
);


--
-- Name: TABLE password_reset_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.password_reset_requests IS '[A] Accounts, identity & security - Manual password-reset requests approved by admins when email reset is not possible. Token is stored hashed.';


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    payment_type public.payment_type NOT NULL,
    amount numeric NOT NULL,
    method public.payment_method NOT NULL,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    provider_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    CONSTRAINT payments_amount_check CHECK ((amount >= (0)::numeric))
);


--
-- Name: TABLE payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payments IS '[D] Cart, orders & disputes - Payment records per order: sale_price, rental_fee, deposit, delivery_deposit_20 (the pay-after deposit). status pending > paid. provider_reference tells how it was confirmed (buyer_report, vendor_confirmed, admin_confirmed, ...).';


--
-- Name: points_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    points integer NOT NULL,
    event_key text NOT NULL,
    source_user_id uuid,
    note text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    week_start date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE points_ledger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.points_ledger IS '[H] Points, leaderboard & referrals - Every award (event_key makes awards idempotent).';


--
-- Name: points_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_rules (
    kind text NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    points integer NOT NULL,
    audience text DEFAULT 'vendor'::text NOT NULL,
    category text DEFAULT 'growth'::text NOT NULL,
    icon text DEFAULT 'fa-star'::text NOT NULL,
    daily_cap integer,
    weekly_cap integer,
    sort_order integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    min_amount numeric,
    per_source_weekly_cap integer
);


--
-- Name: TABLE points_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.points_rules IS '[H] Points, leaderboard & referrals - Configurable rules: kind, points, audience, daily/weekly caps.';


--
-- Name: points_skips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_skips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    ref text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE points_skips; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.points_skips IS '[H] Points, leaderboard & referrals - Why an award was skipped (cap reached, duplicate, ...).';


--
-- Name: points_weekly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_weekly (
    user_id uuid NOT NULL,
    week_start date NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    tx_count integer DEFAULT 0 NOT NULL,
    last_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE points_weekly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.points_weekly IS '[H] Points, leaderboard & referrals - Rolled-up weekly totals (also used for rank-change notifications).';


--
-- Name: product_comment_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_comment_likes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    comment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE product_comment_likes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_comment_likes IS '[C] Catalogue, engagement & search - Likes on product comments.';


--
-- Name: product_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    user_id uuid NOT NULL,
    parent_comment_id uuid,
    content text NOT NULL,
    author_name text NOT NULL,
    author_avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE product_comments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_comments IS '[C] Catalogue, engagement & search - Comments and replies on products.';


--
-- Name: product_engagement_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_engagement_settings (
    product_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    like_visibility text DEFAULT 'everyone'::text NOT NULL,
    allow_comments boolean DEFAULT true NOT NULL,
    comment_audience text DEFAULT 'everyone'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_engagement_settings_comment_audience_check CHECK ((comment_audience = ANY (ARRAY['everyone'::text, 'followers'::text]))),
    CONSTRAINT product_engagement_settings_like_visibility_check CHECK ((like_visibility = ANY (ARRAY['everyone'::text, 'followers'::text, 'no_one'::text])))
);


--
-- Name: TABLE product_engagement_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_engagement_settings IS '[C] Catalogue, engagement & search - Vendor controls per product: allow comments, who may comment, like visibility.';


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    buyer_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    rating integer NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    buyer_name text,
    buyer_avatar_url text,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: TABLE reviews; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reviews IS '[C] Catalogue, engagement & search - Star rating + comment left by a buyer after a completed order. Triggers keep vendors.avg_rating / review_count current.';


--
-- Name: product_rating_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.product_rating_stats AS
 SELECT oi.product_id,
    round(avg(r.rating), 2) AS avg_rating,
    (count(*))::integer AS review_count
   FROM (public.reviews r
     JOIN public.order_items oi ON ((oi.order_id = r.order_id)))
  WHERE (oi.product_id IS NOT NULL)
  GROUP BY oi.product_id;


--
-- Name: product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL,
    photo_url text,
    sale_price numeric,
    discount_price numeric,
    rental_rate numeric,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    quantity_available integer DEFAULT 0 NOT NULL,
    size text,
    color text,
    description text,
    quantity_total integer,
    CONSTRAINT product_variants_discount_price_check CHECK (((discount_price IS NULL) OR (discount_price >= (0)::numeric))),
    CONSTRAINT product_variants_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 1) AND (char_length(TRIM(BOTH FROM name)) <= 120))),
    CONSTRAINT product_variants_rental_rate_check CHECK (((rental_rate IS NULL) OR (rental_rate >= (0)::numeric))),
    CONSTRAINT product_variants_sale_price_check CHECK (((sale_price IS NULL) OR (sale_price >= (0)::numeric)))
);


--
-- Name: TABLE product_variants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_variants IS '[C] Catalogue, engagement & search - Varieties of a product (own name, photo, price, size, colour, stock).';


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    description text,
    photos text[] DEFAULT '{}'::text[] NOT NULL,
    condition public.product_condition DEFAULT 'used-good'::public.product_condition NOT NULL,
    listing_type public.listing_type NOT NULL,
    sale_price numeric,
    rental_rate numeric,
    rental_rate_unit text,
    deposit_amount numeric,
    quantity_total integer DEFAULT 1 NOT NULL,
    quantity_available integer DEFAULT 1 NOT NULL,
    status public.product_status DEFAULT 'active'::public.product_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    is_service boolean DEFAULT false NOT NULL,
    service_price_unit text,
    discount_price numeric,
    delivery_fee_mode text DEFAULT 'free'::text NOT NULL,
    delivery_fee numeric DEFAULT 0 NOT NULL,
    delivery_fee_per_km numeric DEFAULT 0 NOT NULL,
    billing_model text DEFAULT 'commission'::text NOT NULL,
    billing_status text DEFAULT 'active'::text NOT NULL,
    billing_paid_until timestamp with time zone,
    billing_reference text,
    payment_timing text DEFAULT 'pay_before'::text NOT NULL,
    payment_deposit_percent numeric(5,2) DEFAULT 20 NOT NULL,
    admin_deleted_at timestamp with time zone,
    admin_deleted_by uuid,
    track_quantity boolean DEFAULT false NOT NULL,
    CONSTRAINT listing_price_check CHECK ((((listing_type = 'sale'::public.listing_type) AND (sale_price IS NOT NULL)) OR ((listing_type = 'rent'::public.listing_type) AND (rental_rate IS NOT NULL) AND (rental_rate_unit IS NOT NULL)) OR ((listing_type = 'both'::public.listing_type) AND (sale_price IS NOT NULL) AND (rental_rate IS NOT NULL) AND (rental_rate_unit IS NOT NULL)))),
    CONSTRAINT products_billing_model_check CHECK ((billing_model = ANY (ARRAY['commission'::text, 'monthly'::text]))),
    CONSTRAINT products_billing_status_check CHECK ((billing_status = ANY (ARRAY['active'::text, 'pending_payment'::text, 'past_due'::text, 'cancelled'::text]))),
    CONSTRAINT products_delivery_fee_mode_check CHECK ((delivery_fee_mode = ANY (ARRAY['free'::text, 'flat'::text, 'distance'::text]))),
    CONSTRAINT products_delivery_fee_nonnegative_check CHECK (((delivery_fee >= (0)::numeric) AND (delivery_fee_per_km >= (0)::numeric))),
    CONSTRAINT products_delivery_mode_valid CHECK ((delivery_fee_mode = ANY (ARRAY['free'::text, 'flat'::text, 'distance'::text]))),
    CONSTRAINT products_delivery_values_valid CHECK (((delivery_fee >= (0)::numeric) AND (delivery_fee_per_km >= (0)::numeric) AND (((delivery_fee_mode = 'free'::text) AND (delivery_fee = (0)::numeric) AND (delivery_fee_per_km = (0)::numeric)) OR ((delivery_fee_mode = 'flat'::text) AND (delivery_fee_per_km = (0)::numeric)) OR ((delivery_fee_mode = 'distance'::text) AND (delivery_fee_per_km > (0)::numeric))))),
    CONSTRAINT products_deposit_amount_check CHECK (((deposit_amount IS NULL) OR (deposit_amount >= (0)::numeric))),
    CONSTRAINT products_discount_price_check CHECK (((discount_price IS NULL) OR ((sale_price IS NOT NULL) AND (discount_price > (0)::numeric) AND (discount_price < sale_price)))),
    CONSTRAINT products_discount_price_valid CHECK (((discount_price IS NULL) OR ((sale_price IS NOT NULL) AND (discount_price > (0)::numeric) AND (discount_price < sale_price)))),
    CONSTRAINT products_payment_deposit_percent_check CHECK (((payment_deposit_percent > (0)::numeric) AND (payment_deposit_percent < (100)::numeric))),
    CONSTRAINT products_payment_timing_check CHECK ((payment_timing = ANY (ARRAY['pay_before'::text, 'pay_after'::text]))),
    CONSTRAINT products_quantity_available_check CHECK ((quantity_available >= 0)),
    CONSTRAINT products_quantity_total_check CHECK ((quantity_total >= 0)),
    CONSTRAINT products_rental_rate_check CHECK (((rental_rate IS NULL) OR (rental_rate >= (0)::numeric))),
    CONSTRAINT products_rental_rate_unit_check CHECK ((rental_rate_unit = ANY (ARRAY['day'::text, 'week'::text]))),
    CONSTRAINT products_sale_price_check CHECK (((sale_price IS NULL) OR (sale_price >= (0)::numeric))),
    CONSTRAINT products_service_price_unit_check CHECK (((service_price_unit IS NULL) OR (service_price_unit = ANY (ARRAY['hour'::text, 'day'::text, 'week'::text, 'flat'::text]))))
);


--
-- Name: TABLE products; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.products IS '[C] Catalogue, engagement & search - Sellable items. is_service marks services (commission/negotiated); listing_type = sale / rent / both; billing_* columns track monthly-listing payment; payment_timing = pay_before / pay_after with payment_deposit_percent.';


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE push_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.push_subscriptions IS '[A] Accounts, identity & security - Web-push endpoints per user and device (endpoint, p256dh, auth_key). Used by api/notify.js.';


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    referred_user_id uuid NOT NULL,
    referrer_user_id uuid NOT NULL,
    referrer_vendor_id uuid NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vendor_awarded boolean DEFAULT false NOT NULL,
    CONSTRAINT referrals_check CHECK ((referred_user_id <> referrer_user_id))
);


--
-- Name: TABLE referrals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.referrals IS '[H] Points, leaderboard & referrals - Who referred whom (referral codes live on vendors.referral_code).';


--
-- Name: request_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    message text,
    price numeric(12,2),
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_offers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);


--
-- Name: TABLE request_offers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.request_offers IS '[D] Cart, orders & disputes - Vendor offers made on a customer request.';


--
-- Name: search_synonyms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_synonyms (
    term text NOT NULL,
    synonym text NOT NULL
);


--
-- Name: TABLE search_synonyms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.search_synonyms IS '[C] Catalogue, engagement & search - Synonym pairs used by search_products_full_v2 / search_product_ids.';


--
-- Name: sectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    icon text DEFAULT 'fa-shapes'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE sectors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sectors IS '[B] Vendors & storefronts - Top-level business sectors (e.g. Fashion & Beauty). Vendors can create custom sectors.';


--
-- Name: service_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    listing_id uuid NOT NULL,
    buyer_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    description text NOT NULL,
    current_price numeric(12,2) NOT NULL,
    current_offer_by text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    round_count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '72:00:00'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    payment_reported_at timestamp with time zone,
    completed_at timestamp with time zone,
    order_id uuid,
    payment_reminder_sent_at timestamp with time zone,
    vendor_confirmation_reminder_sent_at timestamp with time zone,
    CONSTRAINT service_offers_current_offer_by_check CHECK ((current_offer_by = ANY (ARRAY['buyer'::text, 'vendor'::text]))),
    CONSTRAINT service_offers_current_price_check CHECK ((current_price > (0)::numeric)),
    CONSTRAINT service_offers_round_count_check CHECK (((round_count >= 1) AND (round_count <= 7))),
    CONSTRAINT service_offers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'countered'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'awaiting_payment'::text, 'payment_reported'::text, 'completed'::text, 'disputed'::text])))
);


--
-- Name: TABLE service_offers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.service_offers IS '[D] Cart, orders & disputes - Negotiation thread for a service listing (price rounds, accept, payment reported, completed). Creates an order when accepted.';


--
-- Name: suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_id uuid,
    target_type text NOT NULL,
    target_vendor_id uuid,
    message text NOT NULL,
    is_anonymous boolean DEFAULT false NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suggestions_status_check CHECK ((status = ANY (ARRAY['new'::text, 'read'::text]))),
    CONSTRAINT suggestions_target_type_check CHECK ((target_type = ANY (ARRAY['platform'::text, 'vendor'::text]))),
    CONSTRAINT suggestions_vendor_target_check CHECK ((((target_type = 'vendor'::text) AND (target_vendor_id IS NOT NULL)) OR ((target_type = 'platform'::text) AND (target_vendor_id IS NULL))))
);


--
-- Name: TABLE suggestions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.suggestions IS '[J] Site content & support - Feedback / suggestions sent by users (optionally anonymous) to admins or a vendor.';


--
-- Name: support_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    admin_reply text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT support_requests_message_check CHECK (((char_length(TRIM(BOTH FROM message)) >= 1) AND (char_length(TRIM(BOTH FROM message)) <= 4000))),
    CONSTRAINT support_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT support_requests_subject_check CHECK (((char_length(TRIM(BOTH FROM subject)) >= 1) AND (char_length(TRIM(BOTH FROM subject)) <= 140)))
);


--
-- Name: TABLE support_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.support_requests IS '[J] Site content & support - Support tickets with admin reply and attachments.';


--
-- Name: tts_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tts_usage (
    user_id uuid NOT NULL,
    day date DEFAULT CURRENT_DATE NOT NULL,
    chars integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE tts_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tts_usage IS '[I] Levi (AI assistant) & usage limits - Text-to-speech characters used per user per day.';


--
-- Name: user_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_presence (
    user_id uuid NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE user_presence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_presence IS '[A] Accounts, identity & security - Last-seen timestamp per user (touch_last_seen RPC, every ~45 s). Drives last seen in chats.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    phone text,
    email text,
    role public.user_role DEFAULT 'buyer'::public.user_role NOT NULL,
    city text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar_url text,
    address text,
    ai_data_consent boolean DEFAULT false NOT NULL,
    role_selected boolean DEFAULT true NOT NULL,
    suspended_at timestamp with time zone,
    suspended_reason text,
    suspended_by uuid,
    is_super_admin boolean DEFAULT false NOT NULL,
    has_password boolean DEFAULT false NOT NULL,
    otp_verified_at timestamp with time zone DEFAULT now() NOT NULL,
    legal_terms_version text,
    legal_terms_accepted_at timestamp with time zone,
    campus_id text
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS '[A] Accounts, identity & security - Application profile for every account (buyer, vendor, admin). Same id as auth.users. Holds role, contact info, suspension state, legal-terms acceptance, super-admin flag.';


--
-- Name: vendor_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    follower_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE vendor_follows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_follows IS '[B] Vendors & storefronts - Customer follows vendor.';


--
-- Name: vendor_monthly_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_monthly_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    listing_count integer NOT NULL,
    amount numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_reference text,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_monthly_charges_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text])))
);


--
-- Name: TABLE vendor_monthly_charges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_monthly_charges IS '[E] Commission & vendor billing - Monthly billing runs per vendor.';


--
-- Name: vendor_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price numeric NOT NULL,
    status public.product_status DEFAULT 'active'::public.product_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    billing_model text DEFAULT 'commission'::text NOT NULL,
    billing_status text DEFAULT 'active'::text NOT NULL,
    billing_paid_until timestamp with time zone,
    billing_reference text,
    CONSTRAINT vendor_packages_billing_model_check CHECK ((billing_model = ANY (ARRAY['commission'::text, 'monthly'::text]))),
    CONSTRAINT vendor_packages_billing_status_check CHECK ((billing_status = ANY (ARRAY['active'::text, 'pending_payment'::text, 'past_due'::text, 'cancelled'::text]))),
    CONSTRAINT vendor_packages_price_check CHECK ((price >= (0)::numeric))
);


--
-- Name: TABLE vendor_packages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_packages IS '[C] Catalogue, engagement & search - Bundles of products sold at one price.';


--
-- Name: vendor_profile_view_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_profile_view_events (
    id bigint NOT NULL,
    vendor_id uuid NOT NULL,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE vendor_profile_view_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_profile_view_events IS '[B] Vendors & storefronts - One row per storefront view; powers ''Views today'' and analytics.';


--
-- Name: vendor_profile_view_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.vendor_profile_view_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.vendor_profile_view_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vendor_recycle_bin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_recycle_bin (
    vendor_id uuid NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_by uuid,
    product_statuses jsonb DEFAULT '[]'::jsonb NOT NULL,
    package_statuses jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE vendor_recycle_bin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_recycle_bin IS '[B] Vendors & storefronts - Snapshot taken when an admin trashes a vendor so it can be restored exactly.';


--
-- Name: vendor_student_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_student_verification (
    vendor_id uuid NOT NULL,
    matric_number text,
    faculty text,
    department text,
    level text,
    id_card_url text,
    biodata_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    review_note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    selfie_url text,
    face_distance real,
    face_match text,
    face_liveness boolean,
    face_checked_at timestamp with time zone,
    ocr_matric_found boolean,
    ocr_name_found boolean,
    ocr_text text,
    ocr_checked_at timestamp with time zone,
    face_v integer DEFAULT 0 NOT NULL,
    matric_pending boolean DEFAULT false NOT NULL,
    CONSTRAINT vendor_student_verification_face_match_check CHECK ((face_match = ANY (ARRAY['strong'::text, 'possible'::text, 'mismatch'::text, 'unchecked'::text]))),
    CONSTRAINT vendor_student_verification_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: vendor_week_winners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_week_winners (
    week_start date NOT NULL,
    user_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    points integer NOT NULL,
    tx_count integer DEFAULT 0 NOT NULL,
    top3 jsonb DEFAULT '[]'::jsonb NOT NULL,
    reward_status text DEFAULT 'pending'::text NOT NULL,
    finalized_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE vendor_week_winners; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendor_week_winners IS '[H] Points, leaderboard & referrals - Snapshot of each finished week''s winners.';


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    business_name text NOT NULL,
    logo_url text,
    cover_image_url text,
    bio text,
    address text,
    city text,
    phone text,
    whatsapp_number text,
    verification_status public.vendor_verification_status DEFAULT 'pending'::public.vendor_verification_status NOT NULL,
    cac_number text,
    verification_docs text[] DEFAULT '{}'::text[] NOT NULL,
    delivery_radius_km numeric,
    opening_hours text,
    avg_rating numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    bank_code text,
    bank_name text,
    account_number text,
    account_name text,
    paystack_subaccount_code text,
    commission_pct numeric(5,2) DEFAULT 3.00 NOT NULL,
    delivery_fee numeric DEFAULT 0 NOT NULL,
    sector_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    transfer_recipient_code text,
    billing_model text DEFAULT 'commission'::text NOT NULL,
    paystack_authorization_code text,
    paystack_customer_code text,
    monthly_billing_status text DEFAULT 'inactive'::text NOT NULL,
    next_monthly_charge_at timestamp with time zone,
    review_count integer DEFAULT 0 NOT NULL,
    lat double precision,
    lng double precision,
    business_hours jsonb,
    allow_after_hours_messages boolean DEFAULT true NOT NULL,
    delivery_fee_mode text DEFAULT 'flat'::text NOT NULL,
    delivery_fee_per_km numeric DEFAULT 0 NOT NULL,
    previous_business_name text,
    name_changed_at timestamp with time zone,
    whatsapp_visible boolean DEFAULT false NOT NULL,
    cover_url text,
    commission_paused boolean DEFAULT false NOT NULL,
    commission_pause_reason text,
    deleted_previous_verification_status public.vendor_verification_status,
    deleted_previous_is_active boolean,
    admin_paused boolean DEFAULT false NOT NULL,
    profile_view_count integer DEFAULT 0 NOT NULL,
    referral_code text,
    campus_id text,
    request_pref text DEFAULT 'all'::text NOT NULL,
    operating_scope text DEFAULT 'one'::text NOT NULL,
    operating_campuses text[] DEFAULT '{}'::text[] NOT NULL,
    request_campus_scope text DEFAULT 'all'::text NOT NULL,
    student_verified boolean DEFAULT false NOT NULL,
    campus_setup_done boolean DEFAULT false NOT NULL,
    CONSTRAINT vendors_application_required_details_chk CHECK (((verification_status <> 'pending'::public.vendor_verification_status) OR (NULLIF(btrim(whatsapp_number), ''::text) IS NOT NULL))),
    CONSTRAINT vendors_billing_model_check CHECK ((billing_model = ANY (ARRAY['commission'::text, 'monthly'::text]))),
    CONSTRAINT vendors_delivery_fee_check CHECK ((delivery_fee >= (0)::numeric)),
    CONSTRAINT vendors_delivery_fee_mode_check CHECK ((delivery_fee_mode = ANY (ARRAY['flat'::text, 'distance'::text]))),
    CONSTRAINT vendors_monthly_billing_status_check CHECK ((monthly_billing_status = ANY (ARRAY['inactive'::text, 'active'::text, 'past_due'::text]))),
    CONSTRAINT vendors_operating_scope_chk CHECK ((operating_scope = ANY (ARRAY['one'::text, 'multiple'::text, 'all'::text]))),
    CONSTRAINT vendors_request_campus_scope_chk CHECK ((request_campus_scope = ANY (ARRAY['mine'::text, 'selected'::text, 'all'::text]))),
    CONSTRAINT vendors_request_pref_chk CHECK ((request_pref = ANY (ARRAY['all'::text, 'sector'::text, 'none'::text]))),
    CONSTRAINT vendors_whatsapp_required_check CHECK (((deleted_at IS NOT NULL) OR (NULLIF(btrim(whatsapp_number), ''::text) IS NOT NULL)))
);


--
-- Name: TABLE vendors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vendors IS '[B] Vendors & storefronts - One row per shop: business details, verification status, bank/Paystack codes, commission and monthly-billing state, delivery settings, location, ratings, soft-delete fields.';


--
-- Name: voice_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    caller_id uuid NOT NULL,
    callee_id uuid NOT NULL,
    status text DEFAULT 'ringing'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone,
    ended_at timestamp with time zone,
    rings integer DEFAULT 0 NOT NULL,
    CONSTRAINT voice_calls_status_check CHECK ((status = ANY (ARRAY['ringing'::text, 'active'::text, 'ended'::text, 'missed'::text, 'declined'::text])))
);


--
-- Name: TABLE voice_calls; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.voice_calls IS '[F] Messaging & calls - Call log and state (ringing > active > ended / declined / missed) plus ring counter.';


--
-- Name: account_appeals account_appeals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_appeals
    ADD CONSTRAINT account_appeals_pkey PRIMARY KEY (id);


--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);


--
-- Name: admin_login_otps admin_login_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_login_otps
    ADD CONSTRAINT admin_login_otps_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_share_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_share_token_key UNIQUE (share_token);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: app_presence app_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_presence
    ADD CONSTRAINT app_presence_pkey PRIMARY KEY (user_id);


--
-- Name: auth_activity_logs auth_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_activity_logs
    ADD CONSTRAINT auth_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_activity_logs auth_activity_logs_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_activity_logs
    ADD CONSTRAINT auth_activity_logs_session_id_key UNIQUE (session_id);


--
-- Name: blocked_users blocked_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_pkey PRIMARY KEY (blocker_id, blocked_id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: campus_submissions campus_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campus_submissions
    ADD CONSTRAINT campus_submissions_pkey PRIMARY KEY (name_norm);


--
-- Name: cart_items cart_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: chat_archive chat_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_archive
    ADD CONSTRAINT chat_archive_pkey PRIMARY KEY (id);


--
-- Name: chat_list_conversations chat_list_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_list_conversations
    ADD CONSTRAINT chat_list_conversations_pkey PRIMARY KEY (list_id, conversation_id);


--
-- Name: chat_lists chat_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_lists
    ADD CONSTRAINT chat_lists_pkey PRIMARY KEY (id);


--
-- Name: chat_usage chat_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_usage
    ADD CONSTRAINT chat_usage_pkey PRIMARY KEY (user_id, day);


--
-- Name: comment_reports comment_reports_kind_comment_id_reporter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_reports
    ADD CONSTRAINT comment_reports_kind_comment_id_reporter_id_key UNIQUE (kind, comment_id, reporter_id);


--
-- Name: comment_reports comment_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_reports
    ADD CONSTRAINT comment_reports_pkey PRIMARY KEY (id);


--
-- Name: commission_charges commission_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_charges
    ADD CONSTRAINT commission_charges_pkey PRIMARY KEY (id);


--
-- Name: commission_deadline_reminders commission_deadline_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_deadline_reminders
    ADD CONSTRAINT commission_deadline_reminders_pkey PRIMARY KEY (id);


--
-- Name: commission_deadline_reminders commission_deadline_reminders_vendor_id_reminder_code_perio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_deadline_reminders
    ADD CONSTRAINT commission_deadline_reminders_vendor_id_reminder_code_perio_key UNIQUE (vendor_id, reminder_code, period_key);


--
-- Name: commission_settlements commission_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_settlements
    ADD CONSTRAINT commission_settlements_pkey PRIMARY KEY (id);


--
-- Name: commission_settlements commission_settlements_provider_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_settlements
    ADD CONSTRAINT commission_settlements_provider_reference_key UNIQUE (provider_reference);


--
-- Name: conversations conversations_buyer_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_buyer_id_vendor_id_key UNIQUE (buyer_id, vendor_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: equipment_requests equipment_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_requests
    ADD CONSTRAINT equipment_requests_pkey PRIMARY KEY (id);


--
-- Name: favorites favorites_buyer_id_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_buyer_id_product_id_key UNIQUE (buyer_id, product_id);


--
-- Name: favorites favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_pkey PRIMARY KEY (id);


--
-- Name: homepage_carousel_slides homepage_carousel_slides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homepage_carousel_slides
    ADD CONSTRAINT homepage_carousel_slides_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: listing_billing_reminders listing_billing_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_billing_reminders
    ADD CONSTRAINT listing_billing_reminders_pkey PRIMARY KEY (kind, listing_id, reminder_code, period_key);


--
-- Name: listing_drafts listing_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_drafts
    ADD CONSTRAINT listing_drafts_pkey PRIMARY KEY (id);


--
-- Name: listing_payment_intents listing_payment_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_payment_intents
    ADD CONSTRAINT listing_payment_intents_pkey PRIMARY KEY (id);


--
-- Name: listing_payment_intents listing_payment_intents_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_payment_intents
    ADD CONSTRAINT listing_payment_intents_reference_key UNIQUE (reference);


--
-- Name: message_pins message_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_pins
    ADD CONSTRAINT message_pins_pkey PRIMARY KEY (id);


--
-- Name: message_pins message_pins_user_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_pins
    ADD CONSTRAINT message_pins_user_id_message_id_key UNIQUE (user_id, message_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: monthly_listing_submissions monthly_listing_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_listing_submissions
    ADD CONSTRAINT monthly_listing_submissions_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: order_notes order_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes
    ADD CONSTRAINT order_notes_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: package_comment_likes package_comment_likes_comment_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comment_likes
    ADD CONSTRAINT package_comment_likes_comment_id_user_id_key UNIQUE (comment_id, user_id);


--
-- Name: package_comment_likes package_comment_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comment_likes
    ADD CONSTRAINT package_comment_likes_pkey PRIMARY KEY (id);


--
-- Name: package_comments package_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comments
    ADD CONSTRAINT package_comments_pkey PRIMARY KEY (id);


--
-- Name: package_engagement_settings package_engagement_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_engagement_settings
    ADD CONSTRAINT package_engagement_settings_pkey PRIMARY KEY (package_id);


--
-- Name: package_favorites package_favorites_buyer_id_package_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_favorites
    ADD CONSTRAINT package_favorites_buyer_id_package_id_key UNIQUE (buyer_id, package_id);


--
-- Name: package_favorites package_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_favorites
    ADD CONSTRAINT package_favorites_pkey PRIMARY KEY (id);


--
-- Name: package_items package_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_items
    ADD CONSTRAINT package_items_pkey PRIMARY KEY (id);


--
-- Name: password_reset_requests password_reset_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_requests
    ADD CONSTRAINT password_reset_requests_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: points_ledger points_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_pkey PRIMARY KEY (id);


--
-- Name: points_ledger points_ledger_user_id_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_user_id_event_key_key UNIQUE (user_id, event_key);


--
-- Name: points_rules points_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_rules
    ADD CONSTRAINT points_rules_pkey PRIMARY KEY (kind);


--
-- Name: points_skips points_skips_kind_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_skips
    ADD CONSTRAINT points_skips_kind_ref_key UNIQUE (kind, ref);


--
-- Name: points_skips points_skips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_skips
    ADD CONSTRAINT points_skips_pkey PRIMARY KEY (id);


--
-- Name: points_weekly points_weekly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_weekly
    ADD CONSTRAINT points_weekly_pkey PRIMARY KEY (user_id, week_start);


--
-- Name: product_comment_likes product_comment_likes_comment_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comment_likes
    ADD CONSTRAINT product_comment_likes_comment_id_user_id_key UNIQUE (comment_id, user_id);


--
-- Name: product_comment_likes product_comment_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comment_likes
    ADD CONSTRAINT product_comment_likes_pkey PRIMARY KEY (id);


--
-- Name: product_comments product_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comments
    ADD CONSTRAINT product_comments_pkey PRIMARY KEY (id);


--
-- Name: product_engagement_settings product_engagement_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_engagement_settings
    ADD CONSTRAINT product_engagement_settings_pkey PRIMARY KEY (product_id);


--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (referred_user_id);


--
-- Name: request_offers request_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_offers
    ADD CONSTRAINT request_offers_pkey PRIMARY KEY (id);


--
-- Name: request_offers request_offers_request_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_offers
    ADD CONSTRAINT request_offers_request_id_vendor_id_key UNIQUE (request_id, vendor_id);


--
-- Name: reviews reviews_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_order_id_key UNIQUE (order_id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: search_synonyms search_synonyms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_synonyms
    ADD CONSTRAINT search_synonyms_pkey PRIMARY KEY (term, synonym);


--
-- Name: sectors sectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sectors
    ADD CONSTRAINT sectors_pkey PRIMARY KEY (id);


--
-- Name: sectors sectors_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sectors
    ADD CONSTRAINT sectors_slug_key UNIQUE (slug);


--
-- Name: service_offers service_offers_order_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_order_unique UNIQUE (order_id);


--
-- Name: service_offers service_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_pkey PRIMARY KEY (id);


--
-- Name: suggestions suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestions
    ADD CONSTRAINT suggestions_pkey PRIMARY KEY (id);


--
-- Name: support_requests support_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_requests
    ADD CONSTRAINT support_requests_pkey PRIMARY KEY (id);


--
-- Name: tts_usage tts_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_usage
    ADD CONSTRAINT tts_usage_pkey PRIMARY KEY (user_id, day);


--
-- Name: user_presence user_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vendor_follow_preferences vendor_follow_preferences_follower_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follow_preferences
    ADD CONSTRAINT vendor_follow_preferences_follower_id_vendor_id_key UNIQUE (follower_id, vendor_id);


--
-- Name: vendor_follow_preferences vendor_follow_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follow_preferences
    ADD CONSTRAINT vendor_follow_preferences_pkey PRIMARY KEY (id);


--
-- Name: vendor_follows vendor_follows_follower_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follows
    ADD CONSTRAINT vendor_follows_follower_id_vendor_id_key UNIQUE (follower_id, vendor_id);


--
-- Name: vendor_follows vendor_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follows
    ADD CONSTRAINT vendor_follows_pkey PRIMARY KEY (id);


--
-- Name: vendor_monthly_charges vendor_monthly_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_monthly_charges
    ADD CONSTRAINT vendor_monthly_charges_pkey PRIMARY KEY (id);


--
-- Name: vendor_packages vendor_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_packages
    ADD CONSTRAINT vendor_packages_pkey PRIMARY KEY (id);


--
-- Name: vendor_profile_view_events vendor_profile_view_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_profile_view_events
    ADD CONSTRAINT vendor_profile_view_events_pkey PRIMARY KEY (id);


--
-- Name: vendor_recycle_bin vendor_recycle_bin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_recycle_bin
    ADD CONSTRAINT vendor_recycle_bin_pkey PRIMARY KEY (vendor_id);


--
-- Name: vendor_student_verification vendor_student_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_student_verification
    ADD CONSTRAINT vendor_student_verification_pkey PRIMARY KEY (vendor_id);


--
-- Name: vendor_week_winners vendor_week_winners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_week_winners
    ADD CONSTRAINT vendor_week_winners_pkey PRIMARY KEY (week_start);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);


--
-- Name: vendors vendors_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_user_id_key UNIQUE (user_id);


--
-- Name: voice_calls voice_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_calls
    ADD CONSTRAINT voice_calls_pkey PRIMARY KEY (id);


--
-- Name: admin_login_otps_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_login_otps_user_idx ON public.admin_login_otps USING btree (user_id, created_at DESC);


--
-- Name: ai_conversations_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_user_id_idx ON public.ai_conversations USING btree (user_id, updated_at DESC);


--
-- Name: ai_messages_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_conversation_id_idx ON public.ai_messages USING btree (conversation_id, created_at);


--
-- Name: auth_activity_logs_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_activity_logs_occurred_at_idx ON public.auth_activity_logs USING btree (occurred_at DESC);


--
-- Name: auth_activity_logs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_activity_logs_user_id_idx ON public.auth_activity_logs USING btree (user_id, occurred_at DESC);


--
-- Name: bookings_order_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_order_item_id_idx ON public.bookings USING btree (order_item_id);


--
-- Name: bookings_product_range_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_product_range_idx ON public.bookings USING gist (product_id, date_range);


--
-- Name: cart_items_buyer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cart_items_buyer_idx ON public.cart_items USING btree (buyer_id);


--
-- Name: cart_items_buyer_product_no_variant_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cart_items_buyer_product_no_variant_unique ON public.cart_items USING btree (buyer_id, product_id) WHERE (variant_id IS NULL);


--
-- Name: cart_items_buyer_product_variant_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cart_items_buyer_product_variant_unique ON public.cart_items USING btree (buyer_id, product_id, variant_id) WHERE (variant_id IS NOT NULL);


--
-- Name: categories_parent_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_parent_category_id_idx ON public.categories USING btree (parent_category_id);


--
-- Name: chat_lists_user_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_lists_user_name_uniq ON public.chat_lists USING btree (user_id, lower(name));


--
-- Name: disputes_order_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX disputes_order_id_idx ON public.disputes USING btree (order_id);


--
-- Name: homepage_carousel_slides_active_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX homepage_carousel_slides_active_order_idx ON public.homepage_carousel_slides USING btree (is_active, sort_order);


--
-- Name: idx_categories_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_name_trgm ON public.categories USING gin (name public.gin_trgm_ops);


--
-- Name: idx_orders_payment_unresolved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_payment_unresolved_at ON public.orders USING btree (payment_unresolved_at) WHERE (payment_unresolved_at IS NOT NULL);


--
-- Name: idx_orders_payment_unresolved_escalation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_payment_unresolved_escalation ON public.orders USING btree (payment_unresolved_at) WHERE (status = 'payment_unresolved'::public.order_status);


--
-- Name: idx_products_description_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_description_trgm ON public.products USING gin (description public.gin_trgm_ops);


--
-- Name: idx_products_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_name_trgm ON public.products USING gin (name public.gin_trgm_ops);


--
-- Name: idx_products_vendor_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_vendor_created_at ON public.products USING btree (vendor_id, created_at DESC);


--
-- Name: idx_vendor_packages_description_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_packages_description_trgm ON public.vendor_packages USING gin (description public.gin_trgm_ops);


--
-- Name: idx_vendor_packages_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_packages_name_trgm ON public.vendor_packages USING gin (name public.gin_trgm_ops);


--
-- Name: idx_vendors_business_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendors_business_name_trgm ON public.vendors USING gin (business_name public.gin_trgm_ops);


--
-- Name: idx_vendors_sector_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendors_sector_id ON public.vendors USING btree (sector_id);


--
-- Name: inventory_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_created_at_idx ON public.inventory USING btree (created_at DESC);


--
-- Name: inventory_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_type_idx ON public.inventory USING btree (type);


--
-- Name: listing_billing_reminders_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_billing_reminders_sent_idx ON public.listing_billing_reminders USING btree (sent_at DESC);


--
-- Name: listing_drafts_vendor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_drafts_vendor_created_idx ON public.listing_drafts USING btree (vendor_id, created_at DESC);


--
-- Name: listing_payment_intents_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_payment_intents_user_idx ON public.listing_payment_intents USING btree (user_id, created_at DESC);


--
-- Name: listing_payment_intents_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_payment_intents_vendor_idx ON public.listing_payment_intents USING btree (vendor_id, created_at DESC);


--
-- Name: listing_payment_intents_vendor_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_payment_intents_vendor_pending_idx ON public.listing_payment_intents USING btree (vendor_id, status, created_at DESC);


--
-- Name: message_pins_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_pins_expires_at_idx ON public.message_pins USING btree (expires_at);


--
-- Name: message_pins_user_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_pins_user_conversation_idx ON public.message_pins USING btree (user_id, conversation_id, pinned_at DESC);


--
-- Name: messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_conversation_idx ON public.messages USING btree (conversation_id, created_at);


--
-- Name: messages_reply_to_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_reply_to_id_idx ON public.messages USING btree (reply_to_id);


--
-- Name: monthly_listing_submissions_listing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monthly_listing_submissions_listing_idx ON public.monthly_listing_submissions USING btree (listing_id, submitted_at DESC);


--
-- Name: monthly_listing_submissions_one_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monthly_listing_submissions_one_pending_idx ON public.monthly_listing_submissions USING btree (listing_id) WHERE (status = 'pending'::text);


--
-- Name: monthly_listing_submissions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monthly_listing_submissions_status_idx ON public.monthly_listing_submissions USING btree (status, submitted_at DESC);


--
-- Name: notifications_user_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_unread_idx ON public.notifications USING btree (user_id, read, created_at DESC);


--
-- Name: notifications_vendor_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_vendor_group_idx ON public.notifications USING btree (user_id, vendor_id, notification_category, group_key, created_at DESC);


--
-- Name: order_items_order_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_order_id_idx ON public.order_items USING btree (order_id);


--
-- Name: order_items_product_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_product_id_idx ON public.order_items USING btree (product_id);


--
-- Name: order_items_variant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_variant_id_idx ON public.order_items USING btree (variant_id);


--
-- Name: order_notes_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_notes_order_idx ON public.order_notes USING btree (order_id, created_at);


--
-- Name: orders_buyer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_buyer_id_idx ON public.orders USING btree (buyer_id);


--
-- Name: orders_vendor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_vendor_id_idx ON public.orders USING btree (vendor_id);


--
-- Name: package_comment_likes_comment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_comment_likes_comment_id_idx ON public.package_comment_likes USING btree (comment_id);


--
-- Name: package_comments_package_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_comments_package_id_created_at_idx ON public.package_comments USING btree (package_id, created_at DESC);


--
-- Name: package_comments_parent_comment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_comments_parent_comment_id_idx ON public.package_comments USING btree (parent_comment_id);


--
-- Name: package_engagement_settings_vendor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_engagement_settings_vendor_id_idx ON public.package_engagement_settings USING btree (vendor_id);


--
-- Name: package_favorites_buyer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_favorites_buyer_created_idx ON public.package_favorites USING btree (buyer_id, created_at DESC);


--
-- Name: package_favorites_package_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_favorites_package_idx ON public.package_favorites USING btree (package_id);


--
-- Name: package_items_package_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_items_package_id_idx ON public.package_items USING btree (package_id);


--
-- Name: package_items_product_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX package_items_product_id_idx ON public.package_items USING btree (product_id);


--
-- Name: password_reset_requests_email_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_requests_email_created_idx ON public.password_reset_requests USING btree (lower(email), created_at DESC);


--
-- Name: password_reset_requests_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_requests_status_created_idx ON public.password_reset_requests USING btree (status, created_at DESC);


--
-- Name: payments_one_paid_fee_per_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payments_one_paid_fee_per_order_idx ON public.payments USING btree (order_id, payment_type) WHERE ((status = 'paid'::public.payment_status) AND (payment_type = ANY (ARRAY['sale_price'::public.payment_type, 'rental_fee'::public.payment_type])));


--
-- Name: payments_order_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_order_id_idx ON public.payments USING btree (order_id);


--
-- Name: points_ledger_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_ledger_kind_idx ON public.points_ledger USING btree (user_id, kind, week_start);


--
-- Name: points_ledger_user_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_ledger_user_time_idx ON public.points_ledger USING btree (user_id, created_at DESC);


--
-- Name: points_ledger_week_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_ledger_week_idx ON public.points_ledger USING btree (week_start);


--
-- Name: points_weekly_week_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_weekly_week_idx ON public.points_weekly USING btree (week_start, points DESC);


--
-- Name: product_comment_likes_comment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_comment_likes_comment_idx ON public.product_comment_likes USING btree (comment_id);


--
-- Name: product_comments_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_comments_parent_idx ON public.product_comments USING btree (parent_comment_id);


--
-- Name: product_comments_product_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_comments_product_created_idx ON public.product_comments USING btree (product_id, created_at DESC);


--
-- Name: product_engagement_settings_vendor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_engagement_settings_vendor_id_idx ON public.product_engagement_settings USING btree (vendor_id);


--
-- Name: product_variants_product_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_variants_product_id_idx ON public.product_variants USING btree (product_id, sort_order, created_at);


--
-- Name: products_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_category_id_idx ON public.products USING btree (category_id);


--
-- Name: products_vendor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_vendor_id_idx ON public.products USING btree (vendor_id);


--
-- Name: products_vendor_status_billing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_vendor_status_billing_idx ON public.products USING btree (vendor_id, status, billing_model, billing_paid_until);


--
-- Name: referrals_referrer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referrals_referrer_idx ON public.referrals USING btree (referrer_user_id, created_at DESC);


--
-- Name: reviews_buyer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_buyer_id_idx ON public.reviews USING btree (buyer_id);


--
-- Name: reviews_vendor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_vendor_id_idx ON public.reviews USING btree (vendor_id);


--
-- Name: service_offers_buyer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX service_offers_buyer_idx ON public.service_offers USING btree (buyer_id, updated_at DESC);


--
-- Name: service_offers_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX service_offers_expiry_idx ON public.service_offers USING btree (status, expires_at);


--
-- Name: service_offers_listing_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX service_offers_listing_status_idx ON public.service_offers USING btree (listing_id, status, updated_at DESC);


--
-- Name: service_offers_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX service_offers_vendor_idx ON public.service_offers USING btree (vendor_id, updated_at DESC);


--
-- Name: support_requests_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_requests_status_created_idx ON public.support_requests USING btree (status, created_at DESC);


--
-- Name: support_requests_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_requests_user_created_idx ON public.support_requests USING btree (user_id, created_at DESC);


--
-- Name: vendor_follow_preferences_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_follow_preferences_vendor_idx ON public.vendor_follow_preferences USING btree (vendor_id, follower_id);


--
-- Name: vendor_follows_follower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_follows_follower_idx ON public.vendor_follows USING btree (follower_id, created_at DESC);


--
-- Name: vendor_follows_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_follows_vendor_idx ON public.vendor_follows USING btree (vendor_id, created_at DESC);


--
-- Name: vendor_monthly_charges_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_monthly_charges_vendor_idx ON public.vendor_monthly_charges USING btree (vendor_id, created_at DESC);


--
-- Name: vendor_packages_description_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_packages_description_trgm_idx ON public.vendor_packages USING gin (description public.gin_trgm_ops);


--
-- Name: vendor_packages_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_packages_name_trgm_idx ON public.vendor_packages USING gin (name public.gin_trgm_ops);


--
-- Name: vendor_packages_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_packages_status_created_idx ON public.vendor_packages USING btree (status, created_at DESC);


--
-- Name: vendor_packages_vendor_status_billing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_packages_vendor_status_billing_idx ON public.vendor_packages USING btree (vendor_id, status, billing_model, billing_paid_until);


--
-- Name: vendor_packages_vendor_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_packages_vendor_status_created_idx ON public.vendor_packages USING btree (vendor_id, status, created_at DESC);


--
-- Name: vendor_profile_view_events_vendor_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_profile_view_events_vendor_time_idx ON public.vendor_profile_view_events USING btree (vendor_id, viewed_at DESC);


--
-- Name: vendor_recycle_bin_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendor_recycle_bin_deleted_at_idx ON public.vendor_recycle_bin USING btree (deleted_at DESC);


--
-- Name: vendors_campus_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vendors_campus_id_idx ON public.vendors USING btree (campus_id) WHERE (campus_id IS NOT NULL);


--
-- Name: vendors_referral_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vendors_referral_code_key ON public.vendors USING btree (referral_code);


--
-- Name: voice_calls_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_calls_conv_idx ON public.voice_calls USING btree (conversation_id, created_at DESC);


--
-- Name: favorites favorites_notify_product_wishlist; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER favorites_notify_product_wishlist AFTER INSERT ON public.favorites FOR EACH ROW EXECUTE FUNCTION public.notify_product_favorite_event();


--
-- Name: listing_drafts listing_drafts_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_drafts_touch_updated_at BEFORE UPDATE ON public.listing_drafts FOR EACH ROW EXECUTE FUNCTION public.listing_drafts_touch_updated_at();


--
-- Name: package_comments package_comments_notify_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER package_comments_notify_event AFTER INSERT ON public.package_comments FOR EACH ROW EXECUTE FUNCTION public.notify_package_comment_event();


--
-- Name: package_comments package_comments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER package_comments_updated_at BEFORE UPDATE ON public.package_comments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();


--
-- Name: package_engagement_settings package_engagement_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER package_engagement_settings_updated_at BEFORE UPDATE ON public.package_engagement_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();


--
-- Name: product_comment_likes product_comment_likes_notify_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_comment_likes_notify_event AFTER INSERT ON public.product_comment_likes FOR EACH ROW EXECUTE FUNCTION public.notify_product_comment_like_event();


--
-- Name: product_comments product_comments_notify_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_comments_notify_event AFTER INSERT ON public.product_comments FOR EACH ROW EXECUTE FUNCTION public.notify_product_comment_event();


--
-- Name: product_comments product_comments_snapshot_author; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_comments_snapshot_author BEFORE INSERT ON public.product_comments FOR EACH ROW EXECUTE FUNCTION public.snapshot_product_comment_author();


--
-- Name: product_engagement_settings product_engagement_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_engagement_settings_updated_at BEFORE UPDATE ON public.product_engagement_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();


--
-- Name: vendors trg_enforce_vendor_onboarding_requirements; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_vendor_onboarding_requirements BEFORE INSERT OR UPDATE OF whatsapp_number, bank_name, bank_code, account_number, account_name, verification_status ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.enforce_vendor_onboarding_requirements();


--
-- Name: orders trg_guard_unverified_order_completion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_unverified_order_completion BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_unverified_order_completion();


--
-- Name: homepage_carousel_slides trg_homepage_carousel_slides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_homepage_carousel_slides_updated_at BEFORE UPDATE ON public.homepage_carousel_slides FOR EACH ROW EXECUTE FUNCTION public.set_homepage_carousel_slides_updated_at();


--
-- Name: orders trg_levromart_stamp_order_status_clock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_levromart_stamp_order_status_clock BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.levromart_stamp_order_status();


--
-- Name: payments trg_mark_order_payment_unresolved_from_claim; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mark_order_payment_unresolved_from_claim AFTER INSERT OR UPDATE OF status, provider_reference ON public.payments FOR EACH ROW EXECUTE FUNCTION public.mark_order_payment_unresolved_from_claim();


--
-- Name: message_pins trg_message_pins_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_message_pins_limit BEFORE INSERT ON public.message_pins FOR EACH ROW EXECUTE FUNCTION public.enforce_message_pin_limit();


--
-- Name: orders trg_normalize_order_payment_terms; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_normalize_order_payment_terms BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.normalize_order_payment_terms();


--
-- Name: admin_actions trg_notify_admins_on_action; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_admins_on_action AFTER INSERT ON public.admin_actions FOR EACH ROW EXECUTE FUNCTION public.notify_admins_on_action();


--
-- Name: notifications trg_notify_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_email AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.notify_email_on_notification();


--
-- Name: products trg_notify_low_stock_products; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_low_stock_products AFTER UPDATE OF quantity_available ON public.products FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_low_stock();


--
-- Name: product_variants trg_notify_low_stock_variants; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_low_stock_variants AFTER UPDATE OF quantity_available ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_low_stock();


--
-- Name: disputes trg_notify_new_dispute; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_dispute AFTER INSERT ON public.disputes FOR EACH ROW EXECUTE FUNCTION public.notify_new_dispute();


--
-- Name: messages trg_notify_new_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.notify_new_message();


--
-- Name: request_offers trg_notify_new_offer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_offer AFTER INSERT ON public.request_offers FOR EACH ROW EXECUTE FUNCTION public.notify_new_offer();


--
-- Name: orders trg_notify_new_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_notify_new_order AFTER INSERT ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notify_new_order();


--
-- Name: equipment_requests trg_notify_new_request; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_request AFTER INSERT ON public.equipment_requests FOR EACH ROW EXECUTE FUNCTION public.notify_new_request();


--
-- Name: reviews trg_notify_new_review; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_review AFTER INSERT ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.notify_new_review();


--
-- Name: users trg_notify_new_user_signup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_user_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.notify_new_user_signup();


--
-- Name: vendors trg_notify_new_vendor_application; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_new_vendor_application AFTER INSERT ON public.vendors FOR EACH ROW WHEN ((new.deleted_at IS NULL)) EXECUTE FUNCTION public.notify_new_vendor_application();


--
-- Name: request_offers trg_notify_offer_accepted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_offer_accepted AFTER UPDATE ON public.request_offers FOR EACH ROW EXECUTE FUNCTION public.notify_offer_accepted();


--
-- Name: orders trg_notify_order_status_changed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_order_status_changed AFTER UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.notify_order_status_changed();


--
-- Name: payments trg_notify_payment_paid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_payment_paid AFTER INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.notify_payment_paid();


--
-- Name: equipment_requests trg_notify_request_cancelled; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_request_cancelled AFTER UPDATE ON public.equipment_requests FOR EACH ROW EXECUTE FUNCTION public.notify_request_cancelled();


--
-- Name: vendors trg_notify_vendor_payout_setup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_vendor_payout_setup AFTER UPDATE OF paystack_subaccount_code ON public.vendors FOR EACH ROW WHEN (((old.paystack_subaccount_code IS NULL) AND (new.paystack_subaccount_code IS NOT NULL))) EXECUTE FUNCTION public.notify_vendor_payout_setup();


--
-- Name: orders trg_orders_require_buyer_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_orders_require_buyer_phone BEFORE INSERT OR UPDATE OF buyer_id ON public.orders FOR EACH ROW EXECUTE FUNCTION public.enforce_buyer_phone_on_order();


--
-- Name: vendor_packages trg_packages_remove_monthly_submission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_packages_remove_monthly_submission AFTER DELETE OR UPDATE OF status ON public.vendor_packages FOR EACH ROW EXECUTE FUNCTION public.levro_remove_monthly_submission_on_listing_removal();


--
-- Name: vendor_follows trg_points_follow; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_follow AFTER INSERT ON public.vendor_follows FOR EACH ROW EXECUTE FUNCTION public.trg_points_follow();


--
-- Name: products trg_points_listing; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_listing AFTER INSERT OR UPDATE OF status, admin_deleted_at ON public.products FOR EACH ROW EXECUTE FUNCTION public.trg_points_listing();


--
-- Name: vendor_packages trg_points_listing; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_listing AFTER INSERT OR UPDATE OF status ON public.vendor_packages FOR EACH ROW EXECUTE FUNCTION public.trg_points_listing();


--
-- Name: orders trg_points_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_order AFTER UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.trg_points_order();


--
-- Name: points_weekly trg_points_rank_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_rank_notify AFTER INSERT OR UPDATE OF points ON public.points_weekly FOR EACH ROW EXECUTE FUNCTION public.trg_points_rank_notify();


--
-- Name: reviews trg_points_review; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_review AFTER INSERT OR DELETE OR UPDATE OF rating ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.trg_points_review();


--
-- Name: vendors trg_points_vendor; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_points_vendor AFTER INSERT OR UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.trg_points_vendor();


--
-- Name: users trg_prevent_self_role_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_self_role_change BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.prevent_self_role_change();


--
-- Name: orders trg_prevent_unverified_order_completion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_unverified_order_completion BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.prevent_unverified_order_completion();


--
-- Name: vendors trg_prevent_vendor_activation_with_owed_commission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_vendor_activation_with_owed_commission BEFORE UPDATE OF is_active, commission_paused ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.prevent_vendor_activation_with_owed_commission();


--
-- Name: cart_items trg_prevent_vendor_self_cart_item; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_vendor_self_cart_item BEFORE INSERT OR UPDATE OF buyer_id, product_id ON public.cart_items FOR EACH ROW EXECUTE FUNCTION public.prevent_vendor_self_cart_item();


--
-- Name: orders trg_prevent_vendor_self_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_vendor_self_order BEFORE INSERT OR UPDATE OF buyer_id, vendor_id ON public.orders FOR EACH ROW EXECUTE FUNCTION public.prevent_vendor_self_order();


--
-- Name: product_variants trg_product_variants_notify_followers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_variants_notify_followers AFTER INSERT OR UPDATE OF name, photo_url, sale_price, discount_price ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.notify_variant_followers_batch_aware();


--
-- Name: products trg_products_default_category; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_default_category BEFORE INSERT OR UPDATE OF category_id ON public.products FOR EACH ROW WHEN ((new.category_id IS NULL)) EXECUTE FUNCTION public.products_default_category();


--
-- Name: products trg_products_notify_followers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_notify_followers AFTER INSERT OR UPDATE OF status, is_service, name, sale_price, rental_rate, rental_rate_unit, discount_price, description, photos, condition, listing_type, quantity_available, quantity_total ON public.products FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_followers_event();


--
-- Name: products trg_products_remove_monthly_submission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_remove_monthly_submission AFTER DELETE OR UPDATE OF status ON public.products FOR EACH ROW EXECUTE FUNCTION public.levro_remove_monthly_submission_on_listing_removal();


--
-- Name: orders trg_record_order_completion_commission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_record_order_completion_commission AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN (((new.status = 'completed'::public.order_status) AND (old.status IS DISTINCT FROM 'completed'::public.order_status))) EXECUTE FUNCTION public.record_order_completion_commission();


--
-- Name: orders trg_require_buyer_phone_for_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_require_buyer_phone_for_order BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.require_buyer_phone_for_order();


--
-- Name: orders trg_restore_product_stock_on_cancelled_sale; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_restore_product_stock_on_cancelled_sale AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN (((new.status = 'cancelled'::public.order_status) AND (old.status IS DISTINCT FROM 'cancelled'::public.order_status) AND (new.order_type = 'sale'::public.order_type))) EXECUTE FUNCTION public.restore_product_stock_on_cancelled_sale();


--
-- Name: equipment_requests trg_set_request_buyer_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_set_request_buyer_snapshot BEFORE INSERT ON public.equipment_requests FOR EACH ROW EXECUTE FUNCTION public.set_request_buyer_snapshot();


--
-- Name: reviews trg_set_review_buyer_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_set_review_buyer_snapshot BEFORE INSERT ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.set_review_buyer_snapshot();


--
-- Name: order_items trg_sync_order_payment_deposit_percent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_order_payment_deposit_percent AFTER INSERT OR UPDATE OF product_id ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.sync_order_payment_deposit_percent_from_item();


--
-- Name: vendors trg_sync_user_role_from_vendor; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_user_role_from_vendor AFTER INSERT OR UPDATE OF verification_status, is_active, deleted_at ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.sync_role_from_vendor_row();


--
-- Name: users trg_sync_vendor_avatar_from_user; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_vendor_avatar_from_user AFTER INSERT OR UPDATE OF avatar_url ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_avatar_from_user();


--
-- Name: users trg_sync_vendor_profile_avatar; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_vendor_profile_avatar AFTER INSERT OR UPDATE OF avatar_url ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_profile_avatar();


--
-- Name: reviews trg_sync_vendor_review_stats; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_vendor_review_stats AFTER INSERT OR DELETE OR UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_review_stats();


--
-- Name: ai_messages trg_touch_ai_conversation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_ai_conversation AFTER INSERT ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.touch_ai_conversation();


--
-- Name: service_offers trg_touch_service_offer_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_service_offer_updated_at BEFORE UPDATE ON public.service_offers FOR EACH ROW EXECUTE FUNCTION public.touch_service_offer_updated_at();


--
-- Name: support_requests trg_touch_support_request_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_support_request_updated_at BEFORE UPDATE ON public.support_requests FOR EACH ROW EXECUTE FUNCTION public.touch_support_request_updated_at();


--
-- Name: users trg_user_profile_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_profile_updated AFTER UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.on_user_profile_updated();


--
-- Name: vendors trg_validate_vendor_phone_numbers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_vendor_phone_numbers BEFORE INSERT OR UPDATE OF phone, whatsapp_number ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.validate_vendor_phone_numbers();


--
-- Name: vendor_packages trg_vendor_packages_notify_followers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vendor_packages_notify_followers AFTER INSERT OR UPDATE OF status, name, price, description, photos ON public.vendor_packages FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_followers_event();


--
-- Name: vendors trg_vendor_profile_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vendor_profile_updated BEFORE UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.on_vendor_profile_updated();


--
-- Name: vendors trg_vendor_referral_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vendor_referral_code BEFORE INSERT OR UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.trg_vendor_referral_code();


--
-- Name: users users_campus_to_vendor_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_campus_to_vendor_trg AFTER UPDATE OF campus_id ON public.users FOR EACH ROW EXECUTE FUNCTION public.users_campus_to_vendor();


--
-- Name: vendor_follows vendor_follow_notify_vendor_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vendor_follow_notify_vendor_trigger AFTER INSERT ON public.vendor_follows FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_on_follow();


--
-- Name: vendors vendors_default_campus_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vendors_default_campus_trg BEFORE INSERT ON public.vendors FOR EACH ROW EXECUTE FUNCTION public.vendors_default_campus();


--
-- Name: account_appeals account_appeals_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_appeals
    ADD CONSTRAINT account_appeals_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: account_appeals account_appeals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_appeals
    ADD CONSTRAINT account_appeals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: admin_actions admin_actions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id);


--
-- Name: admin_login_otps admin_login_otps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_login_otps
    ADD CONSTRAINT admin_login_otps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: ai_conversations ai_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;


--
-- Name: auth_activity_logs auth_activity_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_activity_logs
    ADD CONSTRAINT auth_activity_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: blocked_users blocked_users_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: blocked_users blocked_users_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;


--
-- Name: categories categories_parent_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_category_id_fkey FOREIGN KEY (parent_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: categories categories_sector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_sector_id_fkey FOREIGN KEY (sector_id) REFERENCES public.sectors(id);


--
-- Name: chat_list_conversations chat_list_conversations_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_list_conversations
    ADD CONSTRAINT chat_list_conversations_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: chat_list_conversations chat_list_conversations_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_list_conversations
    ADD CONSTRAINT chat_list_conversations_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.chat_lists(id) ON DELETE CASCADE;


--
-- Name: chat_lists chat_lists_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_lists
    ADD CONSTRAINT chat_lists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_usage chat_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_usage
    ADD CONSTRAINT chat_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: commission_charges commission_charges_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_charges
    ADD CONSTRAINT commission_charges_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: commission_charges commission_charges_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_charges
    ADD CONSTRAINT commission_charges_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: commission_charges commission_charges_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_charges
    ADD CONSTRAINT commission_charges_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: commission_deadline_reminders commission_deadline_reminders_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_deadline_reminders
    ADD CONSTRAINT commission_deadline_reminders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: commission_settlements commission_settlements_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_settlements
    ADD CONSTRAINT commission_settlements_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id);


--
-- Name: conversations conversations_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: disputes disputes_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: equipment_requests equipment_requests_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_requests
    ADD CONSTRAINT equipment_requests_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: equipment_requests equipment_requests_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_requests
    ADD CONSTRAINT equipment_requests_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: favorites favorites_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: favorites favorites_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: homepage_carousel_slides homepage_carousel_slides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homepage_carousel_slides
    ADD CONSTRAINT homepage_carousel_slides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: inventory inventory_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id);


--
-- Name: listing_drafts listing_drafts_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_drafts
    ADD CONSTRAINT listing_drafts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: listing_payment_intents listing_payment_intents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_payment_intents
    ADD CONSTRAINT listing_payment_intents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: listing_payment_intents listing_payment_intents_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_payment_intents
    ADD CONSTRAINT listing_payment_intents_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_pins
    ADD CONSTRAINT message_pins_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_pins
    ADD CONSTRAINT message_pins_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_pins
    ADD CONSTRAINT message_pins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: monthly_listing_submissions monthly_listing_submissions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_listing_submissions
    ADD CONSTRAINT monthly_listing_submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: monthly_listing_submissions monthly_listing_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_listing_submissions
    ADD CONSTRAINT monthly_listing_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: monthly_listing_submissions monthly_listing_submissions_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_listing_submissions
    ADD CONSTRAINT monthly_listing_submissions_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: order_items order_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;


--
-- Name: order_notes order_notes_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes
    ADD CONSTRAINT order_notes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_notes order_notes_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes
    ADD CONSTRAINT order_notes_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: orders orders_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id);


--
-- Name: orders orders_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.vendor_packages(id);


--
-- Name: orders orders_service_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_service_offer_id_fkey FOREIGN KEY (service_offer_id) REFERENCES public.service_offers(id) ON DELETE SET NULL;


--
-- Name: orders orders_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: package_comment_likes package_comment_likes_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comment_likes
    ADD CONSTRAINT package_comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.package_comments(id) ON DELETE CASCADE;


--
-- Name: package_comment_likes package_comment_likes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comment_likes
    ADD CONSTRAINT package_comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: package_comments package_comments_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comments
    ADD CONSTRAINT package_comments_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.vendor_packages(id) ON DELETE CASCADE;


--
-- Name: package_comments package_comments_parent_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comments
    ADD CONSTRAINT package_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.package_comments(id) ON DELETE CASCADE;


--
-- Name: package_comments package_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_comments
    ADD CONSTRAINT package_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: package_engagement_settings package_engagement_settings_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_engagement_settings
    ADD CONSTRAINT package_engagement_settings_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.vendor_packages(id) ON DELETE CASCADE;


--
-- Name: package_engagement_settings package_engagement_settings_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_engagement_settings
    ADD CONSTRAINT package_engagement_settings_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: package_favorites package_favorites_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_favorites
    ADD CONSTRAINT package_favorites_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: package_favorites package_favorites_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_favorites
    ADD CONSTRAINT package_favorites_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.vendor_packages(id) ON DELETE CASCADE;


--
-- Name: package_items package_items_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_items
    ADD CONSTRAINT package_items_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.vendor_packages(id) ON DELETE CASCADE;


--
-- Name: package_items package_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.package_items
    ADD CONSTRAINT package_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: password_reset_requests password_reset_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_requests
    ADD CONSTRAINT password_reset_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: password_reset_requests password_reset_requests_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_requests
    ADD CONSTRAINT password_reset_requests_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: password_reset_requests password_reset_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_requests
    ADD CONSTRAINT password_reset_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: points_ledger points_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: points_skips points_skips_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_skips
    ADD CONSTRAINT points_skips_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: points_weekly points_weekly_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_weekly
    ADD CONSTRAINT points_weekly_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: product_comment_likes product_comment_likes_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comment_likes
    ADD CONSTRAINT product_comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.product_comments(id) ON DELETE CASCADE;


--
-- Name: product_comment_likes product_comment_likes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comment_likes
    ADD CONSTRAINT product_comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: product_comments product_comments_parent_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comments
    ADD CONSTRAINT product_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.product_comments(id) ON DELETE CASCADE;


--
-- Name: product_comments product_comments_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comments
    ADD CONSTRAINT product_comments_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_comments product_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_comments
    ADD CONSTRAINT product_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: product_engagement_settings product_engagement_settings_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_engagement_settings
    ADD CONSTRAINT product_engagement_settings_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_engagement_settings product_engagement_settings_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_engagement_settings
    ADD CONSTRAINT product_engagement_settings_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: product_variants product_variants_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_admin_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_admin_deleted_by_fkey FOREIGN KEY (admin_deleted_by) REFERENCES public.users(id);


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: products products_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_referred_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referred_user_id_fkey FOREIGN KEY (referred_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_referrer_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_vendor_id_fkey FOREIGN KEY (referrer_vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: request_offers request_offers_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_offers
    ADD CONSTRAINT request_offers_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.equipment_requests(id) ON DELETE CASCADE;


--
-- Name: request_offers request_offers_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_offers
    ADD CONSTRAINT request_offers_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: service_offers service_offers_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: service_offers service_offers_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: service_offers service_offers_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: service_offers service_offers_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_offers
    ADD CONSTRAINT service_offers_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: suggestions suggestions_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestions
    ADD CONSTRAINT suggestions_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: suggestions suggestions_target_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestions
    ADD CONSTRAINT suggestions_target_vendor_id_fkey FOREIGN KEY (target_vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: support_requests support_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_requests
    ADD CONSTRAINT support_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tts_usage tts_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tts_usage
    ADD CONSTRAINT tts_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_presence user_presence_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: users users_suspended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES public.users(id);


--
-- Name: vendor_follow_preferences vendor_follow_preferences_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follow_preferences
    ADD CONSTRAINT vendor_follow_preferences_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vendor_follow_preferences vendor_follow_preferences_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follow_preferences
    ADD CONSTRAINT vendor_follow_preferences_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_follows vendor_follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follows
    ADD CONSTRAINT vendor_follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vendor_follows vendor_follows_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_follows
    ADD CONSTRAINT vendor_follows_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_monthly_charges vendor_monthly_charges_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_monthly_charges
    ADD CONSTRAINT vendor_monthly_charges_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: vendor_packages vendor_packages_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_packages
    ADD CONSTRAINT vendor_packages_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_profile_view_events vendor_profile_view_events_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_profile_view_events
    ADD CONSTRAINT vendor_profile_view_events_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_recycle_bin vendor_recycle_bin_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_recycle_bin
    ADD CONSTRAINT vendor_recycle_bin_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_recycle_bin vendor_recycle_bin_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_recycle_bin
    ADD CONSTRAINT vendor_recycle_bin_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_student_verification vendor_student_verification_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_student_verification
    ADD CONSTRAINT vendor_student_verification_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendor_week_winners vendor_week_winners_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_week_winners
    ADD CONSTRAINT vendor_week_winners_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vendor_week_winners vendor_week_winners_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_week_winners
    ADD CONSTRAINT vendor_week_winners_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;


--
-- Name: vendors vendors_sector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_sector_id_fkey FOREIGN KEY (sector_id) REFERENCES public.sectors(id);


--
-- Name: vendors vendors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voice_calls voice_calls_callee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_calls
    ADD CONSTRAINT voice_calls_callee_id_fkey FOREIGN KEY (callee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voice_calls voice_calls_caller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_calls
    ADD CONSTRAINT voice_calls_caller_id_fkey FOREIGN KEY (caller_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voice_calls voice_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_calls
    ADD CONSTRAINT voice_calls_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: inventory Authenticated insert access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated insert access" ON public.inventory FOR INSERT TO authenticated WITH CHECK ((owner_id = auth.uid()));


--
-- Name: inventory Owner delete access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner delete access" ON public.inventory FOR DELETE TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: inventory Owner update access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner update access" ON public.inventory FOR UPDATE TO authenticated USING ((owner_id = auth.uid())) WITH CHECK ((owner_id = auth.uid()));


--
-- Name: inventory Public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read access" ON public.inventory FOR SELECT USING (true);


--
-- Name: vendor_profile_view_events Vendors can read their own profile view events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Vendors can read their own profile view events" ON public.vendor_profile_view_events FOR SELECT USING ((vendor_id IN ( SELECT vendors.id
   FROM public.vendors
  WHERE (vendors.user_id = auth.uid()))));


--
-- Name: account_appeals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_appeals ENABLE ROW LEVEL SECURITY;

--
-- Name: account_appeals account_appeals_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_appeals_insert_own ON public.account_appeals FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: account_appeals account_appeals_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_appeals_select_own ON public.account_appeals FOR SELECT USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: admin_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_actions admin_actions_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_actions_insert_admin ON public.admin_actions FOR INSERT TO authenticated WITH CHECK ((public.is_admin() AND (admin_id = auth.uid())));


--
-- Name: admin_actions admin_actions_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_actions_select_admin ON public.admin_actions FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: admin_login_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_login_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_conversations ai_conversations_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_conversations_delete_own ON public.ai_conversations FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: ai_conversations ai_conversations_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_conversations_insert_own ON public.ai_conversations FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: ai_conversations ai_conversations_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_conversations_select_own ON public.ai_conversations FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: ai_conversations ai_conversations_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_conversations_update_own ON public.ai_conversations FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: ai_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_messages ai_messages_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_messages_delete_own ON public.ai_messages FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.ai_conversations c
  WHERE ((c.id = ai_messages.conversation_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: ai_messages ai_messages_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_messages_insert_own ON public.ai_messages FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.ai_conversations c
  WHERE ((c.id = ai_messages.conversation_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: ai_messages ai_messages_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_messages_select_own ON public.ai_messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.ai_conversations c
  WHERE ((c.id = ai_messages.conversation_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: app_presence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_presence ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_activity_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_activity_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_activity_logs auth_activity_logs_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_activity_logs_admin_select ON public.auth_activity_logs FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: blocked_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_users blocked_users_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY blocked_users_delete_own ON public.blocked_users FOR DELETE USING ((blocker_id = auth.uid()));


--
-- Name: blocked_users blocked_users_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY blocked_users_insert_own ON public.blocked_users FOR INSERT WITH CHECK (((blocker_id = auth.uid()) AND (blocked_id <> auth.uid())));


--
-- Name: blocked_users blocked_users_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY blocked_users_select_own ON public.blocked_users FOR SELECT USING ((blocker_id = auth.uid()));


--
-- Name: bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings bookings_select_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_select_vendor_or_admin ON public.bookings FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = bookings.product_id) AND (public.owns_vendor(p.vendor_id) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: campus_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campus_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: homepage_carousel_slides carousel_slides_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carousel_slides_delete_admin ON public.homepage_carousel_slides FOR DELETE USING (public.is_admin());


--
-- Name: homepage_carousel_slides carousel_slides_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carousel_slides_insert_admin ON public.homepage_carousel_slides FOR INSERT WITH CHECK (public.is_admin());


--
-- Name: homepage_carousel_slides carousel_slides_select_active_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carousel_slides_select_active_or_admin ON public.homepage_carousel_slides FOR SELECT USING (((is_active = true) OR public.is_admin()));


--
-- Name: homepage_carousel_slides carousel_slides_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carousel_slides_update_admin ON public.homepage_carousel_slides FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: cart_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

--
-- Name: cart_items cart_items_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cart_items_owner ON public.cart_items USING ((buyer_id = auth.uid())) WITH CHECK ((buyer_id = auth.uid()));


--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: categories categories_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_delete_admin ON public.categories FOR DELETE USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: categories categories_insert_vendor_other; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_insert_vendor_other ON public.categories FOR INSERT TO authenticated WITH CHECK (((parent_category_id = '44444444-4444-4444-4444-444444444444'::uuid) AND (EXISTS ( SELECT 1
   FROM public.vendors
  WHERE (vendors.user_id = auth.uid())))));


--
-- Name: categories categories_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_select_all ON public.categories FOR SELECT USING (true);


--
-- Name: categories categories_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_update_admin ON public.categories FOR UPDATE USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: categories categories_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_write_admin ON public.categories FOR INSERT WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: chat_archive; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_archive ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_list_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_list_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_list_conversations chat_list_conversations_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_list_conversations_owner ON public.chat_list_conversations USING ((EXISTS ( SELECT 1
   FROM public.chat_lists cl
  WHERE ((cl.id = chat_list_conversations.list_id) AND (cl.user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.chat_lists cl
  WHERE ((cl.id = chat_list_conversations.list_id) AND (cl.user_id = auth.uid())))));


--
-- Name: chat_lists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_lists ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_lists chat_lists_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_lists_owner ON public.chat_lists USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: chat_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: comment_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.comment_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: comment_reports comment_reports_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comment_reports_insert ON public.comment_reports FOR INSERT TO authenticated WITH CHECK ((reporter_id = auth.uid()));


--
-- Name: comment_reports comment_reports_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comment_reports_select ON public.comment_reports FOR SELECT TO authenticated USING (((reporter_id = auth.uid()) OR public.is_admin()));


--
-- Name: commission_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_charges commission_charges_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_charges_select ON public.commission_charges FOR SELECT USING ((( SELECT public.owns_vendor(commission_charges.vendor_id) AS owns_vendor) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: commission_deadline_reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_deadline_reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_settlements commission_settlements_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_settlements_select ON public.commission_settlements FOR SELECT USING ((( SELECT public.owns_vendor(commission_settlements.vendor_id) AS owns_vendor) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations conversations_insert_participant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversations_insert_participant ON public.conversations FOR INSERT TO authenticated WITH CHECK (((NOT public.is_admin()) AND ((buyer_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = conversations.vendor_id) AND (v.user_id = ( SELECT auth.uid() AS uid))))))));


--
-- Name: conversations conversations_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversations_select_own ON public.conversations FOR SELECT USING (((buyer_id = ( SELECT auth.uid() AS uid)) OR (( SELECT vendors.user_id
   FROM public.vendors
  WHERE (vendors.id = conversations.vendor_id)) = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: disputes disputes_insert_party; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY disputes_insert_party ON public.disputes FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = disputes.order_id) AND ((o.buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(o.vendor_id))))));


--
-- Name: disputes disputes_select_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY disputes_select_party_or_admin ON public.disputes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = disputes.order_id) AND ((o.buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(o.vendor_id) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: disputes disputes_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY disputes_update_admin ON public.disputes FOR UPDATE USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: equipment_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipment_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

--
-- Name: favorites favorites_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY favorites_delete_own ON public.favorites FOR DELETE USING ((buyer_id = ( SELECT auth.uid() AS uid)));


--
-- Name: favorites favorites_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY favorites_insert_own ON public.favorites FOR INSERT WITH CHECK ((buyer_id = ( SELECT auth.uid() AS uid)));


--
-- Name: favorites favorites_select_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY favorites_select_own_or_admin ON public.favorites FOR SELECT USING (((buyer_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: homepage_carousel_slides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.homepage_carousel_slides ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_billing_reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_billing_reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_drafts listing_drafts_owner_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY listing_drafts_owner_delete ON public.listing_drafts FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = listing_drafts.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL)))));


--
-- Name: listing_drafts listing_drafts_owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY listing_drafts_owner_insert ON public.listing_drafts FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = listing_drafts.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL)))));


--
-- Name: listing_drafts listing_drafts_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY listing_drafts_owner_select ON public.listing_drafts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = listing_drafts.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL)))));


--
-- Name: listing_drafts listing_drafts_owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY listing_drafts_owner_update ON public.listing_drafts FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = listing_drafts.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = listing_drafts.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL)))));


--
-- Name: listing_payment_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_payment_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: message_pins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_pins ENABLE ROW LEVEL SECURITY;

--
-- Name: message_pins message_pins_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_pins_delete_own ON public.message_pins FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: message_pins message_pins_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_pins_insert_own ON public.message_pins FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (public.messages m
     JOIN public.conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_pins.message_id) AND (m.conversation_id = message_pins.conversation_id) AND ((c.buyer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.vendors v
          WHERE ((v.id = c.vendor_id) AND (v.user_id = auth.uid()))))))))));


--
-- Name: message_pins message_pins_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_pins_select_own ON public.message_pins FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (public.messages m
     JOIN public.conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_pins.message_id) AND (m.conversation_id = message_pins.conversation_id) AND ((c.buyer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.vendors v
          WHERE ((v.id = c.vendor_id) AND (v.user_id = auth.uid()))))))))));


--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_insert_own ON public.messages FOR INSERT WITH CHECK (((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.buyer_id = auth.uid()) OR (( SELECT vendors.user_id
           FROM public.vendors
          WHERE (vendors.id = c.vendor_id)) = auth.uid()))))) AND (NOT (EXISTS ( SELECT 1
   FROM (public.conversations c
     JOIN public.vendors v ON ((v.id = c.vendor_id)))
  WHERE ((c.id = messages.conversation_id) AND public.is_blocked_between(auth.uid(),
        CASE
            WHEN (c.buyer_id = auth.uid()) THEN v.user_id
            ELSE c.buyer_id
        END)))))));


--
-- Name: messages messages_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_select_own ON public.messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.buyer_id = ( SELECT auth.uid() AS uid)) OR (( SELECT vendors.user_id
           FROM public.vendors
          WHERE (vendors.id = c.vendor_id)) = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: messages messages_update_read_status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_update_read_status ON public.messages FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.buyer_id = ( SELECT auth.uid() AS uid)) OR (( SELECT vendors.user_id
           FROM public.vendors
          WHERE (vendors.id = c.vendor_id)) = ( SELECT auth.uid() AS uid))))))) WITH CHECK (true);


--
-- Name: monthly_listing_submissions monthly submissions admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "monthly submissions admin update" ON public.monthly_listing_submissions FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'admin'::public.user_role))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'admin'::public.user_role)))));


--
-- Name: monthly_listing_submissions monthly submissions vendor insert own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "monthly submissions vendor insert own" ON public.monthly_listing_submissions FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = monthly_listing_submissions.vendor_id) AND (v.user_id = auth.uid()) AND (v.deleted_at IS NULL))))));


--
-- Name: monthly_listing_submissions monthly submissions vendor select own or admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "monthly submissions vendor select own or admin" ON public.monthly_listing_submissions FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'admin'::public.user_role))))));


--
-- Name: monthly_listing_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monthly_listing_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_delete_own ON public.notifications FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: notifications notifications_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_insert_admin ON public.notifications FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: notifications notifications_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notifications notifications_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: request_offers offers_insert_vendor_on_open_request; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offers_insert_vendor_on_open_request ON public.request_offers FOR INSERT WITH CHECK ((( SELECT public.owns_vendor(request_offers.vendor_id) AS owns_vendor) AND (EXISTS ( SELECT 1
   FROM public.equipment_requests r
  WHERE ((r.id = request_offers.request_id) AND (r.status = 'open'::text))))));


--
-- Name: request_offers offers_select_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offers_select_party_or_admin ON public.request_offers FOR SELECT USING ((( SELECT public.owns_vendor(request_offers.vendor_id) AS owns_vendor) OR (EXISTS ( SELECT 1
   FROM public.equipment_requests r
  WHERE ((r.id = request_offers.request_id) AND (r.buyer_id = ( SELECT auth.uid() AS uid))))) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: request_offers offers_update_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offers_update_party_or_admin ON public.request_offers FOR UPDATE USING ((( SELECT public.owns_vendor(request_offers.vendor_id) AS owns_vendor) OR (EXISTS ( SELECT 1
   FROM public.equipment_requests r
  WHERE ((r.id = request_offers.request_id) AND (r.buyer_id = ( SELECT auth.uid() AS uid))))) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: order_items order_items_insert_via_order; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_items_insert_via_order ON public.order_items FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_items.order_id) AND (o.buyer_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: order_items order_items_select_via_order; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_items_select_via_order ON public.order_items FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_items.order_id) AND ((o.buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(o.vendor_id) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: order_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: order_notes order_notes_select_participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_notes_select_participants ON public.order_notes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.orders o
     LEFT JOIN public.vendors v ON ((v.id = o.vendor_id)))
  WHERE ((o.id = order_notes.order_id) AND ((o.buyer_id = auth.uid()) OR (v.user_id = auth.uid()))))));


--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_insert_buyer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_insert_buyer ON public.orders FOR INSERT WITH CHECK ((buyer_id = ( SELECT auth.uid() AS uid)));


--
-- Name: orders orders_select_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_select_party_or_admin ON public.orders FOR SELECT USING (((buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: orders orders_update_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_update_party_or_admin ON public.orders FOR UPDATE USING (((buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: package_favorites package favorites delete own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "package favorites delete own" ON public.package_favorites FOR DELETE USING (((buyer_id = auth.uid()) AND (NOT public.is_admin())));


--
-- Name: package_favorites package favorites insert own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "package favorites insert own" ON public.package_favorites FOR INSERT WITH CHECK (((buyer_id = auth.uid()) AND (NOT public.is_admin())));


--
-- Name: package_favorites package favorites select own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "package favorites select own" ON public.package_favorites FOR SELECT USING (((buyer_id = auth.uid()) OR public.is_admin()));


--
-- Name: package_comment_likes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.package_comment_likes ENABLE ROW LEVEL SECURITY;

--
-- Name: package_comment_likes package_comment_likes_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comment_likes_delete ON public.package_comment_likes FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: package_comment_likes package_comment_likes_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comment_likes_insert ON public.package_comment_likes FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: package_comment_likes package_comment_likes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comment_likes_select ON public.package_comment_likes FOR SELECT USING (true);


--
-- Name: package_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.package_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: package_comments package_comments_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comments_delete ON public.package_comments FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: package_comments package_comments_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comments_insert ON public.package_comments FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM ((public.vendor_packages p
     JOIN public.vendors v ON ((v.id = p.vendor_id)))
     LEFT JOIN public.package_engagement_settings s ON ((s.package_id = p.id)))
  WHERE ((p.id = package_comments.package_id) AND (COALESCE(s.allow_comments, true) = true) AND ((COALESCE(s.comment_audience, 'everyone'::text) = 'everyone'::text) OR public.is_vendor_follower(v.id) OR (v.user_id = auth.uid())))))));


--
-- Name: package_comments package_comments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comments_select ON public.package_comments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((public.vendor_packages p
     JOIN public.vendors v ON ((v.id = p.vendor_id)))
     LEFT JOIN public.package_engagement_settings s ON ((s.package_id = p.id)))
  WHERE ((p.id = package_comments.package_id) AND ((v.user_id = auth.uid()) OR ((COALESCE(s.allow_comments, true) = true) AND ((COALESCE(s.comment_audience, 'everyone'::text) = 'everyone'::text) OR public.is_vendor_follower(v.id) OR (v.user_id = auth.uid()))))))));


--
-- Name: package_comments package_comments_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_comments_update ON public.package_comments FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: package_engagement_settings package_engagement_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_engagement_delete ON public.package_engagement_settings FOR DELETE USING (public.is_vendor_owner(vendor_id));


--
-- Name: package_engagement_settings package_engagement_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_engagement_insert ON public.package_engagement_settings FOR INSERT WITH CHECK (public.is_vendor_owner(vendor_id));


--
-- Name: package_engagement_settings package_engagement_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_engagement_select ON public.package_engagement_settings FOR SELECT USING (true);


--
-- Name: package_engagement_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.package_engagement_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: package_engagement_settings package_engagement_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_engagement_update ON public.package_engagement_settings FOR UPDATE USING (public.is_vendor_owner(vendor_id)) WITH CHECK (public.is_vendor_owner(vendor_id));


--
-- Name: package_favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.package_favorites ENABLE ROW LEVEL SECURITY;

--
-- Name: package_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.package_items ENABLE ROW LEVEL SECURITY;

--
-- Name: package_items package_items_delete_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_items_delete_own_vendor ON public.package_items FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.vendor_packages vp
  WHERE ((vp.id = package_items.package_id) AND public.owns_vendor(vp.vendor_id)))));


--
-- Name: package_items package_items_insert_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_items_insert_own_vendor ON public.package_items FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.vendor_packages vp
  WHERE ((vp.id = package_items.package_id) AND public.owns_vendor(vp.vendor_id)))));


--
-- Name: package_items package_items_select_via_package; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_items_select_via_package ON public.package_items FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.vendor_packages vp
  WHERE ((vp.id = package_items.package_id) AND ((vp.status = 'active'::public.product_status) OR public.owns_vendor(vp.vendor_id) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: package_items package_items_update_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY package_items_update_own_vendor ON public.package_items FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.vendor_packages vp
  WHERE ((vp.id = package_items.package_id) AND public.owns_vendor(vp.vendor_id)))));


--
-- Name: password_reset_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: payments payments_select_party_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payments_select_party_or_admin ON public.payments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = payments.order_id) AND ((o.buyer_id = ( SELECT auth.uid() AS uid)) OR public.owns_vendor(o.vendor_id) OR ( SELECT public.is_admin() AS is_admin))))));


--
-- Name: points_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: points_ledger points_ledger_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY points_ledger_own ON public.points_ledger FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: points_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: points_rules points_rules_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY points_rules_read ON public.points_rules FOR SELECT TO authenticated, anon USING (true);


--
-- Name: points_skips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_skips ENABLE ROW LEVEL SECURITY;

--
-- Name: points_weekly; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_weekly ENABLE ROW LEVEL SECURITY;

--
-- Name: points_weekly points_weekly_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY points_weekly_read ON public.points_weekly FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE (v.user_id = points_weekly.user_id)))));


--
-- Name: product_comment_likes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_comment_likes ENABLE ROW LEVEL SECURITY;

--
-- Name: product_comment_likes product_comment_likes_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comment_likes_delete_own ON public.product_comment_likes FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: product_comment_likes product_comment_likes_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comment_likes_insert_own ON public.product_comment_likes FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: product_comment_likes product_comment_likes_select_visible; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comment_likes_select_visible ON public.product_comment_likes FOR SELECT USING (true);


--
-- Name: product_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: product_comments product_comments_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comments_delete_own ON public.product_comments FOR DELETE USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: product_comments product_comments_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comments_insert_own ON public.product_comments FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM ((public.products p
     JOIN public.vendors v ON ((v.id = p.vendor_id)))
     LEFT JOIN public.product_engagement_settings s ON ((s.product_id = p.id)))
  WHERE ((p.id = product_comments.product_id) AND (COALESCE(s.allow_comments, true) = true) AND ((COALESCE(s.comment_audience, 'everyone'::text) = 'everyone'::text) OR (EXISTS ( SELECT 1
           FROM public.vendor_follows f
          WHERE ((f.vendor_id = v.id) AND (f.follower_id = auth.uid())))) OR (v.user_id = auth.uid())))))));


--
-- Name: product_comments product_comments_select_visible; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comments_select_visible ON public.product_comments FOR SELECT USING (true);


--
-- Name: product_comments product_comments_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_comments_update_own ON public.product_comments FOR UPDATE USING (((user_id = auth.uid()) OR public.is_admin())) WITH CHECK (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: product_engagement_settings product_engagement_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_engagement_delete ON public.product_engagement_settings FOR DELETE USING (public.is_vendor_owner(vendor_id));


--
-- Name: product_engagement_settings product_engagement_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_engagement_insert ON public.product_engagement_settings FOR INSERT WITH CHECK (public.is_vendor_owner(vendor_id));


--
-- Name: product_engagement_settings product_engagement_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_engagement_select ON public.product_engagement_settings FOR SELECT USING (true);


--
-- Name: product_engagement_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_engagement_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: product_engagement_settings product_engagement_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_engagement_update ON public.product_engagement_settings FOR UPDATE USING (public.is_vendor_owner(vendor_id)) WITH CHECK (public.is_vendor_owner(vendor_id));


--
-- Name: product_variants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

--
-- Name: product_variants product_variants_delete_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_delete_own_vendor_or_admin ON public.product_variants FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (public.owns_vendor(p.vendor_id) OR public.is_admin())))));


--
-- Name: product_variants product_variants_insert_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_insert_own_vendor ON public.product_variants FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (public.owns_vendor(p.vendor_id) OR public.is_admin())))));


--
-- Name: product_variants product_variants_select_active_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_select_active_or_own ON public.product_variants FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND ((p.status = 'active'::public.product_status) OR public.owns_vendor(p.vendor_id) OR public.is_admin())))));


--
-- Name: product_variants product_variants_update_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_update_own_vendor_or_admin ON public.product_variants FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (public.owns_vendor(p.vendor_id) OR public.is_admin()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (public.owns_vendor(p.vendor_id) OR public.is_admin())))));


--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: products products_delete_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_delete_own_vendor_or_admin ON public.products FOR DELETE USING ((public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: products products_insert_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_insert_own_vendor ON public.products FOR INSERT WITH CHECK (public.owns_vendor(vendor_id));


--
-- Name: products products_select_active_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_select_active_or_own ON public.products FOR SELECT USING ((((status = 'active'::public.product_status) AND (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = products.vendor_id) AND (v.verification_status = 'verified'::public.vendor_verification_status) AND (v.is_active = true) AND (v.deleted_at IS NULL))))) OR (public.owns_vendor(vendor_id) AND (EXISTS ( SELECT 1
   FROM public.vendors v2
  WHERE ((v2.id = products.vendor_id) AND (v2.deleted_at IS NULL))))) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: products products_update_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_update_own_vendor_or_admin ON public.products FOR UPDATE USING ((public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: push_subscriptions push_subs_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subs_delete_own ON public.push_subscriptions FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: push_subscriptions push_subs_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subs_insert_own ON public.push_subscriptions FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: push_subscriptions push_subs_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subs_select_own ON public.push_subscriptions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: push_subscriptions push_subs_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subs_update_own ON public.push_subscriptions FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals referrals_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY referrals_own ON public.referrals FOR SELECT TO authenticated USING (((referrer_user_id = auth.uid()) OR (referred_user_id = auth.uid())));


--
-- Name: request_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.request_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: equipment_requests requests_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY requests_insert_own ON public.equipment_requests FOR INSERT WITH CHECK ((buyer_id = ( SELECT auth.uid() AS uid)));


--
-- Name: equipment_requests requests_select_open_or_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY requests_select_open_or_own_or_admin ON public.equipment_requests FOR SELECT USING (((status = 'open'::text) OR (buyer_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: equipment_requests requests_update_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY requests_update_own_or_admin ON public.equipment_requests FOR UPDATE USING (((buyer_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews reviews_insert_buyer_after_completed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reviews_insert_buyer_after_completed ON public.reviews FOR INSERT TO authenticated WITH CHECK (((buyer_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = reviews.order_id) AND (o.buyer_id = auth.uid()) AND (o.status = 'completed'::public.order_status) AND (EXISTS ( SELECT 1
           FROM public.payments p
          WHERE ((p.order_id = o.id) AND (p.status = 'paid'::public.payment_status) AND (p.payment_type =
                CASE
                    WHEN (o.order_type = 'sale'::public.order_type) THEN 'sale_price'::public.payment_type
                    ELSE 'rental_fee'::public.payment_type
                END)))) AND ((o.delivery_method <> 'delivery'::public.delivery_method) OR (EXISTS ( SELECT 1
           FROM public.payments dp
          WHERE ((dp.order_id = o.id) AND (dp.payment_type = 'delivery_deposit_20'::public.payment_type) AND (dp.status = 'paid'::public.payment_status))))))))));


--
-- Name: reviews reviews_insert_buyer_after_verified_payment; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reviews_insert_buyer_after_verified_payment ON public.reviews FOR INSERT WITH CHECK (((buyer_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = reviews.order_id) AND (o.buyer_id = auth.uid()) AND (o.status = 'completed'::public.order_status) AND (EXISTS ( SELECT 1
           FROM public.payments p
          WHERE ((p.order_id = o.id) AND (p.payment_type =
                CASE
                    WHEN (o.order_type = 'sale'::public.order_type) THEN 'sale_price'::public.payment_type
                    ELSE 'rental_fee'::public.payment_type
                END) AND (p.status = 'paid'::public.payment_status)))))))));


--
-- Name: reviews reviews_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reviews_select_all ON public.reviews FOR SELECT USING (true);


--
-- Name: search_synonyms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_synonyms ENABLE ROW LEVEL SECURITY;

--
-- Name: search_synonyms search_synonyms_read_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY search_synonyms_read_all ON public.search_synonyms FOR SELECT USING (true);


--
-- Name: sectors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sectors ENABLE ROW LEVEL SECURITY;

--
-- Name: sectors sectors_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sectors_select_all ON public.sectors FOR SELECT USING (true);


--
-- Name: service_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: service_offers service_offers_select_participant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_offers_select_participant ON public.service_offers FOR SELECT TO authenticated USING (((buyer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = service_offers.vendor_id) AND (v.user_id = auth.uid()))))));


--
-- Name: suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: suggestions suggestions_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suggestions_insert_own ON public.suggestions FOR INSERT WITH CHECK ((sender_id = auth.uid()));


--
-- Name: suggestions suggestions_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suggestions_select_admin ON public.suggestions FOR SELECT USING (public.is_admin());


--
-- Name: support_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: support_requests support_requests_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_requests_admin_select ON public.support_requests FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: support_requests support_requests_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_requests_admin_update ON public.support_requests FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: support_requests support_requests_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_requests_insert_own ON public.support_requests FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: support_requests support_requests_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_requests_select_own ON public.support_requests FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: tts_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tts_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: user_presence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_select_self_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_select_self_or_admin ON public.users FOR SELECT USING (((id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: users users_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_update_self ON public.users FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));


--
-- Name: vendor_follow_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_follow_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_follow_preferences vendor_follow_preferences_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follow_preferences_delete_own ON public.vendor_follow_preferences FOR DELETE TO authenticated USING ((follower_id = auth.uid()));


--
-- Name: vendor_follow_preferences vendor_follow_preferences_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follow_preferences_insert_own ON public.vendor_follow_preferences FOR INSERT TO authenticated WITH CHECK (((follower_id = auth.uid()) AND (NOT (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = vendor_follow_preferences.vendor_id) AND (v.user_id = auth.uid())))))));


--
-- Name: vendor_follow_preferences vendor_follow_preferences_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follow_preferences_select_own ON public.vendor_follow_preferences FOR SELECT TO authenticated USING ((follower_id = auth.uid()));


--
-- Name: vendor_follow_preferences vendor_follow_preferences_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follow_preferences_update_own ON public.vendor_follow_preferences FOR UPDATE TO authenticated USING ((follower_id = auth.uid())) WITH CHECK ((follower_id = auth.uid()));


--
-- Name: vendor_follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_follows ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_follows vendor_follows_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follows_delete_own ON public.vendor_follows FOR DELETE TO authenticated USING ((follower_id = auth.uid()));


--
-- Name: vendor_follows vendor_follows_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follows_insert_own ON public.vendor_follows FOR INSERT TO authenticated WITH CHECK (((follower_id = auth.uid()) AND (NOT (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = vendor_follows.vendor_id) AND (v.user_id = auth.uid())))))));


--
-- Name: vendor_follows vendor_follows_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_follows_select_own ON public.vendor_follows FOR SELECT TO authenticated USING ((follower_id = auth.uid()));


--
-- Name: vendor_monthly_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_monthly_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_monthly_charges vendor_monthly_charges_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_monthly_charges_select_own ON public.vendor_monthly_charges FOR SELECT USING (((( SELECT vendors.user_id
   FROM public.vendors
  WHERE (vendors.id = vendor_monthly_charges.vendor_id)) = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: vendor_packages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_packages ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_packages vendor_packages_delete_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_packages_delete_own_vendor_or_admin ON public.vendor_packages FOR DELETE USING ((public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: vendor_packages vendor_packages_insert_own_vendor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_packages_insert_own_vendor ON public.vendor_packages FOR INSERT WITH CHECK (public.owns_vendor(vendor_id));


--
-- Name: vendor_packages vendor_packages_select_active_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_packages_select_active_or_own ON public.vendor_packages FOR SELECT USING ((((status = 'active'::public.product_status) AND (EXISTS ( SELECT 1
   FROM public.vendors v
  WHERE ((v.id = vendor_packages.vendor_id) AND (v.verification_status = 'verified'::public.vendor_verification_status) AND (v.is_active = true) AND (v.deleted_at IS NULL))))) OR (public.owns_vendor(vendor_id) AND (EXISTS ( SELECT 1
   FROM public.vendors v2
  WHERE ((v2.id = vendor_packages.vendor_id) AND (v2.deleted_at IS NULL))))) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: vendor_packages vendor_packages_update_own_vendor_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_packages_update_own_vendor_or_admin ON public.vendor_packages FOR UPDATE USING ((public.owns_vendor(vendor_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: vendor_profile_view_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_profile_view_events ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_recycle_bin; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_recycle_bin ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_student_verification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_student_verification ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_week_winners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_week_winners ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_week_winners vendor_week_winners_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendor_week_winners_read ON public.vendor_week_winners FOR SELECT TO authenticated, anon USING (true);


--
-- Name: vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

--
-- Name: vendors vendors_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_insert_own ON public.vendors FOR INSERT WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (NOT public.is_admin())));


--
-- Name: vendors vendors_select_public; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_select_public ON public.vendors FOR SELECT USING ((((verification_status = 'verified'::public.vendor_verification_status) AND is_active) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.vendor_id = vendors.id) AND (o.buyer_id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: vendors vendors_update_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_update_own_or_admin ON public.vendors FOR UPDATE USING (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: voice_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_calls voice_calls_select_participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY voice_calls_select_participants ON public.voice_calls FOR SELECT TO authenticated USING (((caller_id = auth.uid()) OR (callee_id = auth.uid()) OR public.is_admin()));


--
-- Name: vendor_student_verification vsv_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vsv_insert ON public.vendor_student_verification FOR INSERT WITH CHECK ((public.owns_vendor(vendor_id) AND (status = 'pending'::text)));


--
-- Name: vendor_student_verification vsv_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vsv_select ON public.vendor_student_verification FOR SELECT USING ((public.owns_vendor(vendor_id) OR public.is_admin()));


--
-- Name: vendor_student_verification vsv_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vsv_update_admin ON public.vendor_student_verification FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: vendor_student_verification vsv_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vsv_update_owner ON public.vendor_student_verification FOR UPDATE USING ((public.owns_vendor(vendor_id) AND (status <> 'approved'::text))) WITH CHECK ((public.owns_vendor(vendor_id) AND (status = 'pending'::text)));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION accept_legal_terms(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_legal_terms() FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_legal_terms() TO anon;
GRANT ALL ON FUNCTION public.accept_legal_terms() TO authenticated;
GRANT ALL ON FUNCTION public.accept_legal_terms() TO service_role;


--
-- Name: FUNCTION accept_request_offer(p_offer_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accept_request_offer(p_offer_id uuid) TO anon;
GRANT ALL ON FUNCTION public.accept_request_offer(p_offer_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.accept_request_offer(p_offer_id uuid) TO service_role;


--
-- Name: FUNCTION add_order_note(p_order_id uuid, p_body text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_order_note(p_order_id uuid, p_body text) TO anon;
GRANT ALL ON FUNCTION public.add_order_note(p_order_id uuid, p_body text) TO authenticated;
GRANT ALL ON FUNCTION public.add_order_note(p_order_id uuid, p_body text) TO service_role;


--
-- Name: FUNCTION add_to_cart(p_product_id uuid, p_quantity integer, p_variant_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_to_cart(p_product_id uuid, p_quantity integer, p_variant_id uuid) TO anon;
GRANT ALL ON FUNCTION public.add_to_cart(p_product_id uuid, p_quantity integer, p_variant_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.add_to_cart(p_product_id uuid, p_quantity integer, p_variant_id uuid) TO service_role;


--
-- Name: FUNCTION admin_adjust_points(p_user uuid, p_points integer, p_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_adjust_points(p_user uuid, p_points integer, p_note text) TO anon;
GRANT ALL ON FUNCTION public.admin_adjust_points(p_user uuid, p_points integer, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_adjust_points(p_user uuid, p_points integer, p_note text) TO service_role;


--
-- Name: FUNCTION admin_approve_manual_password_reset(p_request_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_approve_manual_password_reset(p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_approve_manual_password_reset(p_request_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_approve_manual_password_reset(p_request_id uuid) TO service_role;


--
-- Name: FUNCTION admin_approve_monthly_listing(p_submission_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_approve_monthly_listing(p_submission_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_approve_monthly_listing(p_submission_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_approve_monthly_listing(p_submission_id uuid) TO service_role;


--
-- Name: FUNCTION admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean) TO anon;
GRANT ALL ON FUNCTION public.admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean) TO authenticated;
GRANT ALL ON FUNCTION public.admin_approve_vendor(p_vendor_id uuid, p_approve_without_payout boolean) TO service_role;


--
-- Name: FUNCTION admin_award_social_points(p_phone text, p_platform text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_award_social_points(p_phone text, p_platform text) TO anon;
GRANT ALL ON FUNCTION public.admin_award_social_points(p_phone text, p_platform text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_award_social_points(p_phone text, p_platform text) TO service_role;


--
-- Name: FUNCTION admin_campus_submissions(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_campus_submissions() TO anon;
GRANT ALL ON FUNCTION public.admin_campus_submissions() TO authenticated;
GRANT ALL ON FUNCTION public.admin_campus_submissions() TO service_role;


--
-- Name: FUNCTION admin_cancel_confirmed_overdue_order(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_cancel_confirmed_overdue_order(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_cancel_confirmed_overdue_order(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_cancel_confirmed_overdue_order(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION admin_confirm_reported_payment(p_order_id uuid, p_admin_notes text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_confirm_reported_payment(p_order_id uuid, p_admin_notes text) TO anon;
GRANT ALL ON FUNCTION public.admin_confirm_reported_payment(p_order_id uuid, p_admin_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_confirm_reported_payment(p_order_id uuid, p_admin_notes text) TO service_role;


--
-- Name: FUNCTION admin_deactivate_monthly_listing(p_submission_id uuid, p_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_deactivate_monthly_listing(p_submission_id uuid, p_note text) TO anon;
GRANT ALL ON FUNCTION public.admin_deactivate_monthly_listing(p_submission_id uuid, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_deactivate_monthly_listing(p_submission_id uuid, p_note text) TO service_role;


--
-- Name: FUNCTION admin_delete_inventory_product(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_delete_inventory_product(p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_delete_inventory_product(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_delete_inventory_product(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_inventory_product(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION admin_delete_vendor(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_delete_vendor(p_vendor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_delete_vendor(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_vendor(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_deny_appeal(p_appeal_id uuid, p_response text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_deny_appeal(p_appeal_id uuid, p_response text) TO anon;
GRANT ALL ON FUNCTION public.admin_deny_appeal(p_appeal_id uuid, p_response text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_deny_appeal(p_appeal_id uuid, p_response text) TO service_role;


--
-- Name: FUNCTION admin_find_conversation(p_buyer_id uuid, p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_find_conversation(p_buyer_id uuid, p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_find_conversation(p_buyer_id uuid, p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_find_conversation(p_buyer_id uuid, p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_force_unlock_vendor(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_force_unlock_vendor(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_force_unlock_vendor(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_force_unlock_vendor(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_conversation_participants(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_get_conversation_participants(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_get_conversation_participants(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_conversation_participants(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_inventory(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_get_inventory() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_get_inventory() TO anon;
GRANT ALL ON FUNCTION public.admin_get_inventory() TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_inventory() TO service_role;


--
-- Name: FUNCTION admin_get_manual_password_reset_requests(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_get_manual_password_reset_requests() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_get_manual_password_reset_requests() TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_manual_password_reset_requests() TO service_role;


--
-- Name: FUNCTION admin_get_pending_appeals(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_get_pending_appeals() TO anon;
GRANT ALL ON FUNCTION public.admin_get_pending_appeals() TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_pending_appeals() TO service_role;


--
-- Name: FUNCTION admin_list_conversations(p_search text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_list_conversations(p_search text, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.admin_list_conversations(p_search text, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_conversations(p_search text, p_limit integer) TO service_role;


--
-- Name: FUNCTION admin_list_locked_vendors(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_list_locked_vendors() TO anon;
GRANT ALL ON FUNCTION public.admin_list_locked_vendors() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_locked_vendors() TO service_role;


--
-- Name: FUNCTION admin_list_transactions(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_list_transactions() TO anon;
GRANT ALL ON FUNCTION public.admin_list_transactions() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_transactions() TO service_role;


--
-- Name: FUNCTION admin_list_vendor_payouts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_list_vendor_payouts() TO anon;
GRANT ALL ON FUNCTION public.admin_list_vendor_payouts() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_vendor_payouts() TO service_role;


--
-- Name: FUNCTION admin_permanently_delete_vendor(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_permanently_delete_vendor(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_permanently_delete_vendor(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_recent_points_adjustments(p_user uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_recent_points_adjustments(p_user uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_recent_points_adjustments(p_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_recent_points_adjustments(p_user uuid) TO service_role;


--
-- Name: FUNCTION admin_recent_points_skips(p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_recent_points_skips(p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.admin_recent_points_skips(p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.admin_recent_points_skips(p_limit integer) TO service_role;


--
-- Name: FUNCTION admin_reject_manual_password_reset(p_request_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_reject_manual_password_reset(p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_reject_manual_password_reset(p_request_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reject_manual_password_reset(p_request_id uuid) TO service_role;


--
-- Name: FUNCTION admin_reject_monthly_listing(p_submission_id uuid, p_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reject_monthly_listing(p_submission_id uuid, p_note text) TO anon;
GRANT ALL ON FUNCTION public.admin_reject_monthly_listing(p_submission_id uuid, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reject_monthly_listing(p_submission_id uuid, p_note text) TO service_role;


--
-- Name: FUNCTION admin_reject_reported_payment(p_order_id uuid, p_admin_notes text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reject_reported_payment(p_order_id uuid, p_admin_notes text) TO anon;
GRANT ALL ON FUNCTION public.admin_reject_reported_payment(p_order_id uuid, p_admin_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reject_reported_payment(p_order_id uuid, p_admin_notes text) TO service_role;


--
-- Name: FUNCTION admin_reject_vendor(p_vendor_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reject_vendor(p_vendor_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.admin_reject_vendor(p_vendor_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reject_vendor(p_vendor_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION admin_restore_vendor(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_restore_vendor(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_restore_vendor(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_review_campus_school(p_norm text, p_action text, p_target text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_review_campus_school(p_norm text, p_action text, p_target text) TO anon;
GRANT ALL ON FUNCTION public.admin_review_campus_school(p_norm text, p_action text, p_target text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_review_campus_school(p_norm text, p_action text, p_target text) TO service_role;


--
-- Name: FUNCTION admin_review_student_verification(p_vendor_id uuid, p_status text, p_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_review_student_verification(p_vendor_id uuid, p_status text, p_note text) TO anon;
GRANT ALL ON FUNCTION public.admin_review_student_verification(p_vendor_id uuid, p_status text, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_review_student_verification(p_vendor_id uuid, p_status text, p_note text) TO service_role;


--
-- Name: FUNCTION admin_search_points_users(p_q text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_search_points_users(p_q text) TO anon;
GRANT ALL ON FUNCTION public.admin_search_points_users(p_q text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_search_points_users(p_q text) TO service_role;


--
-- Name: FUNCTION admin_set_user_role(target_email text, new_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_set_user_role(target_email text, new_role text) TO anon;
GRANT ALL ON FUNCTION public.admin_set_user_role(target_email text, new_role text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_user_role(target_email text, new_role text) TO service_role;


--
-- Name: FUNCTION admin_set_vendor_status(p_vendor_id uuid, p_status public.vendor_verification_status); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_vendor_status(p_vendor_id uuid, p_status public.vendor_verification_status) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_vendor_status(p_vendor_id uuid, p_status public.vendor_verification_status) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_vendor_status(p_vendor_id uuid, p_status public.vendor_verification_status) TO service_role;


--
-- Name: FUNCTION admin_set_vendor_storefront_active(p_vendor_id uuid, p_active boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_set_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO anon;
GRANT ALL ON FUNCTION public.admin_set_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO service_role;


--
-- Name: FUNCTION admin_suspend_user(p_user_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO anon;
GRANT ALL ON FUNCTION public.admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.admin_toggle_vendor_storefront_active(p_vendor_id uuid, p_active boolean) TO service_role;


--
-- Name: FUNCTION admin_trash_vendor(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_trash_vendor(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_trash_vendor(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_trash_vendor(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION admin_unlink_all_identities(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_unlink_all_identities(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_unlink_all_identities(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_unsuspend_user(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION am_i_blocked_with(other_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.am_i_blocked_with(other_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.am_i_blocked_with(other_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.am_i_blocked_with(other_user_id uuid) TO service_role;


--
-- Name: FUNCTION apply_referral_code(p_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.apply_referral_code(p_code text) TO authenticated;
GRANT ALL ON FUNCTION public.apply_referral_code(p_code text) TO service_role;


--
-- Name: FUNCTION apply_referral_internal(p_uid uuid, p_code text, p_skip_customer boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_referral_internal(p_uid uuid, p_code text, p_skip_customer boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_referral_internal(p_uid uuid, p_code text, p_skip_customer boolean) TO service_role;


--
-- Name: FUNCTION auto_cancel_unconfirmed_orders(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auto_cancel_unconfirmed_orders() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_cancel_unconfirmed_orders() TO service_role;


--
-- Name: FUNCTION auto_complete_eligible_orders(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auto_complete_eligible_orders() TO anon;
GRANT ALL ON FUNCTION public.auto_complete_eligible_orders() TO authenticated;
GRANT ALL ON FUNCTION public.auto_complete_eligible_orders() TO service_role;


--
-- Name: FUNCTION award_points(p_user uuid, p_kind text, p_key text, p_source uuid, p_note text, p_meta jsonb, p_points integer, p_notify boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.award_points(p_user uuid, p_kind text, p_key text, p_source uuid, p_note text, p_meta jsonb, p_points integer, p_notify boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.award_points(p_user uuid, p_kind text, p_key text, p_source uuid, p_note text, p_meta jsonb, p_points integer, p_notify boolean) TO service_role;


--
-- Name: FUNCTION buyer_can_message_vendor(p_buyer uuid, p_vendor uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.buyer_can_message_vendor(p_buyer uuid, p_vendor uuid) TO anon;
GRANT ALL ON FUNCTION public.buyer_can_message_vendor(p_buyer uuid, p_vendor uuid) TO authenticated;
GRANT ALL ON FUNCTION public.buyer_can_message_vendor(p_buyer uuid, p_vendor uuid) TO service_role;


--
-- Name: FUNCTION buyer_confirm_received(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.buyer_confirm_received(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.buyer_confirm_received(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.buyer_confirm_received(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION buyer_report_manual_payment(p_order_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.buyer_report_manual_payment(p_order_id uuid, p_amount numeric) TO anon;
GRANT ALL ON FUNCTION public.buyer_report_manual_payment(p_order_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.buyer_report_manual_payment(p_order_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION buyer_respond_quantity_proposal(p_order_id uuid, p_accept boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.buyer_respond_quantity_proposal(p_order_id uuid, p_accept boolean) TO anon;
GRANT ALL ON FUNCTION public.buyer_respond_quantity_proposal(p_order_id uuid, p_accept boolean) TO authenticated;
GRANT ALL ON FUNCTION public.buyer_respond_quantity_proposal(p_order_id uuid, p_accept boolean) TO service_role;


--
-- Name: FUNCTION campus_school_names(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.campus_school_names() TO anon;
GRANT ALL ON FUNCTION public.campus_school_names() TO authenticated;
GRANT ALL ON FUNCTION public.campus_school_names() TO service_role;


--
-- Name: FUNCTION can_call_in_conversation(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.can_call_in_conversation(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.can_call_in_conversation(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_call_in_conversation(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION chat_purge_candidates(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.chat_purge_candidates() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_purge_candidates() TO service_role;


--
-- Name: FUNCTION clear_presence(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.clear_presence() FROM PUBLIC;
GRANT ALL ON FUNCTION public.clear_presence() TO authenticated;
GRANT ALL ON FUNCTION public.clear_presence() TO service_role;


--
-- Name: FUNCTION complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text) TO anon;
GRANT ALL ON FUNCTION public.complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text) TO service_role;
GRANT ALL ON FUNCTION public.complete_manual_password_reset(p_request_id uuid, p_token text, p_new_password text) TO authenticated;


--
-- Name: FUNCTION compute_delivery_fee(p_vendor_id uuid, p_buyer_lat double precision, p_buyer_lng double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compute_delivery_fee(p_vendor_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO anon;
GRANT ALL ON FUNCTION public.compute_delivery_fee(p_vendor_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO authenticated;
GRANT ALL ON FUNCTION public.compute_delivery_fee(p_vendor_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO service_role;


--
-- Name: FUNCTION compute_monthly_billing_amount(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compute_monthly_billing_amount(p_vendor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.compute_monthly_billing_amount(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.compute_monthly_billing_amount(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.compute_monthly_billing_amount(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION compute_product_delivery_fee(p_product_id uuid, p_buyer_lat double precision, p_buyer_lng double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compute_product_delivery_fee(p_product_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO anon;
GRANT ALL ON FUNCTION public.compute_product_delivery_fee(p_product_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO authenticated;
GRANT ALL ON FUNCTION public.compute_product_delivery_fee(p_product_id uuid, p_buyer_lat double precision, p_buyer_lng double precision) TO service_role;


--
-- Name: FUNCTION confirm_service_offer_payment(p_offer_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.confirm_service_offer_payment(p_offer_id uuid) TO anon;
GRANT ALL ON FUNCTION public.confirm_service_offer_payment(p_offer_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_service_offer_payment(p_offer_id uuid) TO service_role;


--
-- Name: FUNCTION conversation_is_open(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.conversation_is_open(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.conversation_is_open(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.conversation_is_open(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION create_cart_order(p_vendor_id uuid, p_items jsonb, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_cart_order(p_vendor_id uuid, p_items jsonb, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO anon;
GRANT ALL ON FUNCTION public.create_cart_order(p_vendor_id uuid, p_items jsonb, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO authenticated;
GRANT ALL ON FUNCTION public.create_cart_order(p_vendor_id uuid, p_items jsonb, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO service_role;


--
-- Name: FUNCTION create_chat_list(p_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_chat_list(p_name text) TO anon;
GRANT ALL ON FUNCTION public.create_chat_list(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.create_chat_list(p_name text) TO service_role;


--
-- Name: FUNCTION create_commission_payment_intent(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_commission_payment_intent(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.create_commission_payment_intent(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_commission_payment_intent(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION create_notification(p_user_id uuid, p_type text, p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_notification(p_user_id uuid, p_type text, p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.create_notification(p_user_id uuid, p_type text, p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_notification(p_user_id uuid, p_type text, p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION create_package_order(p_package_id uuid, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_package_order(p_package_id uuid, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text) TO anon;
GRANT ALL ON FUNCTION public.create_package_order(p_package_id uuid, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.create_package_order(p_package_id uuid, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text) TO service_role;


--
-- Name: FUNCTION create_payment_intent(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_payment_intent(p_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_payment_intent(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_payment_intent(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION create_rental_booking(p_order_item_id uuid, p_product_id uuid, p_start_date date, p_end_date date, p_quantity integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_rental_booking(p_order_item_id uuid, p_product_id uuid, p_start_date date, p_end_date date, p_quantity integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_rental_booking(p_order_item_id uuid, p_product_id uuid, p_start_date date, p_end_date date, p_quantity integer) TO authenticated;
GRANT ALL ON FUNCTION public.create_rental_booking(p_order_item_id uuid, p_product_id uuid, p_start_date date, p_end_date date, p_quantity integer) TO service_role;


--
-- Name: FUNCTION create_rental_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_start_date date, p_end_date date, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_rental_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_start_date date, p_end_date date, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO anon;
GRANT ALL ON FUNCTION public.create_rental_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_start_date date, p_end_date date, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO authenticated;
GRANT ALL ON FUNCTION public.create_rental_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_start_date date, p_end_date date, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO service_role;


--
-- Name: FUNCTION create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO anon;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO authenticated;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision) TO service_role;


--
-- Name: FUNCTION create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO anon;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO authenticated;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text) TO service_role;


--
-- Name: FUNCTION create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text, p_variant_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text, p_variant_id uuid) TO anon;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text, p_variant_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_sale_order(p_vendor_id uuid, p_product_id uuid, p_quantity integer, p_delivery_method public.delivery_method, p_delivery_address text, p_delivery_phone text, p_buyer_lat double precision, p_buyer_lng double precision, p_buyer_note text, p_variant_id uuid) TO service_role;


--
-- Name: FUNCTION create_service_offer(p_listing_id uuid, p_description text, p_price numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_service_offer(p_listing_id uuid, p_description text, p_price numeric) TO anon;
GRANT ALL ON FUNCTION public.create_service_offer(p_listing_id uuid, p_description text, p_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.create_service_offer(p_listing_id uuid, p_description text, p_price numeric) TO service_role;


--
-- Name: FUNCTION create_vendor_category(p_name text, p_sector_id uuid, p_parent_category_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_vendor_category(p_name text, p_sector_id uuid, p_parent_category_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_vendor_category(p_name text, p_sector_id uuid, p_parent_category_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_vendor_category(p_name text, p_sector_id uuid, p_parent_category_id uuid) TO service_role;


--
-- Name: FUNCTION create_vendor_sector(p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_vendor_sector(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_vendor_sector(p_name text) TO anon;
GRANT ALL ON FUNCTION public.create_vendor_sector(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.create_vendor_sector(p_name text) TO service_role;


--
-- Name: FUNCTION "current_role"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public."current_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION public."current_role"() TO service_role;


--
-- Name: FUNCTION delete_chat_list(p_list_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_chat_list(p_list_id uuid) TO anon;
GRANT ALL ON FUNCTION public.delete_chat_list(p_list_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_chat_list(p_list_id uuid) TO service_role;


--
-- Name: FUNCTION delete_message(p_message_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_message(p_message_id uuid) TO anon;
GRANT ALL ON FUNCTION public.delete_message(p_message_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_message(p_message_id uuid) TO service_role;


--
-- Name: FUNCTION delete_my_account(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_my_account(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_my_account(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_my_account(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION dispute_service_offer_payment(p_offer_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.dispute_service_offer_payment(p_offer_id uuid) TO anon;
GRANT ALL ON FUNCTION public.dispute_service_offer_payment(p_offer_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.dispute_service_offer_payment(p_offer_id uuid) TO service_role;


--
-- Name: FUNCTION edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text) TO anon;
GRANT ALL ON FUNCTION public.edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text) TO authenticated;
GRANT ALL ON FUNCTION public.edit_buyer_order(p_order_id uuid, p_items jsonb, p_buyer_note text) TO service_role;


--
-- Name: FUNCTION edit_message(p_message_id uuid, p_new_body text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.edit_message(p_message_id uuid, p_new_body text) TO anon;
GRANT ALL ON FUNCTION public.edit_message(p_message_id uuid, p_new_body text) TO authenticated;
GRANT ALL ON FUNCTION public.edit_message(p_message_id uuid, p_new_body text) TO service_role;


--
-- Name: FUNCTION edit_pending_order(p_order_id uuid, p_items jsonb, p_buyer_note text, p_delivery_address text, p_delivery_phone text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.edit_pending_order(p_order_id uuid, p_items jsonb, p_buyer_note text, p_delivery_address text, p_delivery_phone text) TO anon;
GRANT ALL ON FUNCTION public.edit_pending_order(p_order_id uuid, p_items jsonb, p_buyer_note text, p_delivery_address text, p_delivery_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.edit_pending_order(p_order_id uuid, p_items jsonb, p_buyer_note text, p_delivery_address text, p_delivery_phone text) TO service_role;


--
-- Name: FUNCTION enforce_buyer_phone_on_order(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_buyer_phone_on_order() TO anon;
GRANT ALL ON FUNCTION public.enforce_buyer_phone_on_order() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_buyer_phone_on_order() TO service_role;


--
-- Name: FUNCTION enforce_commission_deadlines(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_commission_deadlines(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.enforce_commission_deadlines(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.enforce_commission_deadlines(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION enforce_message_pin_limit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_message_pin_limit() TO anon;
GRANT ALL ON FUNCTION public.enforce_message_pin_limit() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_message_pin_limit() TO service_role;


--
-- Name: FUNCTION enforce_vendor_onboarding_requirements(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_vendor_onboarding_requirements() TO anon;
GRANT ALL ON FUNCTION public.enforce_vendor_onboarding_requirements() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_vendor_onboarding_requirements() TO service_role;


--
-- Name: FUNCTION ensure_default_category(p_sector_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_default_category(p_sector_id uuid) TO anon;
GRANT ALL ON FUNCTION public.ensure_default_category(p_sector_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ensure_default_category(p_sector_id uuid) TO service_role;


--
-- Name: FUNCTION escalate_unresolved_payment_orders(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.escalate_unresolved_payment_orders() TO anon;
GRANT ALL ON FUNCTION public.escalate_unresolved_payment_orders() TO authenticated;
GRANT ALL ON FUNCTION public.escalate_unresolved_payment_orders() TO service_role;


--
-- Name: FUNCTION finalize_points_weeks(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_points_weeks() FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_points_weeks() TO service_role;


--
-- Name: FUNCTION generate_referral_code(p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.generate_referral_code(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.generate_referral_code(p_name text) TO service_role;


--
-- Name: FUNCTION get_call_party(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_call_party(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_call_party(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_call_party(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION get_comment_authors(p_user_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_comment_authors(p_user_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_comment_authors(p_user_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_comment_authors(p_user_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_conversation_other_party(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_conversation_other_party(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_conversation_other_party(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_conversation_other_party(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION get_conversation_presence(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_conversation_presence(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_conversation_presence(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_conversation_presence(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION get_favorite_count(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_favorite_count(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_favorite_count(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_favorite_count(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION get_favorite_counts(p_product_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_favorite_counts(p_product_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_favorite_counts(p_product_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_favorite_counts(p_product_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_legal_terms_consent(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_legal_terms_consent() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_legal_terms_consent() TO anon;
GRANT ALL ON FUNCTION public.get_legal_terms_consent() TO authenticated;
GRANT ALL ON FUNCTION public.get_legal_terms_consent() TO service_role;


--
-- Name: FUNCTION get_manual_password_reset_status(p_request_id uuid, p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_manual_password_reset_status(p_request_id uuid, p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_manual_password_reset_status(p_request_id uuid, p_token text) TO anon;
GRANT ALL ON FUNCTION public.get_manual_password_reset_status(p_request_id uuid, p_token text) TO service_role;
GRANT ALL ON FUNCTION public.get_manual_password_reset_status(p_request_id uuid, p_token text) TO authenticated;


--
-- Name: FUNCTION get_my_account_appeal(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_account_appeal() TO anon;
GRANT ALL ON FUNCTION public.get_my_account_appeal() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_account_appeal() TO service_role;


--
-- Name: FUNCTION get_my_points_activity(p_limit integer, p_before timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_points_activity(p_limit integer, p_before timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.get_my_points_activity(p_limit integer, p_before timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.get_my_points_activity(p_limit integer, p_before timestamp with time zone) TO service_role;


--
-- Name: FUNCTION get_my_points_summary(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_points_summary() TO anon;
GRANT ALL ON FUNCTION public.get_my_points_summary() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_points_summary() TO service_role;


--
-- Name: FUNCTION get_or_create_conversation(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_or_create_conversation(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_or_create_conversation(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_or_create_conversation(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_or_create_custom_sector(p_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_or_create_custom_sector(p_name text) TO anon;
GRANT ALL ON FUNCTION public.get_or_create_custom_sector(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.get_or_create_custom_sector(p_name text) TO service_role;


--
-- Name: FUNCTION get_order_buyer_contact(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_order_buyer_contact(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_order_buyer_contact(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_buyer_contact(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION get_order_vendor_payment_details(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_order_vendor_payment_details(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_order_vendor_payment_details(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_vendor_payment_details(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION get_orders_buyer_names(p_order_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_orders_buyer_names(p_order_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_orders_buyer_names(p_order_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_orders_buyer_names(p_order_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_owned_product_variants(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_owned_product_variants(p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_owned_product_variants(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_owned_product_variants(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_owned_product_variants(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION get_package_comment_counts(p_package_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_package_comment_counts(p_package_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_package_comment_counts(p_package_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_package_comment_counts(p_package_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_package_favorite_counts(p_package_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_package_favorite_counts(p_package_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_package_favorite_counts(p_package_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_package_favorite_counts(p_package_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_past_week_winners(p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_past_week_winners(p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_past_week_winners(p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_past_week_winners(p_limit integer) TO service_role;


--
-- Name: FUNCTION get_platform_suggestions(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_platform_suggestions() TO anon;
GRANT ALL ON FUNCTION public.get_platform_suggestions() TO authenticated;
GRANT ALL ON FUNCTION public.get_platform_suggestions() TO service_role;


--
-- Name: FUNCTION get_points_leaderboard(p_period text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_points_leaderboard(p_period text, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_points_leaderboard(p_period text, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_points_leaderboard(p_period text, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_product_comment_counts(p_product_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_product_comment_counts(p_product_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_product_comment_counts(p_product_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_product_comment_counts(p_product_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_product_reviews(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_product_reviews(p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_product_reviews(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_product_reviews(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_product_reviews(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION get_reviewable_order_for_product(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_reviewable_order_for_product(p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_reviewable_order_for_product(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_reviewable_order_for_product(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_reviewable_order_for_product(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION get_service_price_hint(p_listing_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_service_price_hint(p_listing_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_service_price_hint(p_listing_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_service_price_hint(p_listing_id uuid) TO service_role;


--
-- Name: FUNCTION get_shared_ai_conversation(p_token uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_shared_ai_conversation(p_token uuid) TO anon;
GRANT ALL ON FUNCTION public.get_shared_ai_conversation(p_token uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_shared_ai_conversation(p_token uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_commission_breakdown(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_commission_breakdown(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_commission_breakdown(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_commission_breakdown(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_commission_deadline(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_vendor_commission_deadline(p_vendor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_vendor_commission_deadline(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_commission_deadline(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_commission_deadline(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_commission_owed(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_commission_owed(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_commission_owed(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_commission_owed(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_follow_state(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_follow_state(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_follow_state(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_follow_state(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_follow_states(p_vendor_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_follow_states(p_vendor_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_follow_states(p_vendor_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_follow_states(p_vendor_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_vendor_follower_counts(p_vendor_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_vendor_follower_counts(p_vendor_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_vendor_follower_counts(p_vendor_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_follower_counts(p_vendor_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_follower_counts(p_vendor_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_vendor_follower_network(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_follower_network(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_follower_network(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_follower_network(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_followers(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_vendor_followers(p_vendor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_vendor_followers(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_followers(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_followers(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_followers_v2(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_followers_v2(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_followers_v2(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_followers_v2(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_payment_details(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_payment_details(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_payment_details(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_payment_details(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_product_regions(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_product_regions(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_product_regions(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_product_regions(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_spotlight(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_spotlight() TO anon;
GRANT ALL ON FUNCTION public.get_vendor_spotlight() TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_spotlight() TO service_role;


--
-- Name: FUNCTION get_vendor_stats(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_stats(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_vendor_stats(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_stats(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION get_vendor_suggestions(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_vendor_suggestions() TO anon;
GRANT ALL ON FUNCTION public.get_vendor_suggestions() TO authenticated;
GRANT ALL ON FUNCTION public.get_vendor_suggestions() TO service_role;


--
-- Name: FUNCTION guard_unverified_order_completion(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_unverified_order_completion() TO anon;
GRANT ALL ON FUNCTION public.guard_unverified_order_completion() TO authenticated;
GRANT ALL ON FUNCTION public.guard_unverified_order_completion() TO service_role;


--
-- Name: FUNCTION handle_new_levromart_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_levromart_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_levromart_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_levromart_user() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION increment_chat_usage(p_user_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_chat_usage(p_user_id uuid, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.increment_chat_usage(p_user_id uuid, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.increment_chat_usage(p_user_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION increment_product_view(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_product_view(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.increment_product_view(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.increment_product_view(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION increment_tts_usage(p_user_id uuid, p_chars integer, p_daily_char_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_tts_usage(p_user_id uuid, p_chars integer, p_daily_char_limit integer) TO anon;
GRANT ALL ON FUNCTION public.increment_tts_usage(p_user_id uuid, p_chars integer, p_daily_char_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.increment_tts_usage(p_user_id uuid, p_chars integer, p_daily_char_limit integer) TO service_role;


--
-- Name: FUNCTION increment_vendor_profile_view(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_vendor_profile_view(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.increment_vendor_profile_view(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.increment_vendor_profile_view(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;
GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;


--
-- Name: FUNCTION is_blocked_between(a uuid, b uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_blocked_between(a uuid, b uuid) TO anon;
GRANT ALL ON FUNCTION public.is_blocked_between(a uuid, b uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_blocked_between(a uuid, b uuid) TO service_role;


--
-- Name: FUNCTION is_conversation_participant(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_conversation_participant(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_conversation_participant(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_conversation_participant(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION is_vendor_follower(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_vendor_follower(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION is_vendor_owner(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_vendor_owner(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION levro_remove_monthly_submission_on_listing_removal(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.levro_remove_monthly_submission_on_listing_removal() TO anon;
GRANT ALL ON FUNCTION public.levro_remove_monthly_submission_on_listing_removal() TO authenticated;
GRANT ALL ON FUNCTION public.levro_remove_monthly_submission_on_listing_removal() TO service_role;


--
-- Name: FUNCTION levromart_stamp_order_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.levromart_stamp_order_status() TO anon;
GRANT ALL ON FUNCTION public.levromart_stamp_order_status() TO authenticated;
GRANT ALL ON FUNCTION public.levromart_stamp_order_status() TO service_role;


--
-- Name: FUNCTION list_my_chat_lists(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_my_chat_lists() TO anon;
GRANT ALL ON FUNCTION public.list_my_chat_lists() TO authenticated;
GRANT ALL ON FUNCTION public.list_my_chat_lists() TO service_role;


--
-- Name: FUNCTION list_my_conversations(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.list_my_conversations() TO anon;
GRANT ALL ON FUNCTION public.list_my_conversations() TO authenticated;
GRANT ALL ON FUNCTION public.list_my_conversations() TO service_role;


--
-- Name: FUNCTION listing_drafts_touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.listing_drafts_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.listing_drafts_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.listing_drafts_touch_updated_at() TO service_role;


--
-- Name: FUNCTION log_auth_session_start(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_auth_session_start() TO anon;
GRANT ALL ON FUNCTION public.log_auth_session_start() TO authenticated;
GRANT ALL ON FUNCTION public.log_auth_session_start() TO service_role;


--
-- Name: FUNCTION lv_norm_school(p text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lv_norm_school(p text) TO anon;
GRANT ALL ON FUNCTION public.lv_norm_school(p text) TO authenticated;
GRANT ALL ON FUNCTION public.lv_norm_school(p text) TO service_role;


--
-- Name: FUNCTION mark_conversation_opened(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_conversation_opened(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.mark_conversation_opened(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_conversation_opened(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION mark_order_payment_unresolved_from_claim(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_order_payment_unresolved_from_claim() TO anon;
GRANT ALL ON FUNCTION public.mark_order_payment_unresolved_from_claim() TO authenticated;
GRANT ALL ON FUNCTION public.mark_order_payment_unresolved_from_claim() TO service_role;


--
-- Name: FUNCTION mark_suggestion_read(p_suggestion_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_suggestion_read(p_suggestion_id uuid) TO anon;
GRANT ALL ON FUNCTION public.mark_suggestion_read(p_suggestion_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_suggestion_read(p_suggestion_id uuid) TO service_role;


--
-- Name: FUNCTION nearby_vendors(p_lat double precision, p_lng double precision, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.nearby_vendors(p_lat double precision, p_lng double precision, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.nearby_vendors(p_lat double precision, p_lng double precision, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.nearby_vendors(p_lat double precision, p_lng double precision, p_limit integer) TO service_role;


--
-- Name: FUNCTION normalize_commission_for_billing(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_commission_for_billing() TO anon;
GRANT ALL ON FUNCTION public.normalize_commission_for_billing() TO authenticated;
GRANT ALL ON FUNCTION public.normalize_commission_for_billing() TO service_role;


--
-- Name: FUNCTION normalize_order_payment_terms(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_order_payment_terms() TO anon;
GRANT ALL ON FUNCTION public.normalize_order_payment_terms() TO authenticated;
GRANT ALL ON FUNCTION public.normalize_order_payment_terms() TO service_role;


--
-- Name: FUNCTION notify_admins(p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_admins(p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.notify_admins(p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.notify_admins(p_title text, p_body text, p_target_view text, p_target_params jsonb, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION notify_admins_on_action(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_admins_on_action() TO anon;
GRANT ALL ON FUNCTION public.notify_admins_on_action() TO authenticated;
GRANT ALL ON FUNCTION public.notify_admins_on_action() TO service_role;


--
-- Name: FUNCTION notify_comment_mentions(p_kind text, p_item_id uuid, p_comment_id uuid, p_author uuid, p_author_name text, p_author_avatar text, p_content text, p_item_name text, p_skip uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_comment_mentions(p_kind text, p_item_id uuid, p_comment_id uuid, p_author uuid, p_author_name text, p_author_avatar text, p_content text, p_item_name text, p_skip uuid[]) TO anon;
GRANT ALL ON FUNCTION public.notify_comment_mentions(p_kind text, p_item_id uuid, p_comment_id uuid, p_author uuid, p_author_name text, p_author_avatar text, p_content text, p_item_name text, p_skip uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.notify_comment_mentions(p_kind text, p_item_id uuid, p_comment_id uuid, p_author uuid, p_author_name text, p_author_avatar text, p_content text, p_item_name text, p_skip uuid[]) TO service_role;


--
-- Name: FUNCTION notify_email_on_notification(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_email_on_notification() TO anon;
GRANT ALL ON FUNCTION public.notify_email_on_notification() TO authenticated;
GRANT ALL ON FUNCTION public.notify_email_on_notification() TO service_role;


--
-- Name: FUNCTION notify_new_dispute(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_dispute() TO anon;
GRANT ALL ON FUNCTION public.notify_new_dispute() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_dispute() TO service_role;


--
-- Name: FUNCTION notify_new_message(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_message() TO anon;
GRANT ALL ON FUNCTION public.notify_new_message() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_message() TO service_role;


--
-- Name: FUNCTION notify_new_offer(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_offer() TO anon;
GRANT ALL ON FUNCTION public.notify_new_offer() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_offer() TO service_role;


--
-- Name: FUNCTION notify_new_order(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_order() TO anon;
GRANT ALL ON FUNCTION public.notify_new_order() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_order() TO service_role;


--
-- Name: FUNCTION notify_new_request(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_request() TO anon;
GRANT ALL ON FUNCTION public.notify_new_request() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_request() TO service_role;


--
-- Name: FUNCTION notify_new_review(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_review() TO anon;
GRANT ALL ON FUNCTION public.notify_new_review() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_review() TO service_role;


--
-- Name: FUNCTION notify_new_user_signup(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_user_signup() TO anon;
GRANT ALL ON FUNCTION public.notify_new_user_signup() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_user_signup() TO service_role;


--
-- Name: FUNCTION notify_new_vendor_application(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_new_vendor_application() TO anon;
GRANT ALL ON FUNCTION public.notify_new_vendor_application() TO authenticated;
GRANT ALL ON FUNCTION public.notify_new_vendor_application() TO service_role;


--
-- Name: FUNCTION notify_offer_accepted(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_offer_accepted() TO anon;
GRANT ALL ON FUNCTION public.notify_offer_accepted() TO authenticated;
GRANT ALL ON FUNCTION public.notify_offer_accepted() TO service_role;


--
-- Name: FUNCTION notify_order_status_changed(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_order_status_changed() TO anon;
GRANT ALL ON FUNCTION public.notify_order_status_changed() TO authenticated;
GRANT ALL ON FUNCTION public.notify_order_status_changed() TO service_role;


--
-- Name: FUNCTION notify_package_comment_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_package_comment_event() TO anon;
GRANT ALL ON FUNCTION public.notify_package_comment_event() TO authenticated;
GRANT ALL ON FUNCTION public.notify_package_comment_event() TO service_role;


--
-- Name: FUNCTION notify_payment_paid(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_payment_paid() TO anon;
GRANT ALL ON FUNCTION public.notify_payment_paid() TO authenticated;
GRANT ALL ON FUNCTION public.notify_payment_paid() TO service_role;


--
-- Name: FUNCTION notify_points(p_user uuid, p_pts integer, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.notify_points(p_user uuid, p_pts integer, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.notify_points(p_user uuid, p_pts integer, p_note text) TO service_role;


--
-- Name: FUNCTION notify_product_comment_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_product_comment_event() TO anon;
GRANT ALL ON FUNCTION public.notify_product_comment_event() TO authenticated;
GRANT ALL ON FUNCTION public.notify_product_comment_event() TO service_role;


--
-- Name: FUNCTION notify_product_comment_like_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_product_comment_like_event() TO anon;
GRANT ALL ON FUNCTION public.notify_product_comment_like_event() TO authenticated;
GRANT ALL ON FUNCTION public.notify_product_comment_like_event() TO service_role;


--
-- Name: FUNCTION notify_product_favorite_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_product_favorite_event() TO anon;
GRANT ALL ON FUNCTION public.notify_product_favorite_event() TO authenticated;
GRANT ALL ON FUNCTION public.notify_product_favorite_event() TO service_role;


--
-- Name: FUNCTION notify_product_variety_batch(p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.notify_product_variety_batch(p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.notify_product_variety_batch(p_product_id uuid) TO anon;
GRANT ALL ON FUNCTION public.notify_product_variety_batch(p_product_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.notify_product_variety_batch(p_product_id uuid) TO service_role;


--
-- Name: FUNCTION notify_rank_upsert(p_user uuid, p_title text, p_body text, p_meta jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_rank_upsert(p_user uuid, p_title text, p_body text, p_meta jsonb) TO anon;
GRANT ALL ON FUNCTION public.notify_rank_upsert(p_user uuid, p_title text, p_body text, p_meta jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.notify_rank_upsert(p_user uuid, p_title text, p_body text, p_meta jsonb) TO service_role;


--
-- Name: FUNCTION notify_request_cancelled(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_request_cancelled() TO anon;
GRANT ALL ON FUNCTION public.notify_request_cancelled() TO authenticated;
GRANT ALL ON FUNCTION public.notify_request_cancelled() TO service_role;


--
-- Name: FUNCTION notify_variant_followers_batch_aware(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.notify_variant_followers_batch_aware() FROM PUBLIC;
GRANT ALL ON FUNCTION public.notify_variant_followers_batch_aware() TO anon;
GRANT ALL ON FUNCTION public.notify_variant_followers_batch_aware() TO authenticated;
GRANT ALL ON FUNCTION public.notify_variant_followers_batch_aware() TO service_role;


--
-- Name: FUNCTION notify_vendor_application_submitted(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_application_submitted(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.notify_vendor_application_submitted(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.notify_vendor_application_submitted(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION notify_vendor_follow_created(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_follow_created() TO anon;
GRANT ALL ON FUNCTION public.notify_vendor_follow_created() TO authenticated;
GRANT ALL ON FUNCTION public.notify_vendor_follow_created() TO service_role;


--
-- Name: FUNCTION notify_vendor_followers_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_followers_event() TO anon;
GRANT ALL ON FUNCTION public.notify_vendor_followers_event() TO authenticated;
GRANT ALL ON FUNCTION public.notify_vendor_followers_event() TO service_role;


--
-- Name: FUNCTION notify_vendor_low_stock(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_low_stock() TO service_role;


--
-- Name: FUNCTION notify_vendor_on_follow(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_on_follow() TO anon;
GRANT ALL ON FUNCTION public.notify_vendor_on_follow() TO authenticated;
GRANT ALL ON FUNCTION public.notify_vendor_on_follow() TO service_role;


--
-- Name: FUNCTION notify_vendor_payout_setup(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_vendor_payout_setup() TO anon;
GRANT ALL ON FUNCTION public.notify_vendor_payout_setup() TO authenticated;
GRANT ALL ON FUNCTION public.notify_vendor_payout_setup() TO service_role;


--
-- Name: FUNCTION on_user_profile_updated(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.on_user_profile_updated() TO anon;
GRANT ALL ON FUNCTION public.on_user_profile_updated() TO authenticated;
GRANT ALL ON FUNCTION public.on_user_profile_updated() TO service_role;


--
-- Name: FUNCTION on_vendor_profile_updated(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.on_vendor_profile_updated() TO anon;
GRANT ALL ON FUNCTION public.on_vendor_profile_updated() TO authenticated;
GRANT ALL ON FUNCTION public.on_vendor_profile_updated() TO service_role;


--
-- Name: FUNCTION owns_vendor(v_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.owns_vendor(v_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.owns_vendor(v_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.owns_vendor(v_id uuid) TO anon;
GRANT ALL ON FUNCTION public.owns_vendor(v_id uuid) TO authenticated;


--
-- Name: FUNCTION points_award_order(p_order uuid, p_notify boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_award_order(p_order uuid, p_notify boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_award_order(p_order uuid, p_notify boolean) TO service_role;


--
-- Name: FUNCTION points_award_review(p_review uuid, p_notify boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_award_review(p_review uuid, p_notify boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_award_review(p_review uuid, p_notify boolean) TO service_role;


--
-- Name: FUNCTION points_for_new_listing(p_vendor uuid, p_listing uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_for_new_listing(p_vendor uuid, p_listing uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_for_new_listing(p_vendor uuid, p_listing uuid) TO service_role;


--
-- Name: FUNCTION points_log_skip(p_user uuid, p_kind text, p_ref text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_log_skip(p_user uuid, p_kind text, p_ref text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_log_skip(p_user uuid, p_kind text, p_ref text, p_reason text) TO service_role;


--
-- Name: FUNCTION points_reconcile_listings(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_reconcile_listings() FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_reconcile_listings() TO service_role;


--
-- Name: FUNCTION points_revoke_listing(p_vendor uuid, p_listing uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.points_revoke_listing(p_vendor uuid, p_listing uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.points_revoke_listing(p_vendor uuid, p_listing uuid) TO service_role;


--
-- Name: FUNCTION points_week_start(p_ts timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.points_week_start(p_ts timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.points_week_start(p_ts timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.points_week_start(p_ts timestamp with time zone) TO service_role;


--
-- Name: FUNCTION prevent_self_role_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_self_role_change() TO anon;
GRANT ALL ON FUNCTION public.prevent_self_role_change() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_self_role_change() TO service_role;


--
-- Name: FUNCTION prevent_unverified_order_completion(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_unverified_order_completion() TO anon;
GRANT ALL ON FUNCTION public.prevent_unverified_order_completion() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_unverified_order_completion() TO service_role;


--
-- Name: FUNCTION prevent_vendor_activation_with_owed_commission(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_vendor_activation_with_owed_commission() TO anon;
GRANT ALL ON FUNCTION public.prevent_vendor_activation_with_owed_commission() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_vendor_activation_with_owed_commission() TO service_role;


--
-- Name: FUNCTION prevent_vendor_self_cart_item(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_vendor_self_cart_item() TO anon;
GRANT ALL ON FUNCTION public.prevent_vendor_self_cart_item() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_vendor_self_cart_item() TO service_role;


--
-- Name: FUNCTION prevent_vendor_self_order(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_vendor_self_order() TO anon;
GRANT ALL ON FUNCTION public.prevent_vendor_self_order() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_vendor_self_order() TO service_role;


--
-- Name: FUNCTION process_commission_deadline_reminders(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_commission_deadline_reminders() TO anon;
GRANT ALL ON FUNCTION public.process_commission_deadline_reminders() TO authenticated;
GRANT ALL ON FUNCTION public.process_commission_deadline_reminders() TO service_role;


--
-- Name: FUNCTION process_listing_billing_reminders(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.process_listing_billing_reminders() FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_listing_billing_reminders() TO anon;
GRANT ALL ON FUNCTION public.process_listing_billing_reminders() TO authenticated;
GRANT ALL ON FUNCTION public.process_listing_billing_reminders() TO service_role;


--
-- Name: FUNCTION process_payment_unresolved_escalations(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_payment_unresolved_escalations() TO anon;
GRANT ALL ON FUNCTION public.process_payment_unresolved_escalations() TO authenticated;
GRANT ALL ON FUNCTION public.process_payment_unresolved_escalations() TO service_role;


--
-- Name: FUNCTION process_service_offer_deadlines(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.process_service_offer_deadlines() FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_service_offer_deadlines() TO service_role;


--
-- Name: FUNCTION process_vendor_commission_hour_reminders(p_vendor_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_vendor_commission_hour_reminders(p_vendor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.process_vendor_commission_hour_reminders(p_vendor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.process_vendor_commission_hour_reminders(p_vendor_id uuid) TO service_role;


--
-- Name: FUNCTION products_default_category(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.products_default_category() TO anon;
GRANT ALL ON FUNCTION public.products_default_category() TO authenticated;
GRANT ALL ON FUNCTION public.products_default_category() TO service_role;


--
-- Name: FUNCTION raise_dispute(p_order_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION raise_dispute(p_order_id uuid, p_reason text, p_attachments jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text, p_attachments jsonb) TO anon;
GRANT ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text, p_attachments jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.raise_dispute(p_order_id uuid, p_reason text, p_attachments jsonb) TO service_role;


--
-- Name: FUNCTION record_auth_activity(p_event_type text, p_user_agent text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_auth_activity(p_event_type text, p_user_agent text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_auth_activity(p_event_type text, p_user_agent text) TO anon;
GRANT ALL ON FUNCTION public.record_auth_activity(p_event_type text, p_user_agent text) TO authenticated;
GRANT ALL ON FUNCTION public.record_auth_activity(p_event_type text, p_user_agent text) TO service_role;


--
-- Name: FUNCTION record_offline_payment(p_order_id uuid, p_payment_type public.payment_type, p_amount numeric, p_method public.payment_method); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_offline_payment(p_order_id uuid, p_payment_type public.payment_type, p_amount numeric, p_method public.payment_method) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_offline_payment(p_order_id uuid, p_payment_type public.payment_type, p_amount numeric, p_method public.payment_method) TO authenticated;
GRANT ALL ON FUNCTION public.record_offline_payment(p_order_id uuid, p_payment_type public.payment_type, p_amount numeric, p_method public.payment_method) TO service_role;


--
-- Name: FUNCTION record_order_completion_commission(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.record_order_completion_commission() TO anon;
GRANT ALL ON FUNCTION public.record_order_completion_commission() TO authenticated;
GRANT ALL ON FUNCTION public.record_order_completion_commission() TO service_role;


--
-- Name: FUNCTION record_social_click(p_platform text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.record_social_click(p_platform text) TO authenticated;
GRANT ALL ON FUNCTION public.record_social_click(p_platform text) TO service_role;


--
-- Name: FUNCTION remind_unattended_orders(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.remind_unattended_orders() FROM PUBLIC;
GRANT ALL ON FUNCTION public.remind_unattended_orders() TO service_role;


--
-- Name: FUNCTION report_service_offer_payment(p_order_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.report_service_offer_payment(p_order_id uuid, p_amount numeric) TO anon;
GRANT ALL ON FUNCTION public.report_service_offer_payment(p_order_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.report_service_offer_payment(p_order_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION request_manual_password_reset(p_email text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_manual_password_reset(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_manual_password_reset(p_email text) TO anon;
GRANT ALL ON FUNCTION public.request_manual_password_reset(p_email text) TO service_role;
GRANT ALL ON FUNCTION public.request_manual_password_reset(p_email text) TO authenticated;


--
-- Name: FUNCTION require_buyer_phone_for_order(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.require_buyer_phone_for_order() TO anon;
GRANT ALL ON FUNCTION public.require_buyer_phone_for_order() TO authenticated;
GRANT ALL ON FUNCTION public.require_buyer_phone_for_order() TO service_role;


--
-- Name: FUNCTION resolve_account_role(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_account_role(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_account_role(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.resolve_account_role(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION resolve_dispute(p_dispute_id uuid, p_admin_notes text, p_new_order_status public.order_status); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_dispute(p_dispute_id uuid, p_admin_notes text, p_new_order_status public.order_status) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_dispute(p_dispute_id uuid, p_admin_notes text, p_new_order_status public.order_status) TO authenticated;
GRANT ALL ON FUNCTION public.resolve_dispute(p_dispute_id uuid, p_admin_notes text, p_new_order_status public.order_status) TO service_role;


--
-- Name: FUNCTION respond_service_offer(p_offer_id uuid, p_action text, p_price numeric, p_expected_price numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.respond_service_offer(p_offer_id uuid, p_action text, p_price numeric, p_expected_price numeric) TO anon;
GRANT ALL ON FUNCTION public.respond_service_offer(p_offer_id uuid, p_action text, p_price numeric, p_expected_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.respond_service_offer(p_offer_id uuid, p_action text, p_price numeric, p_expected_price numeric) TO service_role;


--
-- Name: FUNCTION restore_product_stock_on_cancelled_sale(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.restore_product_stock_on_cancelled_sale() TO anon;
GRANT ALL ON FUNCTION public.restore_product_stock_on_cancelled_sale() TO authenticated;
GRANT ALL ON FUNCTION public.restore_product_stock_on_cancelled_sale() TO service_role;


--
-- Name: FUNCTION revoke_points(p_user uuid, p_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_points(p_user uuid, p_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_points(p_user uuid, p_key text) TO service_role;


--
-- Name: FUNCTION ring_callee_again(p_call_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ring_callee_again(p_call_id uuid) TO anon;
GRANT ALL ON FUNCTION public.ring_callee_again(p_call_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ring_callee_again(p_call_id uuid) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION save_product_variants(p_product_id uuid, p_variants jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb) TO anon;
GRANT ALL ON FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb) TO service_role;


--
-- Name: FUNCTION search_ai_conversations(p_query text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_ai_conversations(p_query text) TO anon;
GRANT ALL ON FUNCTION public.search_ai_conversations(p_query text) TO authenticated;
GRANT ALL ON FUNCTION public.search_ai_conversations(p_query text) TO service_role;


--
-- Name: FUNCTION search_product_ids(p_query text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_product_ids(p_query text) TO anon;
GRANT ALL ON FUNCTION public.search_product_ids(p_query text) TO authenticated;
GRANT ALL ON FUNCTION public.search_product_ids(p_query text) TO service_role;


--
-- Name: FUNCTION search_products_full(p_query text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_products_full(p_query text, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.search_products_full(p_query text, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_products_full(p_query text, p_limit integer) TO service_role;


--
-- Name: FUNCTION search_products_full_v2(p_query text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_products_full_v2(p_query text, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.search_products_full_v2(p_query text, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_products_full_v2(p_query text, p_limit integer) TO service_role;


--
-- Name: FUNCTION send_background_reminders(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.send_background_reminders() TO anon;
GRANT ALL ON FUNCTION public.send_background_reminders() TO authenticated;
GRANT ALL ON FUNCTION public.send_background_reminders() TO service_role;


--
-- Name: FUNCTION send_order_reminder(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.send_order_reminder(p_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.send_order_reminder(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.send_order_reminder(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.send_order_reminder(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION set_ai_conversation_shared(p_conversation_id uuid, p_shared boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_ai_conversation_shared(p_conversation_id uuid, p_shared boolean) TO anon;
GRANT ALL ON FUNCTION public.set_ai_conversation_shared(p_conversation_id uuid, p_shared boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_ai_conversation_shared(p_conversation_id uuid, p_shared boolean) TO service_role;


--
-- Name: FUNCTION set_homepage_carousel_slides_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_homepage_carousel_slides_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_homepage_carousel_slides_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_homepage_carousel_slides_updated_at() TO service_role;


--
-- Name: FUNCTION set_order_buyer_location(p_order_id uuid, p_lat double precision, p_lng double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_order_buyer_location(p_order_id uuid, p_lat double precision, p_lng double precision) TO anon;
GRANT ALL ON FUNCTION public.set_order_buyer_location(p_order_id uuid, p_lat double precision, p_lng double precision) TO authenticated;
GRANT ALL ON FUNCTION public.set_order_buyer_location(p_order_id uuid, p_lat double precision, p_lng double precision) TO service_role;


--
-- Name: FUNCTION set_order_buyer_note(p_order_id uuid, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_order_buyer_note(p_order_id uuid, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_order_buyer_note(p_order_id uuid, p_note text) TO anon;
GRANT ALL ON FUNCTION public.set_order_buyer_note(p_order_id uuid, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.set_order_buyer_note(p_order_id uuid, p_note text) TO service_role;


--
-- Name: FUNCTION set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text) TO anon;
GRANT ALL ON FUNCTION public.set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text) TO authenticated;
GRANT ALL ON FUNCTION public.set_order_item_variant(p_order_id uuid, p_product_id uuid, p_variant_name text, p_variant_color text) TO service_role;


--
-- Name: FUNCTION set_request_buyer_snapshot(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_request_buyer_snapshot() TO anon;
GRANT ALL ON FUNCTION public.set_request_buyer_snapshot() TO authenticated;
GRANT ALL ON FUNCTION public.set_request_buyer_snapshot() TO service_role;


--
-- Name: FUNCTION set_review_buyer_snapshot(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_review_buyer_snapshot() TO anon;
GRANT ALL ON FUNCTION public.set_review_buyer_snapshot() TO authenticated;
GRANT ALL ON FUNCTION public.set_review_buyer_snapshot() TO service_role;


--
-- Name: FUNCTION set_updated_at_timestamp(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at_timestamp() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at_timestamp() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at_timestamp() TO service_role;


--
-- Name: FUNCTION set_vendor_billing_model(p_billing_model text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_vendor_billing_model(p_billing_model text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_vendor_billing_model(p_billing_model text) TO anon;
GRANT ALL ON FUNCTION public.set_vendor_billing_model(p_billing_model text) TO authenticated;
GRANT ALL ON FUNCTION public.set_vendor_billing_model(p_billing_model text) TO service_role;


--
-- Name: TABLE vendor_follow_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_follow_preferences TO anon;
GRANT ALL ON TABLE public.vendor_follow_preferences TO authenticated;
GRANT ALL ON TABLE public.vendor_follow_preferences TO service_role;


--
-- Name: FUNCTION set_vendor_follow_preferences(p_vendor_id uuid, p_mute_mode text, p_notify_new_listing boolean, p_notify_new_service boolean, p_notify_new_package boolean, p_notify_new_variety boolean, p_notify_price_change boolean, p_notify_discount boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_vendor_follow_preferences(p_vendor_id uuid, p_mute_mode text, p_notify_new_listing boolean, p_notify_new_service boolean, p_notify_new_package boolean, p_notify_new_variety boolean, p_notify_price_change boolean, p_notify_discount boolean) TO anon;
GRANT ALL ON FUNCTION public.set_vendor_follow_preferences(p_vendor_id uuid, p_mute_mode text, p_notify_new_listing boolean, p_notify_new_service boolean, p_notify_new_package boolean, p_notify_new_variety boolean, p_notify_price_change boolean, p_notify_discount boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_vendor_follow_preferences(p_vendor_id uuid, p_mute_mode text, p_notify_new_listing boolean, p_notify_new_service boolean, p_notify_new_package boolean, p_notify_new_variety boolean, p_notify_price_change boolean, p_notify_discount boolean) TO service_role;


--
-- Name: FUNCTION snapshot_product_comment_author(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.snapshot_product_comment_author() TO anon;
GRANT ALL ON FUNCTION public.snapshot_product_comment_author() TO authenticated;
GRANT ALL ON FUNCTION public.snapshot_product_comment_author() TO service_role;


--
-- Name: FUNCTION start_voice_call(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.start_voice_call(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.start_voice_call(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.start_voice_call(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION submit_account_appeal(p_message text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.submit_account_appeal(p_message text) TO anon;
GRANT ALL ON FUNCTION public.submit_account_appeal(p_message text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_account_appeal(p_message text) TO service_role;


--
-- Name: FUNCTION submit_campus_school(p_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.submit_campus_school(p_name text) TO anon;
GRANT ALL ON FUNCTION public.submit_campus_school(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_campus_school(p_name text) TO service_role;


--
-- Name: FUNCTION submit_face_check(p_selfie_url text, p_distance real, p_match text, p_liveness boolean, p_ocr_matric boolean, p_ocr_name boolean, p_ocr_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.submit_face_check(p_selfie_url text, p_distance real, p_match text, p_liveness boolean, p_ocr_matric boolean, p_ocr_name boolean, p_ocr_text text) TO anon;
GRANT ALL ON FUNCTION public.submit_face_check(p_selfie_url text, p_distance real, p_match text, p_liveness boolean, p_ocr_matric boolean, p_ocr_name boolean, p_ocr_text text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_face_check(p_selfie_url text, p_distance real, p_match text, p_liveness boolean, p_ocr_matric boolean, p_ocr_name boolean, p_ocr_text text) TO service_role;


--
-- Name: FUNCTION submit_monthly_listing_payment(p_kind text, p_listing_id uuid, p_payer_name text, p_receipt_path text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.submit_monthly_listing_payment(p_kind text, p_listing_id uuid, p_payer_name text, p_receipt_path text) TO anon;
GRANT ALL ON FUNCTION public.submit_monthly_listing_payment(p_kind text, p_listing_id uuid, p_payer_name text, p_receipt_path text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_monthly_listing_payment(p_kind text, p_listing_id uuid, p_payer_name text, p_receipt_path text) TO service_role;


--
-- Name: FUNCTION submit_suggestion(p_target_type text, p_target_vendor_id uuid, p_message text, p_is_anonymous boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.submit_suggestion(p_target_type text, p_target_vendor_id uuid, p_message text, p_is_anonymous boolean) TO anon;
GRANT ALL ON FUNCTION public.submit_suggestion(p_target_type text, p_target_vendor_id uuid, p_message text, p_is_anonymous boolean) TO authenticated;
GRANT ALL ON FUNCTION public.submit_suggestion(p_target_type text, p_target_vendor_id uuid, p_message text, p_is_anonymous boolean) TO service_role;


--
-- Name: FUNCTION submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text, p_city text, p_phone text, p_whatsapp text, p_cac_number text, p_bio text, p_bank_code text, p_bank_name text, p_account_name text, p_account_number text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text, p_city text, p_phone text, p_whatsapp text, p_cac_number text, p_bio text, p_bank_code text, p_bank_name text, p_account_name text, p_account_number text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text, p_city text, p_phone text, p_whatsapp text, p_cac_number text, p_bio text, p_bank_code text, p_bank_name text, p_account_name text, p_account_number text) TO anon;
GRANT ALL ON FUNCTION public.submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text, p_city text, p_phone text, p_whatsapp text, p_cac_number text, p_bio text, p_bank_code text, p_bank_name text, p_account_name text, p_account_number text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_vendor_application(p_sector_id uuid, p_business_name text, p_address text, p_city text, p_phone text, p_whatsapp text, p_cac_number text, p_bio text, p_bank_code text, p_bank_name text, p_account_name text, p_account_number text) TO service_role;


--
-- Name: FUNCTION sync_current_account_role(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_current_account_role() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_current_account_role() TO authenticated;
GRANT ALL ON FUNCTION public.sync_current_account_role() TO service_role;


--
-- Name: FUNCTION sync_order_payment_deposit_percent_from_item(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_order_payment_deposit_percent_from_item() TO anon;
GRANT ALL ON FUNCTION public.sync_order_payment_deposit_percent_from_item() TO authenticated;
GRANT ALL ON FUNCTION public.sync_order_payment_deposit_percent_from_item() TO service_role;


--
-- Name: FUNCTION sync_role_from_vendor_row(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_role_from_vendor_row() TO anon;
GRANT ALL ON FUNCTION public.sync_role_from_vendor_row() TO authenticated;
GRANT ALL ON FUNCTION public.sync_role_from_vendor_row() TO service_role;


--
-- Name: FUNCTION sync_vendor_avatar_from_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_vendor_avatar_from_user() TO anon;
GRANT ALL ON FUNCTION public.sync_vendor_avatar_from_user() TO authenticated;
GRANT ALL ON FUNCTION public.sync_vendor_avatar_from_user() TO service_role;


--
-- Name: FUNCTION sync_vendor_profile_avatar(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_vendor_profile_avatar() TO anon;
GRANT ALL ON FUNCTION public.sync_vendor_profile_avatar() TO authenticated;
GRANT ALL ON FUNCTION public.sync_vendor_profile_avatar() TO service_role;


--
-- Name: FUNCTION sync_vendor_review_stats(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_vendor_review_stats() TO anon;
GRANT ALL ON FUNCTION public.sync_vendor_review_stats() TO authenticated;
GRANT ALL ON FUNCTION public.sync_vendor_review_stats() TO service_role;


--
-- Name: FUNCTION toggle_ai_message_reaction(p_message_id uuid, p_emoji text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_ai_message_reaction(p_message_id uuid, p_emoji text) TO anon;
GRANT ALL ON FUNCTION public.toggle_ai_message_reaction(p_message_id uuid, p_emoji text) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_ai_message_reaction(p_message_id uuid, p_emoji text) TO service_role;


--
-- Name: FUNCTION toggle_conversation_in_list(p_list_id uuid, p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_conversation_in_list(p_list_id uuid, p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.toggle_conversation_in_list(p_list_id uuid, p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_conversation_in_list(p_list_id uuid, p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION toggle_conversation_pin(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_conversation_pin(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.toggle_conversation_pin(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_conversation_pin(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION toggle_conversation_unread(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_conversation_unread(p_conversation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.toggle_conversation_unread(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_conversation_unread(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION toggle_message_reaction(p_message_id uuid, p_emoji text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) TO anon;
GRANT ALL ON FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) TO service_role;


--
-- Name: FUNCTION toggle_vendor_follow(p_vendor_id uuid, p_following boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_vendor_follow(p_vendor_id uuid, p_following boolean) TO anon;
GRANT ALL ON FUNCTION public.toggle_vendor_follow(p_vendor_id uuid, p_following boolean) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_vendor_follow(p_vendor_id uuid, p_following boolean) TO service_role;


--
-- Name: FUNCTION touch_ai_conversation(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_ai_conversation() TO anon;
GRANT ALL ON FUNCTION public.touch_ai_conversation() TO authenticated;
GRANT ALL ON FUNCTION public.touch_ai_conversation() TO service_role;


--
-- Name: FUNCTION touch_last_seen(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_last_seen() TO anon;
GRANT ALL ON FUNCTION public.touch_last_seen() TO authenticated;
GRANT ALL ON FUNCTION public.touch_last_seen() TO service_role;


--
-- Name: FUNCTION touch_presence(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_presence() FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_presence() TO authenticated;
GRANT ALL ON FUNCTION public.touch_presence() TO service_role;


--
-- Name: FUNCTION touch_service_offer_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_service_offer_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_service_offer_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_service_offer_updated_at() TO service_role;


--
-- Name: FUNCTION touch_support_request_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_support_request_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_support_request_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_support_request_updated_at() TO service_role;


--
-- Name: FUNCTION transition_order_status(p_order_id uuid, p_new_status public.order_status); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.transition_order_status(p_order_id uuid, p_new_status public.order_status) FROM PUBLIC;
GRANT ALL ON FUNCTION public.transition_order_status(p_order_id uuid, p_new_status public.order_status) TO authenticated;
GRANT ALL ON FUNCTION public.transition_order_status(p_order_id uuid, p_new_status public.order_status) TO service_role;


--
-- Name: FUNCTION trg_apply_signup_referral(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_apply_signup_referral() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_apply_signup_referral() TO service_role;


--
-- Name: FUNCTION trg_points_follow(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_points_follow() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_points_follow() TO service_role;


--
-- Name: FUNCTION trg_points_listing(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_points_listing() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_points_listing() TO service_role;


--
-- Name: FUNCTION trg_points_order(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_points_order() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_points_order() TO service_role;


--
-- Name: FUNCTION trg_points_rank_notify(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_points_rank_notify() TO anon;
GRANT ALL ON FUNCTION public.trg_points_rank_notify() TO authenticated;
GRANT ALL ON FUNCTION public.trg_points_rank_notify() TO service_role;


--
-- Name: FUNCTION trg_points_review(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_points_review() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_points_review() TO service_role;


--
-- Name: FUNCTION trg_points_vendor(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_points_vendor() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_points_vendor() TO service_role;


--
-- Name: FUNCTION trg_vendor_referral_code(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_vendor_referral_code() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_vendor_referral_code() TO service_role;


--
-- Name: FUNCTION update_voice_call(p_call_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_voice_call(p_call_id uuid, p_status text) TO anon;
GRANT ALL ON FUNCTION public.update_voice_call(p_call_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.update_voice_call(p_call_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION users_campus_to_vendor(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.users_campus_to_vendor() TO anon;
GRANT ALL ON FUNCTION public.users_campus_to_vendor() TO authenticated;
GRANT ALL ON FUNCTION public.users_campus_to_vendor() TO service_role;


--
-- Name: FUNCTION validate_referral_code(p_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_referral_code(p_code text) TO anon;
GRANT ALL ON FUNCTION public.validate_referral_code(p_code text) TO authenticated;
GRANT ALL ON FUNCTION public.validate_referral_code(p_code text) TO service_role;


--
-- Name: FUNCTION validate_vendor_phone_numbers(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_vendor_phone_numbers() TO anon;
GRANT ALL ON FUNCTION public.validate_vendor_phone_numbers() TO authenticated;
GRANT ALL ON FUNCTION public.validate_vendor_phone_numbers() TO service_role;


--
-- Name: FUNCTION vendor_confirm_reported_payment(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_confirm_reported_payment(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.vendor_confirm_reported_payment(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_confirm_reported_payment(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION vendor_confirm_unreported_payment(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_confirm_unreported_payment(p_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.vendor_confirm_unreported_payment(p_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_confirm_unreported_payment(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION vendor_decline_order(p_order_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_decline_order(p_order_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.vendor_decline_order(p_order_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_decline_order(p_order_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION vendor_dispute_reported_payment(p_order_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_dispute_reported_payment(p_order_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.vendor_dispute_reported_payment(p_order_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_dispute_reported_payment(p_order_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION vendor_dispute_unreported_payment(p_order_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_dispute_unreported_payment(p_order_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.vendor_dispute_unreported_payment(p_order_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_dispute_unreported_payment(p_order_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION vendor_respond_to_dispute(p_dispute_id uuid, p_response text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_respond_to_dispute(p_dispute_id uuid, p_response text) TO anon;
GRANT ALL ON FUNCTION public.vendor_respond_to_dispute(p_dispute_id uuid, p_response text) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_respond_to_dispute(p_dispute_id uuid, p_response text) TO service_role;


--
-- Name: FUNCTION vendor_set_storefront_active(p_active boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_set_storefront_active(p_active boolean) TO anon;
GRANT ALL ON FUNCTION public.vendor_set_storefront_active(p_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_set_storefront_active(p_active boolean) TO service_role;


--
-- Name: FUNCTION vendor_suggest_order_quantity(p_order_id uuid, p_items jsonb, p_note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendor_suggest_order_quantity(p_order_id uuid, p_items jsonb, p_note text) TO anon;
GRANT ALL ON FUNCTION public.vendor_suggest_order_quantity(p_order_id uuid, p_items jsonb, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.vendor_suggest_order_quantity(p_order_id uuid, p_items jsonb, p_note text) TO service_role;


--
-- Name: FUNCTION vendors_default_campus(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vendors_default_campus() TO anon;
GRANT ALL ON FUNCTION public.vendors_default_campus() TO authenticated;
GRANT ALL ON FUNCTION public.vendors_default_campus() TO service_role;


--
-- Name: TABLE account_appeals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.account_appeals TO anon;
GRANT ALL ON TABLE public.account_appeals TO authenticated;
GRANT ALL ON TABLE public.account_appeals TO service_role;


--
-- Name: TABLE admin_actions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_actions TO anon;
GRANT ALL ON TABLE public.admin_actions TO authenticated;
GRANT ALL ON TABLE public.admin_actions TO service_role;


--
-- Name: TABLE admin_login_otps; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_login_otps TO anon;
GRANT ALL ON TABLE public.admin_login_otps TO authenticated;
GRANT ALL ON TABLE public.admin_login_otps TO service_role;


--
-- Name: TABLE ai_conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_conversations TO anon;
GRANT ALL ON TABLE public.ai_conversations TO authenticated;
GRANT ALL ON TABLE public.ai_conversations TO service_role;


--
-- Name: TABLE ai_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_messages TO anon;
GRANT ALL ON TABLE public.ai_messages TO authenticated;
GRANT ALL ON TABLE public.ai_messages TO service_role;


--
-- Name: TABLE app_presence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_presence TO anon;
GRANT ALL ON TABLE public.app_presence TO authenticated;
GRANT ALL ON TABLE public.app_presence TO service_role;


--
-- Name: TABLE auth_activity_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.auth_activity_logs TO anon;
GRANT ALL ON TABLE public.auth_activity_logs TO authenticated;
GRANT ALL ON TABLE public.auth_activity_logs TO service_role;


--
-- Name: TABLE blocked_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blocked_users TO anon;
GRANT ALL ON TABLE public.blocked_users TO authenticated;
GRANT ALL ON TABLE public.blocked_users TO service_role;


--
-- Name: TABLE bookings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bookings TO anon;
GRANT ALL ON TABLE public.bookings TO authenticated;
GRANT ALL ON TABLE public.bookings TO service_role;


--
-- Name: TABLE campus_submissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.campus_submissions TO anon;
GRANT ALL ON TABLE public.campus_submissions TO authenticated;
GRANT ALL ON TABLE public.campus_submissions TO service_role;


--
-- Name: TABLE cart_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cart_items TO anon;
GRANT ALL ON TABLE public.cart_items TO authenticated;
GRANT ALL ON TABLE public.cart_items TO service_role;


--
-- Name: TABLE categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.categories TO anon;
GRANT ALL ON TABLE public.categories TO authenticated;
GRANT ALL ON TABLE public.categories TO service_role;


--
-- Name: TABLE chat_archive; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_archive TO anon;
GRANT ALL ON TABLE public.chat_archive TO authenticated;
GRANT ALL ON TABLE public.chat_archive TO service_role;


--
-- Name: TABLE chat_list_conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_list_conversations TO anon;
GRANT ALL ON TABLE public.chat_list_conversations TO authenticated;
GRANT ALL ON TABLE public.chat_list_conversations TO service_role;


--
-- Name: TABLE chat_lists; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_lists TO anon;
GRANT ALL ON TABLE public.chat_lists TO authenticated;
GRANT ALL ON TABLE public.chat_lists TO service_role;


--
-- Name: TABLE chat_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_usage TO anon;
GRANT ALL ON TABLE public.chat_usage TO authenticated;
GRANT ALL ON TABLE public.chat_usage TO service_role;


--
-- Name: TABLE comment_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.comment_reports TO anon;
GRANT ALL ON TABLE public.comment_reports TO authenticated;
GRANT ALL ON TABLE public.comment_reports TO service_role;


--
-- Name: TABLE commission_charges; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_charges TO anon;
GRANT ALL ON TABLE public.commission_charges TO authenticated;
GRANT ALL ON TABLE public.commission_charges TO service_role;


--
-- Name: TABLE commission_deadline_reminders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_deadline_reminders TO anon;
GRANT ALL ON TABLE public.commission_deadline_reminders TO authenticated;
GRANT ALL ON TABLE public.commission_deadline_reminders TO service_role;


--
-- Name: TABLE commission_settlements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_settlements TO anon;
GRANT ALL ON TABLE public.commission_settlements TO authenticated;
GRANT ALL ON TABLE public.commission_settlements TO service_role;


--
-- Name: TABLE conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;


--
-- Name: TABLE disputes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.disputes TO anon;
GRANT ALL ON TABLE public.disputes TO authenticated;
GRANT ALL ON TABLE public.disputes TO service_role;


--
-- Name: TABLE equipment_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.equipment_requests TO anon;
GRANT ALL ON TABLE public.equipment_requests TO authenticated;
GRANT ALL ON TABLE public.equipment_requests TO service_role;


--
-- Name: TABLE favorites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.favorites TO anon;
GRANT ALL ON TABLE public.favorites TO authenticated;
GRANT ALL ON TABLE public.favorites TO service_role;


--
-- Name: TABLE homepage_carousel_slides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.homepage_carousel_slides TO anon;
GRANT ALL ON TABLE public.homepage_carousel_slides TO authenticated;
GRANT ALL ON TABLE public.homepage_carousel_slides TO service_role;


--
-- Name: TABLE inventory; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.inventory TO anon;
GRANT ALL ON TABLE public.inventory TO authenticated;
GRANT ALL ON TABLE public.inventory TO service_role;


--
-- Name: TABLE listing_billing_reminders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.listing_billing_reminders TO anon;
GRANT ALL ON TABLE public.listing_billing_reminders TO authenticated;
GRANT ALL ON TABLE public.listing_billing_reminders TO service_role;


--
-- Name: TABLE listing_drafts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.listing_drafts TO anon;
GRANT ALL ON TABLE public.listing_drafts TO authenticated;
GRANT ALL ON TABLE public.listing_drafts TO service_role;


--
-- Name: TABLE listing_payment_intents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.listing_payment_intents TO anon;
GRANT ALL ON TABLE public.listing_payment_intents TO authenticated;
GRANT ALL ON TABLE public.listing_payment_intents TO service_role;


--
-- Name: TABLE message_pins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_pins TO anon;
GRANT ALL ON TABLE public.message_pins TO authenticated;
GRANT ALL ON TABLE public.message_pins TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;


--
-- Name: TABLE monthly_listing_submissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_listing_submissions TO anon;
GRANT ALL ON TABLE public.monthly_listing_submissions TO authenticated;
GRANT ALL ON TABLE public.monthly_listing_submissions TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notifications TO anon;
GRANT ALL ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: TABLE order_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_items TO anon;
GRANT ALL ON TABLE public.order_items TO authenticated;
GRANT ALL ON TABLE public.order_items TO service_role;


--
-- Name: TABLE order_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_notes TO anon;
GRANT ALL ON TABLE public.order_notes TO authenticated;
GRANT ALL ON TABLE public.order_notes TO service_role;


--
-- Name: TABLE orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.orders TO anon;
GRANT ALL ON TABLE public.orders TO authenticated;
GRANT ALL ON TABLE public.orders TO service_role;


--
-- Name: TABLE package_comment_likes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.package_comment_likes TO anon;
GRANT ALL ON TABLE public.package_comment_likes TO authenticated;
GRANT ALL ON TABLE public.package_comment_likes TO service_role;


--
-- Name: TABLE package_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.package_comments TO anon;
GRANT ALL ON TABLE public.package_comments TO authenticated;
GRANT ALL ON TABLE public.package_comments TO service_role;


--
-- Name: TABLE package_engagement_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.package_engagement_settings TO anon;
GRANT ALL ON TABLE public.package_engagement_settings TO authenticated;
GRANT ALL ON TABLE public.package_engagement_settings TO service_role;


--
-- Name: TABLE package_favorites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.package_favorites TO anon;
GRANT ALL ON TABLE public.package_favorites TO authenticated;
GRANT ALL ON TABLE public.package_favorites TO service_role;


--
-- Name: TABLE package_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.package_items TO anon;
GRANT ALL ON TABLE public.package_items TO authenticated;
GRANT ALL ON TABLE public.package_items TO service_role;


--
-- Name: TABLE password_reset_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.password_reset_requests TO service_role;


--
-- Name: TABLE payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payments TO anon;
GRANT ALL ON TABLE public.payments TO authenticated;
GRANT ALL ON TABLE public.payments TO service_role;


--
-- Name: TABLE points_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.points_ledger TO anon;
GRANT ALL ON TABLE public.points_ledger TO authenticated;
GRANT ALL ON TABLE public.points_ledger TO service_role;


--
-- Name: TABLE points_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.points_rules TO anon;
GRANT ALL ON TABLE public.points_rules TO authenticated;
GRANT ALL ON TABLE public.points_rules TO service_role;


--
-- Name: TABLE points_skips; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.points_skips TO anon;
GRANT ALL ON TABLE public.points_skips TO authenticated;
GRANT ALL ON TABLE public.points_skips TO service_role;


--
-- Name: TABLE points_weekly; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.points_weekly TO anon;
GRANT ALL ON TABLE public.points_weekly TO authenticated;
GRANT ALL ON TABLE public.points_weekly TO service_role;


--
-- Name: TABLE product_comment_likes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_comment_likes TO anon;
GRANT ALL ON TABLE public.product_comment_likes TO authenticated;
GRANT ALL ON TABLE public.product_comment_likes TO service_role;


--
-- Name: TABLE product_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_comments TO anon;
GRANT ALL ON TABLE public.product_comments TO authenticated;
GRANT ALL ON TABLE public.product_comments TO service_role;


--
-- Name: TABLE product_engagement_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_engagement_settings TO anon;
GRANT ALL ON TABLE public.product_engagement_settings TO authenticated;
GRANT ALL ON TABLE public.product_engagement_settings TO service_role;


--
-- Name: TABLE reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reviews TO anon;
GRANT ALL ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;


--
-- Name: TABLE product_rating_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_rating_stats TO anon;
GRANT ALL ON TABLE public.product_rating_stats TO authenticated;
GRANT ALL ON TABLE public.product_rating_stats TO service_role;


--
-- Name: TABLE product_variants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_variants TO anon;
GRANT ALL ON TABLE public.product_variants TO authenticated;
GRANT ALL ON TABLE public.product_variants TO service_role;


--
-- Name: TABLE products; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.products TO anon;
GRANT ALL ON TABLE public.products TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;


--
-- Name: TABLE push_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.push_subscriptions TO anon;
GRANT ALL ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;


--
-- Name: TABLE referrals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.referrals TO anon;
GRANT ALL ON TABLE public.referrals TO authenticated;
GRANT ALL ON TABLE public.referrals TO service_role;


--
-- Name: TABLE request_offers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.request_offers TO anon;
GRANT ALL ON TABLE public.request_offers TO authenticated;
GRANT ALL ON TABLE public.request_offers TO service_role;


--
-- Name: TABLE search_synonyms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_synonyms TO anon;
GRANT ALL ON TABLE public.search_synonyms TO authenticated;
GRANT ALL ON TABLE public.search_synonyms TO service_role;


--
-- Name: TABLE sectors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sectors TO anon;
GRANT ALL ON TABLE public.sectors TO authenticated;
GRANT ALL ON TABLE public.sectors TO service_role;


--
-- Name: TABLE service_offers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.service_offers TO service_role;
GRANT SELECT ON TABLE public.service_offers TO authenticated;


--
-- Name: TABLE suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.suggestions TO anon;
GRANT ALL ON TABLE public.suggestions TO authenticated;
GRANT ALL ON TABLE public.suggestions TO service_role;


--
-- Name: TABLE support_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_requests TO authenticated;
GRANT ALL ON TABLE public.support_requests TO service_role;


--
-- Name: TABLE tts_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tts_usage TO anon;
GRANT ALL ON TABLE public.tts_usage TO authenticated;
GRANT ALL ON TABLE public.tts_usage TO service_role;


--
-- Name: TABLE user_presence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_presence TO anon;
GRANT ALL ON TABLE public.user_presence TO authenticated;
GRANT ALL ON TABLE public.user_presence TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.users TO anon;
GRANT ALL ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;


--
-- Name: TABLE vendor_follows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_follows TO anon;
GRANT ALL ON TABLE public.vendor_follows TO authenticated;
GRANT ALL ON TABLE public.vendor_follows TO service_role;


--
-- Name: TABLE vendor_monthly_charges; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_monthly_charges TO anon;
GRANT ALL ON TABLE public.vendor_monthly_charges TO authenticated;
GRANT ALL ON TABLE public.vendor_monthly_charges TO service_role;


--
-- Name: TABLE vendor_packages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_packages TO anon;
GRANT ALL ON TABLE public.vendor_packages TO authenticated;
GRANT ALL ON TABLE public.vendor_packages TO service_role;


--
-- Name: TABLE vendor_profile_view_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_profile_view_events TO anon;
GRANT ALL ON TABLE public.vendor_profile_view_events TO authenticated;
GRANT ALL ON TABLE public.vendor_profile_view_events TO service_role;


--
-- Name: SEQUENCE vendor_profile_view_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.vendor_profile_view_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.vendor_profile_view_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.vendor_profile_view_events_id_seq TO service_role;


--
-- Name: TABLE vendor_recycle_bin; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_recycle_bin TO service_role;


--
-- Name: TABLE vendor_student_verification; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_student_verification TO anon;
GRANT ALL ON TABLE public.vendor_student_verification TO authenticated;
GRANT ALL ON TABLE public.vendor_student_verification TO service_role;


--
-- Name: TABLE vendor_week_winners; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendor_week_winners TO anon;
GRANT ALL ON TABLE public.vendor_week_winners TO authenticated;
GRANT ALL ON TABLE public.vendor_week_winners TO service_role;


--
-- Name: TABLE vendors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vendors TO anon;
GRANT ALL ON TABLE public.vendors TO authenticated;
GRANT ALL ON TABLE public.vendors TO service_role;


--
-- Name: TABLE voice_calls; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voice_calls TO anon;
GRANT ALL ON TABLE public.voice_calls TO authenticated;
GRANT ALL ON TABLE public.voice_calls TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

