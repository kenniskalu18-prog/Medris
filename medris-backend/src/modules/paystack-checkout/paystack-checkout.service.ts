import crypto from "node:crypto";
import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { OrdersRepository } from "../../database/repositories/orders.repository.js";
import { PaymentClaimsRepository } from "../../database/repositories/payment-claims.repository.js";
import { PaystackLedgerRepository } from "../../database/repositories/paystack-ledger.repository.js";
import {
  PaystackRejected,
  PaystackUnavailable,
  PaystackUnknownOutcome,
  getPaystackClient,
  grossUpForBuyerFees,
  koboToNaira,
  nairaToKobo,
} from "../../integrations/paystack/index.js";
import { AppError, badRequest, conflict, featureDisabled, forbidden, notFound, serviceUnavailable } from "../../shared/errors/app-error.js";
import { PaystackWebhookService } from "../paystack-webhook/paystack-webhook.service.js";

const PAYABLE_STATES = ["pending", "confirmed", "handed_over"];
/** An attempt whose Paystack link was made less than this long ago is handed out again instead of starting a new one. */
const REUSE_SECONDS = 25 * 60;
/** An attempt that has no link yet is still being set up for this long (a second tap must wait). */
const SETTING_UP_SECONDS = 90;

interface Step {
  reuse: { reference: string; authorization: { authorization_url?: string; access_code?: string }; grossKobo: number; feeKobo: number; netKobo: number } | null;
  fresh: { reference: string; purpose: string; grossKobo: number; feeKobo: number; netKobo: number; paymentType: string; email: string | null } | null;
}

/**
 * Paying for an order with Paystack (issue #95). The amount always comes from the database (what is outstanding on the
 * order: the delivery deposit first for pay-after-delivery, then the balance), plus Paystack's fee, which the buyer pays.
 * The order is confirmed only when Paystack confirms the payment (webhook, or the buyer coming back: same code path).
 */
export class PaystackCheckoutService {
  constructor(
    private readonly db: () => DataContext,
    private readonly checkoutEnabled: boolean,
  ) {}

  config(): { paystackCheckout: boolean } {
    return { paystackCheckout: this.checkoutEnabled };
  }

  async initialize(me: Identity, orderId: string, appOrigin: string) {
    if (!this.checkoutEnabled) throw featureDisabled("Paystack checkout");

    // 1. decide and record (one transaction; the order row is locked, so two taps are handled one after the other)
    const step = await this.db().asService(async (tx): Promise<Step> => {
      const claims = new PaymentClaimsRepository(tx);
      const ledger = new PaystackLedgerRepository(tx);
      const o = await claims.order(orderId);
      if (!o) throw notFound("Order not found.");
      if (o.buyer_id !== me.userId) throw forbidden("You can only pay for your own orders.");
      if (o.status === "payment_unresolved") throw badRequest("A payment on this order is being checked. Please wait for the vendor to confirm it.");
      if (!PAYABLE_STATES.includes(o.status)) throw badRequest("This order can no longer be paid online.");
      const due = await claims.outstanding(o);
      if (due === "none" || due.expected == null || !(Number(due.expected) > 0)) throw badRequest("There is nothing left to pay on this order.");

      // outstanding() keeps naming the balance after it has been paid, so ask whether this very payment is already done
      if (await claims.paid(orderId, [due.type])) throw badRequest("There is nothing left to pay on this order.");
      const netKobo = nairaToKobo(Number(due.expected));
      const { grossKobo, feeKobo } = grossUpForBuyerFees(netKobo);
      const purpose = due.type === "delivery_deposit_20" || !(o.delivery_method === "delivery" && o.payment_timing === "pay_after") ? "order_payment" : "order_balance";

      // a double tap gets the same link back; a changed amount (the order was edited) abandons the old attempt
      for (const open of await ledger.openAttempts(orderId)) {
        const sameAmount = BigInt(open.amount_kobo) === BigInt(grossKobo) && open.purpose === purpose;
        if (sameAmount && open.authorization?.authorization_url && open.age_seconds < REUSE_SECONDS) {
          return { reuse: { reference: open.reference, authorization: open.authorization, grossKobo, feeKobo, netKobo }, fresh: null };
        }
        if (sameAmount && !open.authorization && open.age_seconds < SETTING_UP_SECONDS) throw conflict("Your payment is being set up. Please try again in a moment.");
        await ledger.setTransactionStatus(open.reference, "abandoned", ["initialized"]);
        await claims.deletePendingByReference(open.reference);
      }

      const reference = `lvm_ord_${orderId.replace(/-/g, "").slice(0, 8)}_${crypto.randomBytes(8).toString("hex")}`;
      await ledger.insertAttempt({ reference, purpose, orderId, vendorId: o.vendor_id, payerUserId: me.userId, amountKobo: grossKobo });
      // the payment row the order's totals use: the order amount only, never the fee
      await claims.insertCardPayment(orderId, due.type, String(due.expected), reference);
      return { reuse: null, fresh: { reference, purpose, grossKobo, feeKobo, netKobo, paymentType: due.type, email: me.email } };
    });

    if (step.reuse) {
      const r = step.reuse;
      return result(r.reference, r.authorization.authorization_url ?? "", r.authorization.access_code ?? "", r.grossKobo, r.feeKobo, r.netKobo);
    }
    const f = step.fresh!;

    // 2. ask Paystack (never inside a database transaction)
    const email = f.email ?? (await this.db().asService((tx) => new OrdersRepository(tx).checkoutContacts(orderId)))?.buyer?.email ?? null;
    if (!email) {
      await this.dropAttempt(f.reference);
      throw badRequest("We could not find an email address for your account.");
    }
    try {
      const started = await getPaystackClient().initializeTransaction({
        email,
        amountKobo: f.grossKobo,
        reference: f.reference,
        callbackUrl: `${appOrigin}/?paid=1&reference=${encodeURIComponent(f.reference)}&orderId=${encodeURIComponent(orderId)}`,
        metadata: { order_id: orderId, purpose: f.purpose, buyer_id: me.userId, payment_type: f.paymentType, fee_kobo: f.feeKobo, net_kobo: f.netKobo },
      });
      // 3. keep the link so a double tap gets the same one
      await this.db().asService((tx) => new PaystackLedgerRepository(tx).storeAuthorization(f.reference, { authorization_url: started.authorization_url, access_code: started.access_code }));
      return result(f.reference, started.authorization_url, started.access_code, f.grossKobo, f.feeKobo, f.netKobo);
    } catch (err) {
      // nothing was started on Paystack's side that the buyer could pay (no link was handed out), so the attempt can be dropped
      await this.dropAttempt(f.reference);
      if (err instanceof PaystackRejected) throw badRequest(err.message);
      if (err instanceof PaystackUnknownOutcome || err instanceof PaystackUnavailable) throw serviceUnavailable("Paystack could not be reached. Please try again in a moment.");
      throw err;
    }
  }

  /** Where a payment stands. Settles it first (the same steps as the webhook) when it is still open. */
  async status(me: Identity, reference: string) {
    const found = await this.db().asService(async (tx) => {
      const ledger = new PaystackLedgerRepository(tx);
      const t = await ledger.transactionByReference(reference);
      if (!t) return null;
      const payer = await ledger.payerOf(reference);
      const admin = payer !== me.userId ? await new AccessRepository(tx).isAdmin(me.userId) : false;
      return { t, allowed: payer === me.userId || admin };
    });
    if (!found || !found.allowed) throw notFound("Payment not found.");

    if (found.t.status === "initialized") {
      try {
        await new PaystackWebhookService(this.db).confirmByReference(reference);
      } catch (err) {
        if (!(err instanceof AppError) && !(err instanceof PaystackUnknownOutcome) && !(err instanceof PaystackUnavailable) && !(err instanceof PaystackRejected)) throw err;
        // Paystack cannot be asked right now: report what we know; the webhook or the reconciliation job will settle it
      }
    }
    return this.db().asService(async (tx) => {
      const ledger = new PaystackLedgerRepository(tx);
      const t = await ledger.transactionByReference(reference);
      const order = t?.order_id ? await ledger.orderStatus(t.order_id) : null;
      return { status: t?.status ?? "unknown", orderStatus: order };
    });
  }

  private async dropAttempt(reference: string): Promise<void> {
    await this.db()
      .asService(async (tx) => {
        await new PaystackLedgerRepository(tx).setTransactionStatus(reference, "abandoned", ["initialized"]);
        await new PaymentClaimsRepository(tx).deletePendingByReference(reference);
      })
      .catch(() => undefined);
  }
}

function result(reference: string, authorizationUrl: string, accessCode: string, grossKobo: number, feeKobo: number, netKobo: number) {
  return { authorizationUrl, accessCode, reference, amountNaira: koboToNaira(grossKobo), feeNaira: koboToNaira(feeKobo), orderAmountNaira: koboToNaira(netKobo) };
}
