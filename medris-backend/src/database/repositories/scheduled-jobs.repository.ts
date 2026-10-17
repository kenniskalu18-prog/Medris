import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRows } from "../json.js";

/**
 * The rows and state changes behind the database's scheduled jobs (pg_cron). Each job's orchestration
 * (loops and notifications) is in ScheduledJobsService; the queries here are the jobs' own, verbatim.
 * Every selection that the original locked is locked the same way, inside the job's one transaction.
 */
export class ScheduledJobsRepository {
  constructor(private readonly db: Executor) {}

  // ----- auto_cancel_unconfirmed_orders -----

  /** Pending orders older than 30 minutes, locked (skipping orders another worker holds). */
  unconfirmedOrders(): Promise<{ id: string; buyer_id: string | null; vendor_user_id: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select o.id, o.buyer_id, v.user_id as vendor_user_id
          from public.orders o join public.vendors v on v.id = o.vendor_id
          where o.status = 'pending' and o.created_at <= now() - interval '30 minutes'
          for update of o skip locked`,
    );
  }

  /** Cancels a still-pending order; false if it is no longer pending. */
  async cancelUnconfirmed(orderId: string): Promise<boolean> {
    const done = await jsonReturning(
      this.db,
      sql`update public.orders set status = 'cancelled', cancelled_at = now(),
                 cancellation_reason = 'Cancelled automatically: the vendor did not confirm within 30 minutes'
          where id = ${orderId} and status = 'pending'
          returning id`,
    );
    return done.length > 0;
  }

  // ----- auto_complete_eligible_orders -----

  /** Orders whose 24-hour confirmation window has passed with everything paid and no open dispute, locked. */
  completableOrders(): Promise<{ id: string; buyer_id: string | null; vendor_id: string }[]> {
    return jsonRows(
      this.db,
      sql`select o.id, o.buyer_id, o.vendor_id from public.orders o
          where o.status in ('confirmed','handed_over') and o.awaiting_confirmation_since is not null
            and o.awaiting_confirmation_since < now() - interval '24 hours'
            and o.order_type <> 'rental' and o.service_offer_id is null
            and coalesce(o.payout_status, 'not_applicable') = 'not_applicable'
            and exists (select 1 from public.payments p where p.order_id = o.id and p.payment_type in ('sale_price','rental_fee') and p.status = 'paid')
            and (not (o.delivery_method = 'delivery' and o.payment_timing = 'pay_after')
                 or exists (select 1 from public.payments p where p.order_id = o.id and p.payment_type = 'delivery_deposit_20' and p.status = 'paid'))
            and not exists (select 1 from public.disputes d where d.order_id = o.id and d.status = 'open')
          for update of o skip locked`,
    );
  }

  async autoComplete(orderId: string): Promise<void> {
    await this.db.execute(sql`
      update public.orders set status = 'completed'::public.order_status, completed_at = coalesce(completed_at, now()),
             auto_completed_at = now(), awaiting_confirmation_since = null
      where id = ${orderId}`);
  }

  // ----- escalate_unresolved_payment_orders -----

  /** Orders whose reported payment the vendor has left unanswered for 24 hours, oldest first, locked. */
  unresolvedPayments(): Promise<{ id: string; buyer_id: string | null; vendor_id: string | null; vendor_name: string | null; buyer_name: string | null; payment_id: string }[]> {
    return jsonRows(
      this.db,
      sql`select o.id, o.buyer_id, o.vendor_id, v.business_name as vendor_name, bu.name as buyer_name, p.id as payment_id
          from public.orders o
          join public.payments p on p.order_id = o.id and p.status = 'pending' and p.provider_reference in ('buyer_report','service_offer_report')
          left join public.vendors v on v.id = o.vendor_id left join public.users bu on bu.id = o.buyer_id
          where o.status = 'payment_unresolved' and o.payment_unresolved_at is not null
            and o.payment_unresolved_at <= now() - interval '24 hours' and o.payment_escalated_at is null
          order by o.payment_unresolved_at asc
          for update of o`,
    );
  }

  /** Confirmed orders with no verified payment for 24 hours, oldest first, locked. */
  unpaidConfirmedOrders(): Promise<{ id: string; buyer_id: string | null; vendor_id: string | null; vendor_user_id: string | null; vendor_name: string | null; buyer_name: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select o.id, o.buyer_id, o.vendor_id, v.user_id as vendor_user_id, v.business_name as vendor_name, bu.name as buyer_name
          from public.orders o left join public.vendors v on v.id = o.vendor_id left join public.users bu on bu.id = o.buyer_id
          where o.status = 'confirmed' and o.payment_escalated_at is null and coalesce(o.status_changed_at, o.created_at) <= now() - interval '24 hours'
            and not exists (select 1 from public.payments p where p.order_id = o.id and p.payment_type in ('sale_price','rental_fee') and p.status = 'paid')
            and not (o.delivery_method = 'delivery' and o.payment_timing = 'pay_after'
                     and exists (select 1 from public.payments p where p.order_id = o.id and p.payment_type = 'delivery_deposit_20' and p.status = 'paid'))
          order by coalesce(o.status_changed_at, o.created_at) asc
          for update of o`,
    );
  }

  async markEscalated(orderId: string): Promise<void> {
    await this.db.execute(sql`update public.orders set payment_escalated_at = now() where id = ${orderId}`);
  }

  /** Every admin's id (the jobs' `select id from users where role = 'admin'`). */
  adminIds(): Promise<string[]> {
    return jsonRows<{ id: string }>(this.db, sql`select id from public.users where role = 'admin'`).then((rows) => rows.map((r) => r.id));
  }

  // ----- process_service_offer_deadlines -----

  /** Open service requests past their deadline, with the listing's name and the shop's owner, locked. */
  expiredServiceOffers(): Promise<{ id: string; buyer_id: string | null; listing_id: string; product_name: string | null; vendor_user_id: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select so.id, so.buyer_id, so.listing_id, p.name as product_name,
                 (select v.user_id from public.vendors v where v.id = so.vendor_id) as vendor_user_id
          from public.service_offers so join public.products p on p.id = so.listing_id
          where so.status in ('pending','countered','awaiting_payment') and so.expires_at <= now()
          for update of so`,
    );
  }

  async expireServiceOffer(offerId: string): Promise<void> {
    await this.db.execute(sql`update public.service_offers set status = 'expired', updated_at = now() where id = ${offerId}`);
  }

  // ----- remind_unattended_orders -----

  /**
   * Pending orders between 3 minutes and 24 hours old that are due a reminder: every ~3 minutes
   * (170 s) in their first hour, then every 30 minutes.
   */
  unattendedOrders(): Promise<{ id: string; buyer_id: string | null; vendor_user_id: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select o.id, o.buyer_id, v.user_id as vendor_user_id
          from public.orders o join public.vendors v on v.id = o.vendor_id
          where o.status = 'pending'
            and o.created_at <= now() - interval '3 minutes'
            and o.created_at > now() - interval '24 hours'
            and (o.last_reminder_sent_at is null
                 or o.last_reminder_sent_at <= now() - (case when o.created_at > now() - interval '1 hour' then interval '170 seconds' else interval '30 minutes' end))`,
    );
  }

  async markReminded(orderId: string): Promise<void> {
    await this.db.execute(sql`update public.orders set last_reminder_sent_at = now() where id = ${orderId}`);
  }

  // ----- send_background_reminders -----

  /**
   * One reminder per person with a push subscription who has unread messages (last 3 days) or open
   * orders (last 30 days; vendors are not reminded of orders already fully paid). The function's
   * query, verbatim; the rows are what it posted to /api/notify as `reminders`.
   */
  backgroundReminders(): Promise<{ user_id: string; kind: string; title: string; body: string; view: string; params: Record<string, unknown> }[]> {
    return jsonRows(
      this.db,
      sql`select u.user_id,
            case when sum(u.msgs) > 0 then 'messages' else 'orders' end as kind,
            case when sum(u.msgs) > 0 then 'You have unread messages' else 'Orders need your attention' end as title,
            concat_ws(' · ',
              case when sum(u.msgs) > 0 then sum(u.msgs) || ' unread message' || case when sum(u.msgs) = 1 then '' else 's' end end,
              case when sum(u.ords) > 0 then sum(u.ords) || ' order' || case when sum(u.ords) = 1 then '' else 's' end || ' not yet completed' end) as body,
            case when sum(u.msgs) > 0 then 'messages' else 'buyerOrders' end as view,
            '{}'::jsonb as params
          from (
            select case when m.sender_id = c.buyer_id then v.user_id else c.buyer_id end as user_id, count(*)::int as msgs, 0 as ords
              from public.messages m join public.conversations c on c.id = m.conversation_id join public.vendors v on v.id = c.vendor_id
             where m.read_at is null and m.created_at > now() - interval '3 days'
             group by 1
            union all
            select o.buyer_id, 0, count(*)::int from public.orders o
             where o.status in ('pending','confirmed','payment_unresolved','handed_over','returned') and o.created_at > now() - interval '30 days' group by 1
            union all
            select v.user_id, 0, count(*)::int from public.orders o join public.vendors v on v.id = o.vendor_id
             where o.status in ('pending','confirmed','payment_unresolved','handed_over','returned') and o.created_at > now() - interval '30 days'
               and not (o.status in ('confirmed','handed_over') and (
                 case when o.delivery_method = 'delivery'
                   then exists (select 1 from public.payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = 'delivery_deposit_20')
                        and exists (select 1 from public.payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = case when o.order_type::text = 'sale' then 'sale_price' else 'rental_fee' end)
                   else exists (select 1 from public.payments p where p.order_id = o.id and p.status::text = 'paid' and lower(trim(p.payment_type::text)) = case when o.order_type::text = 'sale' then 'sale_price' else 'rental_fee' end)
                 end))
             group by 1
          ) u
          where u.user_id is not null and exists (select 1 from public.push_subscriptions ps where ps.user_id = u.user_id)
          group by u.user_id`,
    );
  }
}
