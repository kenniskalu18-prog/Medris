import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { ServiceOffersRepository, type OfferRow } from "../../database/repositories/service-offers.repository.js";
import { isSqlBlank } from "../../lib/sql-text.js";
import { AppError, badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";
import type { OfferResult } from "./service-offers.schemas.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

const changed = (message: string) => new AppError(409, "conflict", message);

/**
 * Negotiated service bookings. Every step runs on the caller's behalf (the order and payment
 * triggers see them) after the checks the database functions made.
 */
export class ServiceOffersService {
  constructor(private readonly db: () => DataContext) {}

  private run<T>(me: Identity | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    return me ? this.db().onBehalfOf(me, work) : this.db().asService(work);
  }

  /** Replaces: public.create_service_offer(uuid, text, numeric) - the buyer proposes a price; the shop is told. */
  async create(me: Identity | null, listingId: string, description: string | null | undefined, price: number | null | undefined): Promise<{ id: string }> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      if (await new AccessRepository(tx).isAdmin(me.userId)) throw forbidden("Admin accounts cannot negotiate service bookings.");
      if (isSqlBlank(description)) throw badRequest("Describe what you need from the vendor.");
      if (price == null || price <= 0) throw badRequest("Enter a valid proposed price.");
      const offers = new ServiceOffersRepository(tx);
      const listing = await offers.negotiableListing(listingId);
      if (!listing) throw badRequest("This service is not available for negotiation.");
      if (listing.vendor_user_id === me.userId) throw badRequest("You cannot negotiate with your own service.");
      const id = await offers.create(listingId, me.userId, listing.vendor_id, description, price);
      const buyerName = (await offers.userName(me.userId)) ?? "A buyer";
      await new NotificationWriter(tx).create({
        userId: listing.vendor_user_id,
        type: "service_offer_new",
        title: "New service request",
        body: `${buyerName} proposed ${await offers.money(price)} for ${listing.name}.`,
        targetView: "productDetail",
        targetParams: { productId: listingId, serviceOfferId: id },
        actorId: me.userId,
      });
      return { id };
    });
  }

  /**
   * Replaces: public.respond_service_offer(uuid, text, numeric, numeric) - the side whose turn it is
   * accepts (an order is created to pay the vendor directly), declines, or counters (up to 7 rounds).
   */
  async respond(
    me: Identity | null,
    offerId: string,
    action: string | null | undefined,
    price: number | null | undefined,
    expectedPrice: number | null | undefined,
  ): Promise<OfferResult> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const offers = new ServiceOffersRepository(tx);
      const notify = new NotificationWriter(tx);
      const offer = await offers.lock(offerId);
      if (!offer) throw notFound("Offer not found.");
      if (["expired", "declined", "completed", "disputed"].includes(offer.status)) throw badRequest("This offer can no longer be changed.");
      // The original also marked it expired, but raising the error undid that; nothing is written.
      if (offer.expired) throw badRequest("This offer has expired.");
      if (expectedPrice != null && (await offers.priceDiffers(offer.id, expectedPrice))) throw changed("This offer changed. Refresh before responding.");
      if (offer.current_offer_by === "vendor") {
        if (offer.buyer_id !== me.userId) throw forbidden("Only the buyer can respond to the vendor offer.");
      } else if (offer.vendor_user_id !== me.userId) {
        throw forbidden("Only the vendor can respond to the buyer offer.");
      }
      const product = offer.product_name ?? "the service";

      if (action === "accept") {
        const orderId = await offers.createOrder(offer);
        await offers.markAccepted(offer.id, orderId);
        await notify.create({
          userId: offer.current_offer_by === "buyer" ? offer.buyer_id : offer.vendor_user_id,
          type: "service_offer_accepted",
          title: "Service price accepted",
          body: `Your agreed price for ${product} is ${await offers.money(offer.current_price)}. You can now pay the vendor directly.`,
          targetView: "orderDetail",
          targetParams: { orderId, serviceOfferId: offer.id },
          actorId: me.userId,
        });
        return { success: true as const, status: "awaiting_payment", order_id: orderId, price: offer.current_price };
      }
      if (action === "decline") {
        await offers.markDeclined(offer.id);
        await notify.create({
          userId: offer.current_offer_by === "buyer" ? offer.vendor_user_id : offer.buyer_id,
          type: "service_offer_declined",
          title: "Service request declined",
          body: `The service request for ${product} was declined.`,
          targetView: "productDetail",
          targetParams: { productId: offer.listing_id, serviceOfferId: offer.id },
          actorId: me.userId,
        });
        return { success: true as const, status: "declined" };
      }
      if (action === "counter") {
        if (price == null || price <= 0) throw badRequest("Enter a valid counter-offer price.");
        if (offer.round_count >= 7) throw badRequest("The maximum number of counter-offers has been reached. Accept or decline this offer.");
        const newPrice = await offers.counter(offer.id, price);
        await notify.create({
          userId: offer.current_offer_by === "buyer" ? offer.buyer_id : offer.vendor_user_id,
          type: "service_offer_countered",
          title: "New service price proposed",
          body: `A new price of ${await offers.money(price)} was proposed for ${product}.`,
          targetView: "productDetail",
          targetParams: { productId: offer.listing_id, serviceOfferId: offer.id },
          actorId: me.userId,
        });
        return { success: true as const, status: "countered", price: newPrice, round_count: offer.round_count + 1 };
      }
      throw badRequest("Invalid offer action.");
    });
  }

  /** Replaces: public.report_service_offer_payment(uuid, numeric) - the buyer says they paid the agreed price; the vendor is asked to confirm. */
  async reportPayment(me: Identity | null, orderId: string, amount: number | null | undefined): Promise<OfferResult> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const offers = new ServiceOffersRepository(tx);
      const offer = await offers.lockByOrder(orderId);
      if (!offer || offer.buyer_id !== me.userId) throw forbidden("You are not authorized to report this service payment.");
      if (!["awaiting_payment", "payment_reported", "disputed"].includes(offer.status)) throw badRequest("This service offer is not awaiting payment.");
      if (amount == null || amount <= 0 || (await offers.amountDiffers(offer.id, amount))) throw badRequest("Payment amount must match the agreed service price.");
      const shop = await offers.shop(offer.vendor_id);
      const buyerName = await offers.userName(me.userId);
      const paymentId = await offers.recordReportedPayment(orderId, amount, await offers.reportedPayment(orderId));
      await offers.markReported(offer.id, orderId);
      await new NotificationWriter(tx).create({
        userId: shop?.user_id ?? null,
        type: "service_payment_reported",
        title: "Payment unresolved",
        body: `${buyerName ?? "The buyer"} says they paid ${await offers.money(amount)} for ${shop?.business_name ?? "your service"}. Check your account and either confirm the payment or raise a dispute.`,
        targetView: "orderDetail",
        targetParams: { productId: offer.listing_id, serviceOfferId: offer.id, orderId },
        actorId: me.userId,
      });
      return { success: true as const, status: "payment_unresolved", payment_id: paymentId };
    });
  }

  /** Replaces: public.confirm_service_offer_payment(uuid) - the vendor received the money: the booking is complete. */
  async confirmPayment(me: Identity | null, offerId: string): Promise<OfferResult> {
    return this.run(me, async (tx) => {
      const offers = new ServiceOffersRepository(tx);
      const offer = await this.vendorsOffer(offers, offerId, me, "Only the vendor can confirm this payment.");
      if (!["payment_reported", "disputed"].includes(offer.status)) throw badRequest("This service payment is not awaiting confirmation.");
      const paymentId = await offers.reportedPayment(offer.order_id!);
      if (!paymentId) throw notFound("Reported payment record not found.");
      await offers.confirm(offer, paymentId);
      await new NotificationWriter(tx).create({
        userId: offer.buyer_id,
        type: "service_offer_completed",
        title: "Payment confirmed",
        body: "The vendor confirmed receipt of your service payment. The booking is complete and ready for review.",
        targetView: "orderDetail",
        targetParams: { orderId: offer.order_id, serviceOfferId: offer.id, reviewEligible: true },
        actorId: me?.userId ?? null,
      });
      return { success: true as const, status: "completed", order_id: offer.order_id };
    });
  }

  /** Replaces: public.dispute_service_offer_payment(uuid) - the vendor did not receive it: a dispute for Levromart to review. */
  async disputePayment(me: Identity | null, offerId: string): Promise<OfferResult> {
    return this.run(me, async (tx) => {
      const offers = new ServiceOffersRepository(tx);
      const offer = await this.vendorsOffer(offers, offerId, me, "Only the vendor can dispute this payment.");
      if (offer.status !== "payment_reported") throw badRequest("This payment is not in a disputable state.");
      const disputeId = (await offers.openDispute(offer.order_id)) ?? (await offers.raiseDispute(offer.order_id));
      await offers.markDisputed(offer);
      const shop = await offers.shop(offer.vendor_id);
      await new NotificationWriter(tx).create({
        userId: offer.buyer_id,
        type: "service_payment_disputed",
        title: "Payment unresolved",
        body: `${shop?.business_name ?? "The vendor"} disputed the reported service payment. Levromart will review it.`,
        targetView: "orderDetail",
        targetParams: { orderId: offer.order_id, serviceOfferId: offer.id, disputeId },
        actorId: me?.userId ?? null,
      });
      return { success: true as const, status: "payment_unresolved", dispute_id: disputeId };
    });
  }

  private async vendorsOffer(offers: ServiceOffersRepository, offerId: string, me: Identity | null, refusal: string): Promise<OfferRow> {
    const offer = await offers.lock(offerId);
    if (!offer) throw notFound("Offer not found.");
    if (!(await offers.ownsShop(offer.vendor_id, me?.userId ?? null))) throw forbidden(refusal);
    return offer;
  }

  /** The caller's negotiations on a listing (newest first, up to 20). Replaces the product page's select on service_offers. */
  forListing(me: Identity, listingId: string): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new ServiceOffersRepository(tx).forListing(listingId));
  }

  /** One negotiation, if the caller is part of it. */
  one(me: Identity, offerId: string): Promise<Record<string, unknown> | null> {
    return this.db().asUser(me, (tx) => new ServiceOffersRepository(tx).one(offerId));
  }
}
