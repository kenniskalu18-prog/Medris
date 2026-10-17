import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

export interface AdminCounts {
  logins_today: number;
  login_events: number;
  open_support_requests: number;
  new_suggestions: number;
  open_disputes: number;
  escalated_unresolved_payments: number;
  escalated_unpaid_confirmed: number;
  pending_shop_applications: number;
}

/**
 * The admin screens' table queries (counts, the sign-in log, the admin action log). Run as the user:
 * only admins see these rows (row-level security), so for anyone else every count is 0 and lists are empty.
 */
export class AdminDashboardRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The dashboard's head counts (`select("id", { count: "exact", head: true })` on auth_activity_logs, support_requests,
   * suggestions, disputes and orders). `since` is the start of the admin's day. FIX B12: open disputes are
   * status 'open' (the app's `not in (resolved,closed)` fails: 'closed' is not a dispute status, so it showed 0).
   */
  async counts(since: string): Promise<AdminCounts> {
    return (await jsonRow<AdminCounts>(
      this.db,
      sql`select
            (select count(*)::int from public.auth_activity_logs where event_type = 'login' and occurred_at >= ${since}::timestamptz) as logins_today,
            (select count(*)::int from public.auth_activity_logs where event_type = 'login') as login_events,
            (select count(*)::int from public.support_requests where status in ('open', 'in_progress')) as open_support_requests,
            (select count(*)::int from public.suggestions where status = 'new') as new_suggestions,
            (select count(*)::int from public.disputes where status = 'open') as open_disputes,
            (select count(*)::int from public.orders where status = 'payment_unresolved' and payment_escalated_at is not null) as escalated_unresolved_payments,
            (select count(*)::int from public.orders where status = 'confirmed' and payment_escalated_at is not null) as escalated_unpaid_confirmed,
            (select count(*)::int from public.vendors where verification_status = 'pending' and deleted_at is null) as pending_shop_applications`,
    ))!;
  }

  /** `from("auth_activity_logs").select("id,user_id,event_type,occurred_at,user_agent,ip,source").order("occurred_at", desc).limit(2000)[.gte("occurred_at", since)]` */
  loginLog(since: string | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, user_id, event_type, occurred_at, user_agent, ip, source from public.auth_activity_logs
          ${since ? sql`where occurred_at >= ${since}::timestamptz` : sql``}
          order by occurred_at desc limit 2000`,
    );
  }

  /** `from("admin_actions").select("*").order("created_at", desc).limit(100)` */
  actionLog(): Promise<Record<string, unknown>[]> {
    return jsonRows(this.db, sql`select * from public.admin_actions order by created_at desc limit 100`);
  }

  /**
   * `insert({ admin_id: me, admin_name, action, target_type, target_id, target_label })` - the name is the
   * admin's profile name (or email), as the app filled it in. The other admins are notified (trigger).
   */
  async logAction(adminId: string, a: { action: string; targetType: string; targetId: string | null; targetLabel: string | null }): Promise<void> {
    await this.db.execute(sql`
      insert into public.admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
      select ${adminId}, coalesce(nullif(u.name, ''), nullif(u.email, ''), 'Admin'), ${a.action}, ${a.targetType}, ${a.targetId}::uuid, ${a.targetLabel}
      from (select 1) x left join public.users u on u.id = ${adminId}`);
  }

  /**
   * The admin "Disputes & payment issues" page: open disputes (oldest first) with their order, the order's shop
   * and payments; orders whose reported payment was escalated; confirmed orders escalated for no payment.
   * Replaces its three embedded selects, as the user (admins see everything; others nothing).
   */
  async disputesQueue(): Promise<{ disputes: Record<string, unknown>[]; unresolvedPayments: Record<string, unknown>[]; unpaidConfirmed: Record<string, unknown>[] }> {
    const payments = sql`coalesce((select json_agg(json_build_object('id', p.id, 'payment_type', p.payment_type, 'amount', p.amount, 'status', p.status,
                                                     'provider_reference', p.provider_reference, 'created_at', p.created_at, 'paid_at', p.paid_at))
                                  from public.payments p where p.order_id = o.id), '[]'::json)`;
    const shop = sql`(select json_build_object('business_name', v.business_name) from public.vendors v where v.id = o.vendor_id)`;
    const disputes = await jsonRows(
      this.db,
      sql`select d.*,
                 (select json_build_object('id', o.id, 'order_type', o.order_type, 'buyer_id', o.buyer_id, 'vendor_id', o.vendor_id, 'payout_status', o.payout_status,
                                           'status', o.status, 'payment_unresolved_at', o.payment_unresolved_at, 'payment_escalated_at', o.payment_escalated_at,
                                           'total_amount', o.total_amount, 'status_changed_at', o.status_changed_at, 'vendor', ${shop}, 'payments', ${payments})
                  from public.orders o where o.id = d.order_id) as "order"
          from public.disputes d where d.status = 'open' order by d.created_at asc`,
    );
    const unresolvedPayments = await jsonRows(
      this.db,
      sql`select o.id, o.order_type, o.buyer_id, o.vendor_id, o.status, o.payment_unresolved_at, o.payment_escalated_at, o.total_amount, o.status_changed_at,
                 ${shop} as vendor, ${payments} as payments
          from public.orders o where o.status = 'payment_unresolved' and o.payment_escalated_at is not null order by o.payment_escalated_at asc`,
    );
    const unpaidConfirmed = await jsonRows(
      this.db,
      sql`select o.id, o.order_type, o.buyer_id, o.vendor_id, o.status, o.total_amount, o.status_changed_at, o.payment_escalated_at,
                 ${shop} as vendor, ${payments} as payments
          from public.orders o where o.status = 'confirmed' and o.payment_escalated_at is not null order by o.payment_escalated_at asc`,
    );
    return { disputes, unresolvedPayments, unpaidConfirmed };
  }
}
