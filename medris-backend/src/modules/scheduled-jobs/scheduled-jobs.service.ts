import type { DataContext } from "../../database/context.js";
import { CommissionRepository } from "../../database/repositories/commission.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { NotifyWebhook } from "../../database/repositories/notify-webhook.repository.js";
import { PointsRepository } from "../../database/repositories/points.repository.js";
import { ScheduledJobsRepository } from "../../database/repositories/scheduled-jobs.repository.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

/** A scheduled job: its pg_cron name and schedule, and what it does. */
export interface ScheduledJob {
  name: JobName;
  /** The pg_cron schedule (UTC) the job runs on today (baseline/05-cron-jobs.sql). */
  schedule: string;
  description: string;
}

export const JOB_NAMES = [
  "auto-cancel-unconfirmed-orders",
  "auto-complete-orders",
  "bg-reminders",
  "commission-deadline-reminders",
  "levromart-finalize-points-week",
  "levromart-payment-unresolved-escalation",
  "levromart-points-reconcile",
  "levromart-service-offer-deadlines",
  "remind-unattended-orders",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOBS: readonly ScheduledJob[] = [
  { name: "auto-cancel-unconfirmed-orders", schedule: "* * * * *", description: "Cancels orders the vendor has not confirmed within 30 minutes." },
  { name: "auto-complete-orders", schedule: "*/10 * * * *", description: "Completes paid orders the buyer has not confirmed or disputed within 24 hours." },
  { name: "bg-reminders", schedule: "* * * * *", description: "Batched push reminders for unread messages and open orders." },
  { name: "commission-deadline-reminders", schedule: "0 7 * * *", description: "Commission due in 5, 3, 2 or 1 day(s)." },
  { name: "levromart-finalize-points-week", schedule: "5 23 * * 0", description: "Closes finished points weeks and names the winners." },
  { name: "levromart-payment-unresolved-escalation", schedule: "*/5 * * * *", description: "Tells admins about payments left unresolved, or confirmed orders left unpaid, for 24 hours." },
  { name: "levromart-points-reconcile", schedule: "*/10 * * * *", description: "Awards or revokes listing points for listings that changed." },
  { name: "levromart-service-offer-deadlines", schedule: "*/5 * * * *", description: "Expires service requests past their deadline." },
  { name: "remind-unattended-orders", schedule: "*/3 * * * *", description: "Reminds both sides about orders still waiting for the vendor." },
];

const orderDetail = (orderId: string) => ({ targetView: "orderDetail", targetParams: { orderId } });

/**
 * The database's scheduled jobs (pg_cron), one method each. Each runs in one service-role
 * transaction, as the job did, so the triggers on the rows it changes fire exactly as before.
 * Until the switch pg_cron keeps running the originals; run() is what the backend's scheduler
 * (or POST /api/v1/jobs/{job}) calls afterwards.
 */
export class ScheduledJobsService {
  constructor(private readonly db: () => DataContext) {}

  private tx<T>(work: (tx: Tx, jobs: ScheduledJobsRepository, notify: NotificationWriter) => Promise<T>): Promise<T> {
    return this.db().asService((tx) => work(tx, new ScheduledJobsRepository(tx), new NotificationWriter(tx)));
  }

  /** Runs one job by its pg_cron name; returns what the job returned (a count, a summary, or null). */
  async run(name: JobName): Promise<unknown> {
    switch (name) {
      case "auto-cancel-unconfirmed-orders":
        return this.autoCancelUnconfirmedOrders();
      case "auto-complete-orders":
        return this.autoCompleteEligibleOrders();
      case "bg-reminders":
        return this.sendBackgroundReminders();
      case "commission-deadline-reminders":
        return this.db().asService((tx) => new CommissionRepository(tx).deadlineReminders());
      case "levromart-finalize-points-week":
        return this.db().asService((tx) => new PointsRepository(tx).finalizeWeeks().then(() => null));
      case "levromart-payment-unresolved-escalation":
        return this.escalateUnresolvedPaymentOrders();
      case "levromart-points-reconcile":
        return this.db().asService((tx) => new PointsRepository(tx).reconcileListings().then(() => null));
      case "levromart-service-offer-deadlines":
        return this.processServiceOfferDeadlines();
      case "remind-unattended-orders":
        return this.remindUnattendedOrders();
    }
  }

  /** Replaces: public.auto_cancel_unconfirmed_orders() - pending orders older than 30 minutes are cancelled; both sides are told. */
  autoCancelUnconfirmedOrders(): Promise<number> {
    return this.tx(async (_tx, jobs, notify) => {
      let n = 0;
      for (const r of await jobs.unconfirmedOrders()) {
        if (!(await jobs.cancelUnconfirmed(r.id))) continue;
        if (r.buyer_id) {
          await notify.create({
            userId: r.buyer_id,
            type: "order_auto_cancelled",
            title: "Order cancelled automatically",
            body: "The vendor did not confirm your order within 30 minutes, so it was cancelled. You have not been charged. You can order again or try another vendor.",
            ...orderDetail(r.id),
          });
        }
        if (r.vendor_user_id) {
          await notify.create({
            userId: r.vendor_user_id,
            type: "order_auto_cancelled",
            title: "Order cancelled automatically",
            body: "You did not confirm this order within 30 minutes, so it was cancelled automatically. Reply faster next time to keep your customers.",
            ...orderDetail(r.id),
          });
        }
        n += 1;
      }
      return n;
    });
  }

  /** Replaces: public.auto_complete_eligible_orders() - paid orders not confirmed or disputed within 24 hours are completed. */
  autoCompleteEligibleOrders(): Promise<number> {
    return this.tx(async (_tx, jobs, notify) => {
      let n = 0;
      for (const r of await jobs.completableOrders()) {
        await jobs.autoComplete(r.id);
        n += 1;
        await notify.createQuietly({
          userId: r.buyer_id,
          type: "order_completed",
          title: "Order marked as received",
          body: "No issue was reported within 24 hours, so your order was marked as received and completed.",
          targetView: "orderDetail",
          targetParams: { orderId: r.id, reviewEligible: true },
        });
      }
      return n;
    });
  }

  /**
   * Replaces: public.escalate_unresolved_payment_orders() - admins hear about reported payments the
   * vendor left unanswered for 24 hours; confirmed orders unpaid for 24 hours also nudge both sides.
   * Each order is escalated once.
   */
  escalateUnresolvedPaymentOrders(): Promise<number> {
    return this.tx(async (_tx, jobs, notify) => {
      let count = 0;
      for (const r of await jobs.unresolvedPayments()) {
        for (const adminId of await jobs.adminIds()) {
          await notify.create({
            userId: adminId,
            type: "payment_unresolved_24h",
            title: "Payment unresolved — 24h vendor action overdue",
            body: `${r.vendor_name ?? "Vendor"} has not confirmed or disputed the reported payment for order ${r.id} within 24 hours. Customer: ${r.buyer_name ?? "Buyer"}. Please investigate and contact the vendor.`,
            targetView: "adminDisputes",
            targetParams: { orderId: r.id, vendorId: r.vendor_id, buyerId: r.buyer_id, paymentId: r.payment_id },
          });
        }
        await jobs.markEscalated(r.id);
        count += 1;
      }
      for (const r of await jobs.unpaidConfirmedOrders()) {
        for (const adminId of await jobs.adminIds()) {
          await notify.create({
            userId: adminId,
            type: "confirmed_order_24h",
            title: "Confirmed order — 24h payment follow-up",
            body: `${r.vendor_name ?? "Vendor"} has a confirmed order ${r.id} that has had no verified payment for 24 hours. Customer: ${r.buyer_name ?? "Buyer"}. Please investigate.`,
            targetView: "adminDisputes",
            targetParams: { orderId: r.id, vendorId: r.vendor_id, buyerId: r.buyer_id },
          });
        }
        await notify.create({
          userId: r.buyer_id,
          type: "confirmed_order_24h",
          title: "Payment still required",
          body: "This confirmed order has been waiting for payment for 24 hours. Please complete the transfer and tap “I’ve paid the vendor”, or cancel the order.",
          ...orderDetail(r.id),
        });
        await notify.create({
          userId: r.vendor_user_id,
          type: "confirmed_order_24h",
          title: "Payment follow-up required",
          body: "This confirmed order has been waiting for payment for 24 hours. Confirm payment if the customer has paid, or raise a dispute.",
          ...orderDetail(r.id),
        });
        await jobs.markEscalated(r.id);
        count += 1;
      }
      return count;
    });
  }

  /** Replaces: public.process_service_offer_deadlines() - open service requests past their deadline expire; both sides are told. */
  processServiceOfferDeadlines(): Promise<number> {
    return this.tx(async (_tx, jobs, notify) => {
      let count = 0;
      for (const r of await jobs.expiredServiceOffers()) {
        await jobs.expireServiceOffer(r.id);
        const message = {
          type: "service_offer_expired",
          title: "Service request expired",
          body: `The service request for ${r.product_name ?? "the service"} expired because it was not completed in time.`,
          targetView: "productDetail",
          targetParams: { productId: r.listing_id, serviceOfferId: r.id },
        };
        await notify.create({ userId: r.buyer_id, ...message });
        await notify.create({ userId: r.vendor_user_id, ...message });
        count += 1;
      }
      return count;
    });
  }

  /**
   * Replaces: public.remind_unattended_orders() - after 3 minutes of silence on a pending order,
   * both sides are reminded every ~3 minutes for the first hour, then every 30 minutes (until 24 h).
   */
  remindUnattendedOrders(): Promise<number> {
    return this.tx(async (_tx, jobs, notify) => {
      let n = 0;
      for (const r of await jobs.unattendedOrders()) {
        if (r.vendor_user_id) {
          await notify.create({
            userId: r.vendor_user_id,
            type: "order_reminder",
            title: "Order waiting for you",
            body: "A customer order is still waiting. Accept or decline it so they know where they stand.",
            ...orderDetail(r.id),
          });
        }
        if (r.buyer_id) {
          await notify.create({
            userId: r.buyer_id,
            type: "order_reminder",
            title: "Your order is still waiting",
            body: "The vendor has not responded yet. You can send them a reminder from the order page.",
            ...orderDetail(r.id),
          });
        }
        await jobs.markReminded(r.id);
        n += 1;
      }
      return n;
    });
  }

  /**
   * Replaces: public.send_background_reminders() - one batched push per subscribed person with unread
   * messages or open orders, posted to /api/notify (through pg_net, so only if the transaction commits).
   * Returns how many reminders were posted (the original returned nothing).
   */
  sendBackgroundReminders(): Promise<number> {
    return this.tx(async (tx, jobs) => {
      const reminders = await jobs.backgroundReminders();
      if (reminders.length === 0) return 0;
      await new NotifyWebhook(tx).reminders(reminders);
      return reminders.length;
    });
  }
}
