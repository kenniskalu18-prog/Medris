import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { PaystackLedgerRepository } from "../../database/repositories/paystack-ledger.repository.js";
import { PaymentClaimsRepository, type ClaimOrder } from "../../database/repositories/payment-claims.repository.js";
import { sqlTrim } from "../../lib/sql-text.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];
type Result = Record<string, unknown>;

const AWAIT_TEXT = " Please confirm once you have received your order. It completes automatically in 24 hours if no issue is reported.";

/**
 * Direct (bank transfer) payments and disputes. The buyer reports paying the vendor; the vendor (or
 * an admin) confirms the money arrived or disputes it. Every step runs on the caller's behalf.
 */
export class PaymentClaimsService {
  constructor(private readonly db: () => DataContext) {}

  private run<T>(me: Identity | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    return me ? this.db().onBehalfOf(me, work) : this.db().asService(work);
  }

  /**
   * Replaces: public.buyer_report_manual_payment(uuid, numeric) - "I've paid the vendor": the amount must
   * match what is outstanding (delivery deposit first for pay-after-delivery orders). The order becomes
   * "payment unresolved" until the vendor confirms or disputes.
   */
  async report(me: Identity | null, orderId: string, amount: number | null): Promise<Result> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (o.buyer_id !== me.userId) throw forbidden("You are not authorized to report payment for this order.");
      if (!["pending", "confirmed", "handed_over", "returned", "payment_unresolved"].includes(o.status)) throw badRequest("This order is not currently eligible for a payment report.");
      // An order being paid with Paystack must not also be reported as a bank transfer (it would be counted twice).
      if (await new PaystackLedgerRepository(tx).hasActiveAttempt(orderId)) throw badRequest("This order is being paid with Paystack, so a bank transfer cannot be reported on it.");
      if (amount == null || amount <= 0) throw badRequest("Payment amount must be positive.");
      const due = await claims.outstanding(o);
      if (due === "none") return { success: true, message: "There is no outstanding payment obligation on this order." };
      if (await claims.amountDiffers(amount, due.expected)) {
        throw badRequest("Payment amount does not match the outstanding amount for this order.");
      }
      const buyerName = await claims.userName(me.userId);
      const paymentId = await claims.recordBuyerReport(orderId, due.type, amount, await claims.buyerReport(orderId, due.type));
      await claims.setOrderState(orderId, "reported");
      await new NotificationWriter(tx).create({
        userId: o.vendor_user_id,
        type: "manual_payment_reported",
        title: "Payment unresolved",
        body: `${buyerName ?? "The buyer"} says they paid ${o.vendor_name ?? "your shop"} directly by bank transfer. Check your account and either confirm the payment or raise a dispute.`,
        targetView: "orderDetail",
        targetParams: { orderId },
        actorId: me.userId,
      });
      return {
        success: true,
        payment_id: paymentId,
        order_completed: false,
        status: "payment_unresolved",
        message: "Payment reported. The order is now Payment unresolved until the vendor confirms the payment or raises a dispute.",
      };
    });
  }

  /**
   * After a reported fee is confirmed: completes the order, or - for a plain product order without
   * escrow - waits for the buyer's confirmation (24-hour auto-complete). A delivery deposit confirms the order.
   */
  private async afterConfirmedClaim(claims: PaymentClaimsRepository, o: ClaimOrder, type: string): Promise<{ complete: boolean; await: boolean }> {
    let complete = false;
    let waiting = false;
    if (type === "delivery_deposit_20") {
      await claims.setOrderState(o.id, "deposit_confirmed");
    } else if (type === "sale_price" || type === "rental_fee") {
      complete = o.delivery_method === "delivery" && o.payment_timing === "pay_after" ? await claims.paid(o.id, ["delivery_deposit_20"]) : true;
      if (complete && o.order_type !== "rental" && o.service_offer_id == null && (o.payout_status ?? "not_applicable") === "not_applicable") {
        complete = false;
        waiting = true;
        await claims.setOrderState(o.id, "await_buyer");
      }
      if (complete) await claims.setOrderState(o.id, "completed");
      else if (!waiting) await claims.setOrderState(o.id, "confirmed");
    }
    return { complete, await: waiting };
  }

  /**
   * A card payment Paystack has confirmed (issue #95): moves the order on with the same rules as a vendor-confirmed
   * transfer (a delivery deposit confirms the order; a final payment completes it or starts the buyer's 24-hour
   * confirmation) and tells both sides. Runs inside the caller's transaction; the payment row must already be paid.
   */
  async applyConfirmedCardPayment(tx: Tx, orderId: string, reference: string): Promise<void> {
    const claims = new PaymentClaimsRepository(tx);
    const o = await claims.order(orderId);
    const type = await claims.paymentTypeByReference(reference);
    if (!o || !type) return;
    const after = await this.afterConfirmedClaim(claims, o, type);
    const notify = new NotificationWriter(tx);
    const label = { delivery_deposit_20: "delivery deposit", rental_fee: "rental fee", deposit: "refundable deposit" }[type] ?? "payment";
    await notify.create({
      userId: o.buyer_id,
      type: "payment_confirmed",
      title: "Payment received",
      body: `Your ${label} was paid with Paystack.${after.complete ? " The order is now complete and ready for review." : after.await ? AWAIT_TEXT : ""}`,
      targetView: "orderDetail",
      targetParams: { orderId, reviewEligible: after.complete },
      actorId: null,
    });
    await notify.create({
      userId: o.vendor_user_id,
      type: "payment_confirmed",
      title: "Order paid: deliver now",
      body: `${o.vendor_name ?? "Your shop"} has been paid for an order (${label}) through Levromart.`,
      targetView: "orderDetail",
      targetParams: { orderId },
      actorId: null,
    });
  }

  /** Replaces: public.vendor_confirm_reported_payment(uuid) - the vendor received the reported money. */
  async vendorConfirm(me: Identity | null, orderId: string): Promise<Result> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (!(await claims.ownsLiveShop(o.vendor_id, me.userId))) throw forbidden("Only the vendor can confirm this payment.");
      const claim = await claims.latestClaim(orderId);
      if (!claim) throw badRequest("There is no buyer-reported payment awaiting confirmation.");
      await claims.confirmClaimByVendor(claim.id);
      const after = await this.afterConfirmedClaim(claims, o, claim.payment_type);
      const dispute = await claims.openDispute(orderId);
      if (dispute) {
        await claims.resolveDispute(dispute, "Vendor later confirmed the reported payment.", "append");
      }
      if (o.service_offer_id != null && after.complete) await claims.completeServiceOffer(o.service_offer_id);
      const label = { delivery_deposit_20: "delivery deposit", rental_fee: "rental fee", deposit: "refundable deposit" }[claim.payment_type] ?? "payment";
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_confirmed",
        title: "Payment confirmed",
        body: `${o.vendor_name ?? "The vendor"} confirmed receipt of your ${label}.${after.complete ? " The order is now complete and ready for review." : after.await ? AWAIT_TEXT : ""}`,
        targetView: "orderDetail",
        targetParams: { orderId, reviewEligible: after.complete },
        actorId: me.userId,
      });
      return { success: true, payment_id: claim.id, order_completed: after.complete, awaiting_buyer_confirmation: after.await, status: after.complete ? "completed" : "confirmed" };
    });
  }

  /** Replaces: public.vendor_dispute_reported_payment(uuid, text) - the money did not arrive: Levromart reviews it. */
  async vendorDispute(me: Identity | null, orderId: string, reason: string | null): Promise<Result> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (!(await claims.ownsLiveShop(o.vendor_id, me.userId))) throw forbidden("Only the vendor can dispute this payment.");
      if (sqlTrim(reason ?? "") === "") throw badRequest("Please explain why you are disputing the reported payment.");
      if (!(await claims.latestClaim(orderId))) throw badRequest("There is no buyer-reported payment awaiting dispute.");
      const disputeId = await this.vendorDisputeRow(claims, orderId, reason!);
      await claims.setOrderState(orderId, "vendor_disputed");
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_disputed",
        title: "Payment unresolved",
        body: `${o.vendor_name ?? "The vendor"} could not verify your reported payment. Levromart will review the payment claim.`,
        targetView: "orderDetail",
        targetParams: { orderId, disputeId },
        actorId: me.userId,
      });
      return { success: true, status: "payment_unresolved", dispute_id: disputeId };
    });
  }

  /** The open dispute (now raised by the vendor with this reason), or a new one. */
  private async vendorDisputeRow(claims: PaymentClaimsRepository, orderId: string, reason: string): Promise<string> {
    const open = await claims.openDispute(orderId);
    if (open) {
      await claims.raiseByVendor(open, reason);
      return open;
    }
    return claims.newDispute(orderId, "vendor", reason);
  }

  /**
   * Replaces: public.vendor_confirm_unreported_payment(uuid) - at the payment follow-up stage the vendor
   * records money the buyer paid without reporting it.
   */
  async vendorConfirmUnreported(me: Identity | null, orderId: string): Promise<Result> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (!(await claims.ownsLiveShop(o.vendor_id, me.userId))) throw forbidden("Only the vendor can confirm payment for this order.");
      if (o.status !== "confirmed") throw badRequest("This order is no longer awaiting payment confirmation.");
      if (o.payment_escalated_at == null) throw badRequest("This order has not reached the payment follow-up stage yet.");
      const depositDue = o.delivery_method === "delivery" && o.payment_timing === "pay_after" && !(await claims.paid(orderId, ["delivery_deposit_20"]));
      const { type, expected } = await claims.unreportedDue(o, depositDue);
      if (Number(expected) <= 0) throw badRequest("There is no outstanding payment amount on this order.");
      const paymentId = await claims.insertDirectPayment(orderId, type, expected);
      let completed = false;
      if (type === "delivery_deposit_20") {
        await claims.setOrderState(orderId, "follow_up_cleared");
      } else if (o.order_type !== "rental" && o.service_offer_id == null && (o.payout_status ?? "not_applicable") === "not_applicable") {
        await claims.setOrderState(orderId, "await_buyer");
      } else {
        completed = true;
        await claims.completeDirect(orderId);
      }
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_confirmed",
        title: "Payment confirmed",
        body: `${o.vendor_name ?? "The vendor"} confirmed that your payment was received. ${
          completed ? "Your order is now complete." : "Payment recorded. Please confirm once you have received your order; it completes automatically in 24 hours if no issue is reported."
        }`,
        targetView: "orderDetail",
        targetParams: { orderId, reviewEligible: completed },
        actorId: me.userId,
      });
      return { success: true, payment_id: paymentId, order_completed: completed, status: completed ? "completed" : "confirmed" };
    });
  }

  /** Replaces: public.vendor_dispute_unreported_payment(uuid, text) - at the follow-up stage, the vendor says the buyer did not pay. */
  async vendorDisputeUnreported(me: Identity | null, orderId: string, reason: string | null): Promise<Result> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (!(await claims.ownsLiveShop(o.vendor_id, me.userId))) throw forbidden("Only the vendor can dispute this order.");
      if (o.status !== "confirmed") throw badRequest("This order is no longer in the confirmed payment-follow-up state.");
      if (sqlTrim(reason ?? "") === "") throw badRequest("Please explain why you cannot confirm the payment.");
      const disputeId = await this.vendorDisputeRow(claims, orderId, reason!);
      await claims.setOrderState(orderId, "follow_up_disputed");
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_disputed",
        title: "Payment unresolved",
        body: `${o.vendor_name ?? "The vendor"} could not confirm the payment for this order. Levromart will review the issue.`,
        targetView: "orderDetail",
        targetParams: { orderId, disputeId },
        actorId: me.userId,
      });
      return { success: true, status: "payment_unresolved", dispute_id: disputeId };
    });
  }

  /** Replaces: public.admin_confirm_reported_payment(uuid, text) - Levromart verified the buyer's claim. */
  async adminConfirm(me: Identity | null, orderId: string, notes: string | null): Promise<Result> {
    return this.run(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("Only admins can verify payment claims.");
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      const claim = await claims.latestClaim(orderId);
      if (!claim) throw notFound("No pending reported payment was found.");
      await claims.confirmClaimByAdmin(claim.id);
      const after = await this.afterConfirmedClaim(claims, o, claim.payment_type);
      if (o.service_offer_id != null && after.complete) await claims.completeServiceOffer(o.service_offer_id);
      const dispute = await claims.openDispute(orderId);
      if (dispute) await claims.resolveDispute(dispute, notes, "default_verified");
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_confirmed",
        title: "Payment verified by Levromart",
        body: `Levromart verified the reported payment.${after.complete ? " The order is now complete and ready for review." : after.await ? AWAIT_TEXT : ""}`,
        targetView: "orderDetail",
        targetParams: { orderId, reviewEligible: after.complete },
        actorId: null,
      });
      return { success: true, payment_id: claim.id, order_completed: after.complete, awaiting_buyer_confirmation: after.await };
    });
  }

  /** Replaces: public.admin_reject_reported_payment(uuid, text) - the claim could not be verified: the order is cancelled. */
  async adminReject(me: Identity | null, orderId: string, notes: string | null): Promise<Result> {
    return this.run(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("Only admins can reject payment claims.");
      if (sqlTrim(notes ?? "") === "") throw badRequest("Resolution notes are required when rejecting a payment claim.");
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      const claim = await claims.latestClaim(orderId);
      if (!claim) throw notFound("No pending reported payment was found.");
      await claims.rejectClaim(claim.id);
      if (o.service_offer_id != null) await claims.expireServiceOffer(o.service_offer_id);
      const dispute = await claims.openDispute(orderId);
      if (dispute) await claims.resolveDispute(dispute, notes);
      await claims.setOrderState(orderId, "claim_rejected");
      await new NotificationWriter(tx).create({
        userId: o.buyer_id,
        type: "payment_claim_rejected",
        title: "Payment claim rejected",
        body: "Levromart could not verify the reported payment for this order. Check the order for the resolution notes.",
        targetView: "orderDetail",
        targetParams: { orderId },
        actorId: null,
      });
      return { success: true, order_cancelled: true };
    });
  }

  /** Replaces: public.record_offline_payment(uuid, payment_type, numeric, payment_method) - the vendor confirms the amount the buyer reported. */
  async recordOffline(me: Identity | null, orderId: string, type: string, amount: number | null, method: string): Promise<{ id: string }> {
    if (!me) throw forbidden("not authorized");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      await claims.castEnum(type, "payment_type");
      await claims.castEnum(method, "payment_method");
      const o = await claims.order(orderId);
      if (!o) throw notFound("order not found");
      if (o.vendor_user_id !== me.userId) throw forbidden("not authorized");
      if (method === "card") throw badRequest("use online payment for card charges");
      if (amount == null || amount <= 0) throw badRequest("amount must be positive");
      const report = await claims.buyerReport(orderId, type);
      if (!report) throw badRequest("The customer must tap “I’ve paid the vendor” before a vendor can confirm this payment.");
      if (await claims.differsFromPayment(amount, report)) {
        throw badRequest("Payment amount does not match the customer reported amount.");
      }
      await claims.confirmClaimByVendor(report, method);
      await claims.setOrderState(orderId, "escalation_cleared");
      return { id: report };
    });
  }

  /**
   * Replaces: public.raise_dispute(uuid, text), public.raise_dispute(uuid, text, jsonb) - the buyer or the
   * vendor reports a problem with an order (with up to 3 photos they uploaded for it); the order is disputed.
   * FIX (BASELINE_FINDINGS S4): signed out, the original let anyone dispute any order.
   */
  async raise(me: Identity | null, orderId: string, reason: string | null, attachments?: unknown): Promise<{ id: string }> {
    return this.run(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("order not found");
      const isVendor = me != null && o.vendor_user_id === me.userId;
      if (!me || (!isVendor && o.buyer_id !== me.userId)) throw forbidden("not authorized");
      if (sqlTrim(reason ?? "") === "") throw badRequest("reason is required");
      let files: unknown[] | undefined;
      if (attachments !== undefined) {
        const list = attachments ?? [];
        if (!Array.isArray(list)) throw badRequest("attachments must be a list");
        if (list.length > 3) throw badRequest("You can attach up to 3 images.");
        const prefix = `${me.userId}/${orderId}/`;
        files = list.map((a) => {
          const file = (a ?? {}) as { path?: unknown; name?: unknown; type?: unknown };
          const path = typeof file.path === "string" ? file.path : file.path == null ? null : JSON.stringify(file.path);
          if (path == null || !likePrefix(path, prefix)) throw badRequest("invalid attachment");
          const name = file.name == null ? "photo" : String(file.name);
          return { path, name: [...name].slice(0, 80).join(""), type: file.type == null ? "image/jpeg" : String(file.type) };
        });
      }
      const id = await claims.newDispute(orderId, isVendor ? "vendor" : "buyer", reason!, files);
      await claims.setOrderState(orderId, "disputed");
      return { id };
    });
  }

  /** Replaces: public.resolve_dispute(uuid, text, order_status) - an admin closes a dispute, optionally setting the order's status. */
  async resolve(me: Identity | null, disputeId: string, notes: string | null, status: string | null): Promise<{ done: true }> {
    await this.run(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      if (status != null) await claims.castEnum(status, "order_status");
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("not authorized");
      const orderId = await claims.disputeOrderId(disputeId);
      if (!orderId) throw notFound("dispute not found");
      await claims.resolveDispute(disputeId, notes);
      if (status != null) await claims.setOrderStatus(orderId, status);
    });
    return { done: true };
  }

  /** Replaces: public.vendor_respond_to_dispute(uuid, text) - the vendor's side of the story. */
  async respond(me: Identity | null, disputeId: string, response: string | null): Promise<{ done: true }> {
    await this.run(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const d = await claims.disputeOrder(disputeId);
      if (!d) throw notFound("Dispute not found");
      if (!(await new AccessRepository(tx).ownsVendor(me?.userId, d.vendor_id))) throw forbidden("Not authorized");
      await claims.setVendorResponse(disputeId, response);
    });
    return { done: true };
  }

  /** Replaces: public.admin_cancel_confirmed_overdue_order(uuid) - payment never verified a day after confirmation: both sides are told. */
  async cancelOverdue(me: Identity | null, orderId: string): Promise<Result> {
    if (!me) throw forbidden("Admin access required.");
    return this.db().onBehalfOf(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me.userId))) throw forbidden("Admin access required.");
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (o.status !== "confirmed" || o.payment_escalated_at == null) throw badRequest("This order is not an overdue confirmed payment case.");
      if (!o.confirmed_a_day_ago) throw badRequest("This order has not been confirmed for 24 hours yet.");
      if (await claims.paid(orderId, ["sale_price", "rental_fee"])) throw badRequest("This order has a verified payment and cannot be cancelled by this escalation action.");
      await claims.setOrderState(orderId, "overdue_cancelled");
      const notify = new NotificationWriter(tx);
      const body = "This confirmed order was cancelled because payment was not verified after the 24-hour payment follow-up period.";
      for (const userId of [o.buyer_id, o.vendor_user_id]) {
        await notify.create({ userId, type: "order_cancelled", title: "Order cancelled", body, targetView: "orderDetail", targetParams: { orderId }, actorId: me.userId });
      }
      return { success: true, status: "cancelled" };
    });
  }

  /**
   * Replaces: public.create_payment_intent(uuid) - the pending card payments for an order and the amount
   * to charge (Paystack reference "medris_...").
   * FIX (BASELINE_FINDINGS B2): the original always charged total + deposit_amount. For sale orders the
   * deposit is part of the total (all of it when paying up front), so the buyer was charged twice; only a
   * rental's refundable deposit is charged on top of the rental fee now.
   */
  async paymentIntent(me: Identity | null, orderId: string): Promise<{ reference: string; amount: number }[]> {
    if (!me) throw forbidden("not authorized");
    return this.db().onBehalfOf(me, async (tx) => {
      const claims = new PaymentClaimsRepository(tx);
      const o = await claims.order(orderId, false);
      if (!o) throw notFound("order not found");
      if (o.buyer_id !== me.userId) throw forbidden("not authorized");
      if (!["pending", "confirmed"].includes(o.status)) throw badRequest("this order can no longer be paid online");
      await claims.deletePending(orderId);
      const reference = `medris_${crypto.randomUUID().replace(/-/g, "")}`;
      const rental = o.order_type !== "sale";
      await claims.insertCardPayment(orderId, rental ? "rental_fee" : "sale_price", o.total_amount ?? "0", reference);
      const extraDeposit = rental && (await claims.isPositive(o.deposit_amount));
      if (extraDeposit) await claims.insertCardPayment(orderId, "deposit", o.deposit_amount!, reference);
      const amount = await claims.sum(o.total_amount, extraDeposit ? o.deposit_amount : "0");
      return [{ reference, amount: Number(amount) }];
    });
  }
}

/** PostgreSQL's `path like prefix || '%'` for a prefix of a user id and an order id (no wildcards in them but `_` in neither). */
function likePrefix(path: string, prefix: string): boolean {
  return path.startsWith(prefix);
}
