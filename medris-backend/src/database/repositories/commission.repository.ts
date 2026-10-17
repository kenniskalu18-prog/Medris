import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

/** Amounts travel as PostgreSQL numeric text. */
type Numeric = string;

/** Owed commission counts only for completed orders. */
const OWED = sql`c.status = 'owed' and o.status = 'completed'`;

/**
 * Commission (3% of each completed sale, owed to Levromart within 7 days; an overdue balance of ₦100
 * or more pauses the storefront) and the reminders about it, plus the monthly-billing helpers.
 */
export class CommissionRepository {
  constructor(private readonly db: Executor) {}

  /** get_vendor_commission_owed()'s sum. */
  async owed(vendorId: string): Promise<Numeric> {
    return (await jsonRow<{ v: Numeric }>(
      this.db,
      sql`select coalesce(sum(c.amount),0)::text as v from public.commission_charges c join public.orders o on o.id = c.order_id where c.vendor_id = ${vendorId} and ${OWED}`,
    ))!.v;
  }

  /** The owed sum as create_commission_payment_intent() held it (numeric(12,2)). */
  async owedRounded(vendorId: string): Promise<Numeric> {
    return (await jsonRow<{ v: Numeric }>(
      this.db,
      sql`select coalesce(sum(c.amount),0)::numeric(12,2)::text as v from public.commission_charges c join public.orders o on o.id = c.order_id where c.vendor_id = ${vendorId} and ${OWED}`,
    ))!.v;
  }

  /** get_vendor_commission_deadline(): the total and the earliest due time - only for the owner's live shop. */
  deadline(vendorId: string, userId: string | null): Promise<{ total_owed: number; earliest_due_at: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select coalesce(sum(c.amount),0) as total_owed, min(c.due_at) as earliest_due_at
          from public.commission_charges c join public.orders o on o.id = c.order_id join public.vendors v on v.id = c.vendor_id
          where c.vendor_id = ${vendorId} and ${OWED} and v.user_id = ${userId}::uuid and v.deleted_at is null`,
    );
  }

  /** get_vendor_commission_breakdown(): each owed charge with its order, buyer and products (3% of the order total). */
  breakdown(vendorId: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select cc.id as charge_id, cc.order_id, cc.payment_id, coalesce(o.completed_at, o.created_at) as sold_at,
                 coalesce(p.payment_type::text, 'order_total') as payment_type, coalesce(o.total_amount, 0)::numeric as payment_amount,
                 round(greatest(0, coalesce(o.total_amount, 0)) * 0.03, 2)::numeric as commission_amount, 3::numeric as commission_rate,
                 coalesce(u.name, 'Buyer')::text as buyer_name,
                 coalesce((select jsonb_agg(jsonb_build_object('product_name', coalesce(pr.name, 'Unnamed product'), 'quantity', oi.quantity, 'unit_price', oi.unit_price,
                                                               'line_total', round(coalesce(oi.quantity, 0) * coalesce(oi.unit_price, 0), 2)) order by pr.name)
                           from public.order_items oi left join public.products pr on pr.id = oi.product_id where oi.order_id = cc.order_id), '[]'::jsonb) as products,
                 o.auto_completed_at
          from public.commission_charges cc left join public.payments p on p.id = cc.payment_id left join public.orders o on o.id = cc.order_id
          left join public.users u on u.id = o.buyer_id
          where cc.vendor_id = ${vendorId} and cc.status = 'owed' and o.status = 'completed'
          order by coalesce(o.completed_at, o.created_at) desc, cc.created_at desc`,
    );
  }

  /** A pending settlement for the whole owed amount, with a new "commission_..." reference. */
  async createSettlement(vendorId: string, amount: Numeric, reference: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.commission_settlements (vendor_id, amount, status, provider_reference)
      values (${vendorId}, ${amount}::numeric(12,2), 'pending', ${reference})`);
  }

  /** compute_monthly_billing_amount(): ₦999 for each active commission-billed product. */
  monthlyBillingAmount(vendorId: string): Promise<{ listing_count: number; amount: number }[]> {
    return jsonRows(
      this.db,
      sql`select count(*)::int as listing_count, count(*)::numeric * 999 as amount
          from public.products where vendor_id = ${vendorId} and status = 'active' and coalesce(billing_model, 'commission') = 'commission'`,
    );
  }

  /* ----------------------------------------------------------- deadline enforcement */

  /**
   * enforce_commission_deadlines(): an admin override ends once nothing is owed; storefronts with an
   * overdue balance of ₦100+ pause (admins are told); paused ones whose balance is no longer overdue
   * reopen. Returns the shops paused and reopened.
   */
  async enforce(vendorId: string | null): Promise<{ paused: { id: string; business_name: string | null }[]; reopened: number }> {
    const only = sql`(${vendorId}::uuid is null or v.id = ${vendorId}::uuid)`;
    const owedSum = (alias: string) =>
      sql.raw(
        `coalesce((select sum(${alias}c.amount) from public.commission_charges ${alias}c join public.orders ${alias}o on ${alias}o.id = ${alias}c.order_id where ${alias}c.vendor_id = v.id and ${alias}c.status = 'owed' and ${alias}o.status = 'completed'), 0)`,
      );
    const overdue = sql`exists(select 1 from public.commission_charges c join public.orders o on o.id = c.order_id where c.vendor_id = v.id and c.status = 'owed' and o.status = 'completed' and c.due_at <= now())`;
    await this.db.execute(sql`
      update public.vendors v set commission_pause_reason = null
      where v.deleted_at is null and v.commission_pause_reason = 'admin_override' and ${only} and ${owedSum("")} <= 0`);
    const paused = rowsOf<{ id: string; business_name: string | null }>(
      await this.db.execute(sql`
        update public.vendors v set is_active = false, commission_paused = true, commission_pause_reason = 'commission_overdue'
        where v.deleted_at is null and v.verification_status = 'verified' and ${only} and coalesce(v.admin_paused, false) = false
          and coalesce(v.commission_pause_reason, '') <> 'admin_override' and ${overdue} and ${owedSum("x")} >= 100
        returning v.id, v.business_name`),
    );
    const reopened = rowsOf(
      await this.db.execute(sql`
        update public.vendors v set is_active = true, commission_paused = false, commission_pause_reason = null
        where v.deleted_at is null and v.verification_status = 'verified' and ${only} and coalesce(v.admin_paused, false) = false
          and coalesce(v.commission_paused, false) = true and v.commission_pause_reason in ('commission_owed', 'commission_overdue')
          and not (${overdue} and ${owedSum("y")} >= 100)
        returning v.id`),
    ).length;
    return { paused, reopened };
  }

  /* -------------------------------------------------------------------- reminders */

  /** Records a reminder once (per vendor, code and due date); true when it is new. */
  private async firstReminder(vendorId: string, code: string, period: string): Promise<boolean> {
    return (
      rowsOf(
        await this.db.execute(sql`
          insert into public.commission_deadline_reminders (vendor_id, reminder_code, period_key) values (${vendorId}, ${code}, ${period}::timestamptz)
          on conflict (vendor_id, reminder_code, period_key) do nothing returning vendor_id`),
      ).length > 0
    );
  }

  /** A reminder notification row, as the reminder functions wrote it. */
  private async reminder(n: { userId: string; type: string; title: string; body: string; view: string; params: unknown; vendorId: string; category: string; group: string; metadata: unknown }): Promise<void> {
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, read, archived, deleted_at, vendor_id, notification_category, group_key, metadata)
      values (${n.userId}, ${n.type}, ${n.title}, ${n.body}, ${n.view}, ${JSON.stringify(n.params)}::jsonb, false, false, null, ${n.vendorId}, ${n.category}, ${n.group},
              ${JSON.stringify(n.metadata)}::jsonb)`);
  }

  /**
   * process_commission_deadline_reminders(): 5, 3, 2 and 1 day(s) before the earliest commission is due,
   * once each, to every live verified shop that is not paused. Returns how many were sent.
   */
  async deadlineReminders(): Promise<{ notifications_created: number; processed_at: string }> {
    const now = (await jsonRow<{ t: string }>(this.db, sql`select now() as t`))!.t;
    const due = await jsonRows<{ vendor_id: string; vendor_user_id: string; earliest_due_at: string; total_owed: number; days_left: number; owed_text: string }>(
      this.db,
      sql`select v.id as vendor_id, v.user_id as vendor_user_id, min(c.due_at) as earliest_due_at, sum(c.amount) as total_owed,
                 ceil(extract(epoch from (min(c.due_at) - ${now}::timestamptz)) / 86400.0)::int as days_left,
                 to_char(sum(c.amount), 'FM999,999,999.00') as owed_text
          from public.vendors v join public.commission_charges c on c.vendor_id = v.id join public.orders o on o.id = c.order_id
          where v.deleted_at is null and v.verification_status = 'verified' and coalesce(v.admin_paused, false) = false
            and coalesce(v.commission_paused, false) = false and v.user_id is not null and ${OWED}
          group by v.id, v.user_id, v.business_name
          having sum(c.amount) > 0`,
    );
    let created = 0;
    for (const r of due) {
      if (![5, 3, 2, 1].includes(r.days_left)) continue;
      const code = `${r.days_left}d`;
      if (!(await this.firstReminder(r.vendor_id, code, r.earliest_due_at))) continue;
      await this.reminder({
        userId: r.vendor_user_id,
        type: "commission_deadline",
        title: r.days_left === 1 ? "Commission due today" : `Commission due in ${r.days_left} days`,
        body:
          r.days_left === 1
            ? `Your commission of ₦${r.owed_text} is due within 24 hours. Pay today so nothing on your storefront is locked.`
            : `You owe ₦${r.owed_text} commission. ${r.days_left} days left to pay${r.total_owed >= 100 ? " before your storefront pauses" : ""}.`,
        view: "vendorDashboard",
        params: {},
        vendorId: r.vendor_id,
        category: "commission_deadline",
        group: `commission-deadline:${r.vendor_id}:${code}`,
        metadata: { vendor_id: r.vendor_id, days_left: r.days_left, total_owed: r.total_owed, due_at: r.earliest_due_at },
      });
      created += 1;
    }
    return { notifications_created: created, processed_at: now };
  }

  /**
   * process_vendor_commission_hour_reminders(): in the last day before a ₦100+ balance is due, one
   * reminder at 10, 5 and 1 hour(s) left (whichever applies now). Returns how many were sent (0 or 1).
   */
  async hourReminder(vendorId: string): Promise<{ notifications_created: number }> {
    const r = await jsonRow<{ vendor_id: string; vendor_user_id: string; business_name: string | null; earliest_due_at: string | null; total_owed: number; hours_left: number; owed_text: string; hours_exact: unknown }>(
      this.db,
      sql`select v.id as vendor_id, v.user_id as vendor_user_id, v.business_name, min(c.due_at) as earliest_due_at, sum(c.amount) as total_owed,
                 (extract(epoch from (min(c.due_at) - now())) / 3600.0)::float8 as hours_left,
                 extract(epoch from (min(c.due_at) - now())) / 3600.0 as hours_exact,
                 to_char(sum(c.amount), 'FM999,999,999') as owed_text
          from public.vendors v join public.commission_charges c on c.vendor_id = v.id join public.orders o on o.id = c.order_id
          where v.id = ${vendorId} and v.deleted_at is null and coalesce(v.admin_paused, false) = false and coalesce(v.commission_paused, false) = false
            and v.user_id is not null and ${OWED}
          group by v.id, v.user_id, v.business_name
          having sum(c.amount) >= 100`,
    );
    if (!r || r.earliest_due_at == null) return { notifications_created: 0 };
    if (!(r.hours_left > 0 && r.hours_left <= 24)) return { notifications_created: 0 };
    const code = r.hours_left <= 1 ? "1h" : r.hours_left <= 5 ? "5h" : r.hours_left <= 10 ? "10h" : null;
    if (!code || !(await this.firstReminder(r.vendor_id, code, r.earliest_due_at))) return { notifications_created: 0 };
    const hours = code.slice(0, -1);
    await this.reminder({
      userId: r.vendor_user_id,
      type: "commission_deadline",
      title: "Commission payment due soon",
      body: `${r.business_name ?? ""}: ₦${r.owed_text} commission is owed and your storefront pauses in about ${hours} hour${hours === "1" ? "" : "s"} unless it's paid.`,
      view: "vendorDashboard",
      params: {},
      vendorId: r.vendor_id,
      category: "commission_deadline",
      group: `commission-deadline:${r.vendor_id}:${code}`,
      metadata: { vendor_id: r.vendor_id, hours_left: r.hours_exact, total_owed: r.total_owed, due_at: r.earliest_due_at },
    });
    return { notifications_created: 1 };
  }

  /**
   * process_listing_billing_reminders(): monthly-billed products and packages are reminded 20, 15, 10, 5,
   * 4 and 1 day(s) before their paid period ends and paused once it has; shops on combined monthly billing
   * are reminded 10, 5, 1 and 0 days before their next charge. Each reminder once per period.
   */
  async listingBillingReminders(): Promise<{ notifications_created: number; listings_paused: number; processed_at: string }> {
    const now = (await jsonRow<{ t: string }>(this.db, sql`select now() as t`))!.t;
    let created = 0;
    let paused = 0;
    const firstListingReminder = async (kind: string, listingId: string, code: string, period: string) => {
      const exists = await jsonRow(
        this.db,
        sql`select 1 as x from public.listing_billing_reminders r where r.kind = ${kind} and r.listing_id = ${listingId} and r.reminder_code = ${code} and r.period_key = ${period}::date`,
      );
      if (exists) return false;
      await this.db.execute(sql`insert into public.listing_billing_reminders (kind, listing_id, reminder_code, period_key) values (${kind}, ${listingId}, ${code}, ${period}::date)`);
      return true;
    };
    for (const kind of ["product", "package"] as const) {
      const table = kind === "product" ? sql`public.products` : sql`public.vendor_packages`;
      const label = kind === "product" ? "Listing" : "Package";
      const idKey = kind === "product" ? "productId" : "packageId";
      const view = kind === "product" ? "vendorProducts" : "vendorPackages";
      const groupPrefix = kind === "product" ? "listing-expiry" : "package-expiry";
      const rows = await jsonRows<{ id: string; vendor_id: string; name: string; billing_paid_until: string; status: string; billing_status: string; vendor_user_id: string; period: string; days_left: number }>(
        this.db,
        sql`select l.id, l.vendor_id, l.name, l.billing_paid_until, l.status::text as status, l.billing_status, vv.user_id as vendor_user_id,
                   (l.billing_paid_until at time zone 'UTC')::date::text as period,
                   (l.billing_paid_until at time zone 'UTC')::date - (${now}::timestamptz at time zone 'UTC')::date as days_left
            from ${table} l join public.vendors vv on vv.id = l.vendor_id
            where l.billing_model = 'monthly' and l.billing_paid_until is not null and vv.user_id is not null`,
      );
      for (const r of rows) {
        if ([20, 15, 10, 5, 4, 1].includes(r.days_left)) {
          const code = `${r.days_left}d`;
          if (await firstListingReminder(kind, r.id, code, r.period)) {
            await this.reminder({
              userId: r.vendor_user_id,
              type: "listing_billing",
              title: `${label} renewal reminder`,
              body: `${r.name} expires in ${r.days_left} day${r.days_left === 1 ? "" : "s"}. Renew for ₦1,000 to keep it live.`,
              view,
              params: { [idKey]: r.id, billing_paid_until: r.billing_paid_until },
              vendorId: r.vendor_id,
              category: "listing_billing",
              group: `${groupPrefix}:${r.id}:${code}`,
              metadata: { kind, listing_id: r.id, days_left: r.days_left },
            });
            created += 1;
          }
        } else if (r.days_left <= 0) {
          if (r.status !== "removed" && (r.status !== "paused" || r.billing_status !== "past_due")) {
            await this.db.execute(sql`update ${table} set status = 'paused', billing_status = 'past_due' where id = ${r.id} and status <> 'removed'`);
            paused += 1;
          }
          if (await firstListingReminder(kind, r.id, "expired", r.period)) {
            await this.reminder({
              userId: r.vendor_user_id,
              type: "listing_billing",
              title: `${label} expired`,
              body: `${r.name} has expired and is paused. Renew for ₦1,000 to restore it.`,
              view,
              params: { [idKey]: r.id },
              vendorId: r.vendor_id,
              category: "listing_billing",
              group: `${groupPrefix}:${r.id}:expired`,
              metadata: { kind, listing_id: r.id, expired: true },
            });
            created += 1;
          }
        }
      }
    }
    const shops = await jsonRows<{ id: string; user_id: string; business_name: string | null; period: string; days_left: number }>(
      this.db,
      sql`select id, user_id, business_name, (next_monthly_charge_at at time zone 'UTC')::date::text as period,
                 (next_monthly_charge_at at time zone 'UTC')::date - (${now}::timestamptz at time zone 'UTC')::date as days_left
          from public.vendors where billing_model = 'monthly' and next_monthly_charge_at is not null and user_id is not null`,
    );
    for (const v of shops) {
      if (![10, 5, 1, 0].includes(v.days_left)) continue;
      const code = v.days_left === 0 ? "0d" : `${v.days_left}d`;
      if (!(await firstListingReminder("vendor", v.id, code, v.period))) continue;
      await this.reminder({
        userId: v.user_id,
        type: "listing_billing",
        title: "Monthly listing billing reminder",
        body:
          v.days_left === 0
            ? `${v.business_name ?? ""}: your combined monthly listing billing is due today. Review your listings and payment method.`
            : `${v.business_name ?? ""}: your combined monthly listing billing renews in ${v.days_left} day${v.days_left === 1 ? "" : "s"}. Review your listings and payment method.`,
        view: "vendorEditProfile",
        params: {},
        vendorId: v.id,
        category: "listing_billing",
        group: `vendor-monthly:${v.id}:${code}`,
        metadata: { kind: "vendor", vendor_id: v.id, days_left: v.days_left },
      });
      created += 1;
    }
    return { notifications_created: created, listings_paused: paused, processed_at: now };
  }

  /** `from("commission_charges").select("amount,due_at").eq("vendor_id", id).eq("status", "owed").order("due_at")` (as the user: the shop's owner and admins). */
  owedCharges(vendorId: string): Promise<{ amount: number; due_at: string | null }[]> {
    return jsonRows(this.db, sql`select amount, due_at from public.commission_charges where vendor_id = ${vendorId} and status = 'owed' order by due_at asc`);
  }
}
