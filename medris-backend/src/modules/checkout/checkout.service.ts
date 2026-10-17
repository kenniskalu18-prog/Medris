import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { CheckoutRepository } from "../../database/repositories/checkout.repository.js";
import { badRequest, unauthenticated } from "../../shared/errors/app-error.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

export interface Delivery {
  method: string;
  address: string | null;
  phone: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Checkout: one product, a rental, a whole cart for one shop, or a package. Every order is placed
 * on the buyer's behalf, so the order triggers (payment terms, notifications, phone check) see them.
 */
export class CheckoutService {
  constructor(private readonly db: () => DataContext) {}

  /** The checks every checkout starts with; returns the shop's owner. */
  private async start(tx: Tx, me: Identity, vendorId: string | null, quantity: number | null, deliveryMethod: string, own: string): Promise<CheckoutRepository> {
    const checkout = new CheckoutRepository(tx);
    // The functions' parameter had the enum type: an unknown value failed before anything else.
    await checkout.castDeliveryMethod(deliveryMethod);
    if (await new AccessRepository(tx).isAdmin(me.userId)) throw badRequest("admin accounts cannot make purchases on Levromart");
    if (quantity !== null && quantity <= 0) throw badRequest("quantity must be positive");
    if (vendorId !== null) {
      const shop = await checkout.shop(vendorId);
      if (shop?.is_active !== true) throw badRequest("this shop is currently paused and not accepting orders");
      if (shop.user_id === me.userId) throw badRequest(own);
    }
    return checkout;
  }

  /**
   * Replaces: public.create_sale_order(uuid, uuid, integer, delivery_method, text, text, double precision, double precision, text, uuid)
   * One product (optionally a variety): price with any real discount, stock taken (never below zero),
   * delivery fee, the product's payment plan.
   */
  async sale(
    me: Identity | null,
    input: { vendorId: string; productId: string; quantity: number; delivery: Delivery; buyerNote?: string | null; variantId?: string | null },
  ): Promise<{ id: string }> {
    if (!me) throw unauthenticated("must be signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const checkout = await this.start(tx, me, input.vendorId, input.quantity, input.delivery.method, "You can't buy from your own shop.");
      const product = await checkout.product(input.productId, input.vendorId);
      if (product?.sale_price == null) throw badRequest("product is not available for sale");
      let sale = product.sale_price;
      let discount = product.discount_price;
      let variantStock: number | null = null;
      const variantId = input.variantId ?? null;
      if (variantId) {
        const variant = await checkout.lockVariant(variantId);
        if (variant?.product_id !== input.productId) throw badRequest("invalid product variety");
        variantStock = variant.quantity_available;
        const prices = await checkout.variantPrices(variantId);
        if (prices?.sale_price == null) throw badRequest("selected product variety is not available for sale");
        sale = prices.sale_price;
        discount = prices.discount_price;
      }
      const timing = product.payment_timing === "pay_before" || product.payment_timing === "pay_after" ? product.payment_timing : "pay_before";
      const percent = timing === "pay_after" ? await checkout.clampDepositPercent(product.payment_deposit_percent) : "100";
      const unit = await checkout.unitPrice(sale, discount);
      if (product.track_quantity ?? true) {
        await checkout.takeStock(input.productId, input.quantity, variantId && variantStock != null ? variantId : null);
      }
      const fee = input.delivery.method === "delivery" ? await checkout.deliveryFee(input.productId, input.delivery.lat ?? null, input.delivery.lng ?? null) : "0";
      const total = await checkout.times(unit, input.quantity, fee);
      const id = await checkout.createOrder({
        buyerId: me.userId,
        vendorId: input.vendorId,
        orderType: "sale",
        total,
        deposit: "0",
        deliveryMethod: input.delivery.method,
        deliveryAddress: input.delivery.address,
        deliveryPhone: input.delivery.phone,
        deliveryFee: fee,
        buyerNote: input.buyerNote ?? null,
        paymentTiming: timing,
        paymentDepositPercent: percent,
        commissionExempt: (product.is_service ?? false) && (product.billing_model ?? "commission") === "monthly",
      });
      await checkout.addItem(id, { productId: input.productId, quantity: input.quantity, unitPrice: unit, variantId });
      return { id };
    });
  }

  /**
   * Replaces: public.create_rental_order(uuid, uuid, integer, date, date, delivery_method, text, text, double precision, double precision)
   * Days (or weeks) × rate × quantity, the refundable deposit, and the booking of the dates.
   */
  async rental(
    me: Identity | null,
    input: { vendorId: string; productId: string; quantity: number; startDate: string; endDate: string; delivery: Delivery },
  ): Promise<{ id: string }> {
    if (!me) throw unauthenticated("must be signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const checkout = await this.start(tx, me, input.vendorId, input.quantity, input.delivery.method, "You can't rent from your own shop.");
      const product = await checkout.product(input.productId, input.vendorId, false);
      if (product?.rental_rate == null) throw badRequest("product is not available to rent");
      const timing = product.payment_timing === "pay_before" || product.payment_timing === "pay_after" ? product.payment_timing : "pay_before";
      const percent = timing === "pay_after" ? await checkout.clampDepositPercent(product.payment_deposit_percent) : null;
      const days = await checkout.rentalDays(input.startDate, input.endDate);
      if (days < 1) throw badRequest("invalid date range");
      const units = product.rental_rate_unit === "week" ? Math.ceil(days / 7) : days;
      const items = await checkout.times(product.rental_rate, units * input.quantity);
      const delivery = input.delivery.method === "delivery";
      const fee = delivery ? await checkout.deliveryFee(input.productId, input.delivery.lat ?? null, input.delivery.lng ?? null) : "0";
      const id = await checkout.createOrder({
        buyerId: me.userId,
        vendorId: input.vendorId,
        orderType: "rental",
        total: await checkout.add(items, fee),
        deposit: await checkout.times(product.deposit_amount, input.quantity),
        deliveryMethod: input.delivery.method,
        deliveryAddress: input.delivery.address,
        deliveryPhone: input.delivery.phone,
        deliveryFee: fee,
        paymentTiming: delivery ? timing : "pay_before",
        paymentDepositPercent: delivery && timing === "pay_after" ? percent : null,
      });
      const line = await checkout.addItem(id, {
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: product.rental_rate,
        rentalStart: input.startDate,
        rentalEnd: input.endDate,
      });
      await checkout.book(line, input.productId, input.startDate, input.endDate, input.quantity);
      return { id };
    });
  }

  /**
   * Replaces: public.create_cart_order(uuid, jsonb, delivery_method, text, text, double precision, double precision, text)
   * Every cart line of one shop in one order. For delivery, the lines must share a payment plan.
   */
  async cart(me: Identity | null, input: { vendorId: string; items: unknown[]; delivery: Delivery; buyerNote?: string | null }): Promise<{ id: string }> {
    if (!me) throw unauthenticated("must be signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const checkout = new CheckoutRepository(tx);
      await checkout.castDeliveryMethod(input.delivery.method);
      if (await new AccessRepository(tx).isAdmin(me.userId)) throw badRequest("admin accounts cannot make purchases on Levromart");
      if (input.items.length === 0) throw badRequest("Your cart is empty.");
      await this.start(tx, me, input.vendorId, null, input.delivery.method, "You can't buy from your own shop.");
      const delivery = input.delivery.method === "delivery";
      const id = await checkout.createOrder({
        buyerId: me.userId,
        vendorId: input.vendorId,
        orderType: "sale",
        total: "0",
        deposit: "0",
        deliveryMethod: input.delivery.method,
        deliveryAddress: input.delivery.address,
        deliveryPhone: input.delivery.phone,
        deliveryFee: "0",
        buyerNote: input.buyerNote ?? null,
        paymentTiming: "pay_before",
        paymentDepositPercent: "100",
      });
      let itemsTotal = "0";
      let fees = "0";
      let timing = "";
      let percent: string | null = null;
      for (const raw of input.items) {
        const line = await checkout.parseCartLine(raw);
        if (line.product_id == null || line.quantity == null || line.quantity <= 0) throw badRequest("invalid item in your cart");
        const product = await checkout.product(line.product_id, input.vendorId);
        if (product?.sale_price == null) throw badRequest("One of the items in your cart is no longer available.");
        const itemTiming = product.payment_timing === "pay_before" || product.payment_timing === "pay_after" ? product.payment_timing : "pay_before";
        const itemPercent = itemTiming === "pay_after" ? await checkout.clampDepositPercent(product.payment_deposit_percent) : null;
        if (delivery) {
          if (timing === "") timing = itemTiming;
          else if (timing !== itemTiming) throw badRequest("These cart items use different delivery payment plans. Please check out them separately.");
          if (itemTiming === "pay_after") {
            if (percent == null) percent = itemPercent;
            else if (await checkout.differ(percent, itemPercent!)) throw badRequest("These cart items use different delivery deposit percentages. Please check out them separately.");
          }
        }
        let sale = product.sale_price;
        let discount = product.discount_price;
        if (line.variant_id) {
          if ((await checkout.variantProduct(line.variant_id)) !== line.product_id) throw badRequest("invalid product variety");
          const prices = await checkout.variantPrices(line.variant_id);
          if (prices?.sale_price == null) throw badRequest("Selected product variety is no longer available.");
          sale = prices.sale_price;
          discount = prices.discount_price;
        }
        const unit = await checkout.unitPrice(sale, discount);
        await checkout.takeStock(line.product_id, line.quantity);
        await checkout.addItem(id, { productId: line.product_id, quantity: line.quantity, unitPrice: unit, variantId: line.variant_id });
        itemsTotal = await checkout.times(unit, line.quantity, itemsTotal);
        if (delivery) fees = await checkout.add(fees, await checkout.deliveryFee(line.product_id, input.delivery.lat ?? null, input.delivery.lng ?? null));
      }
      await checkout.finishCartOrder(id, itemsTotal, fees, input.delivery.method, timing, percent);
      return { id };
    });
  }

  /** Replaces: public.create_package_order(uuid, delivery_method, text, text) - a shop's bundle at its price (plus the shop's delivery fee). */
  async package(me: Identity | null, input: { packageId: string; delivery: Delivery }): Promise<{ id: string }> {
    if (!me) throw unauthenticated("must be signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const checkout = await this.start(tx, me, null, null, input.delivery.method, "");
      const pkg = await checkout.activePackage(input.packageId);
      if (!pkg) throw badRequest("package is not available");
      const items = await checkout.lockPackageItems(input.packageId);
      for (const item of items) {
        if (item.status !== "active" || (item.quantity_available != null && item.quantity_available < item.quantity)) {
          throw badRequest("one or more items in this package is no longer available");
        }
      }
      const fee = input.delivery.method === "delivery" ? ((await checkout.shop(pkg.vendor_id))?.delivery_fee ?? "0") : "0";
      const id = await checkout.createOrder({
        buyerId: me.userId,
        vendorId: pkg.vendor_id,
        orderType: "sale",
        total: await checkout.add(pkg.price, fee),
        deposit: "0",
        deliveryMethod: input.delivery.method,
        deliveryAddress: input.delivery.address,
        deliveryPhone: input.delivery.phone,
        deliveryFee: fee,
        packageId: input.packageId,
      });
      for (const item of items) {
        await checkout.takeStockExactly(item.product_id, item.quantity);
        await checkout.addItem(id, { productId: item.product_id, quantity: item.quantity, unitPrice: item.sale_price ?? "0" });
      }
      return { id };
    });
  }
}
