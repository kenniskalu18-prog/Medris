import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow } from "../json.js";
import { AppError } from "../../shared/errors/app-error.js";

/** Amounts travel as PostgreSQL numeric text, so totals are exact. */
type Numeric = string;

export interface SaleProduct {
  sale_price: Numeric | null;
  discount_price: Numeric | null;
  quantity_available: number | null;
  payment_timing: string | null;
  payment_deposit_percent: Numeric | null;
  is_service: boolean | null;
  billing_model: string | null;
  track_quantity: boolean | null;
}

export interface NewOrder {
  buyerId: string;
  vendorId: string;
  orderType: "sale" | "rental";
  total: Numeric;
  deposit: Numeric;
  deliveryMethod: string;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryFee: Numeric;
  buyerNote?: string | null;
  paymentTiming?: string | null;
  paymentDepositPercent?: Numeric | null;
  commissionExempt?: boolean;
  packageId?: string | null;
}

/**
 * Placing orders: the shop and product checks, prices (discounts, varieties), stock, delivery fees
 * and rental bookings, exactly as the checkout functions computed them.
 */
export class CheckoutRepository {
  constructor(private readonly db: Executor) {}

  shop(vendorId: string): Promise<{ is_active: boolean | null; user_id: string | null; delivery_fee: Numeric | null } | null> {
    return jsonRow(this.db, sql`select is_active, user_id, coalesce(delivery_fee, 0)::text as delivery_fee from public.vendors where id = ${vendorId}`);
  }

  /** An active product of the shop, locked for the stock change (or not, for rentals). */
  async product(productId: string, vendorId: string, lock = true): Promise<(SaleProduct & { rental_rate: Numeric | null; rental_rate_unit: string | null; deposit_amount: Numeric }) | null> {
    const [row] = rowsOf<{ row: SaleProduct & { rental_rate: Numeric | null; rental_rate_unit: string | null; deposit_amount: Numeric } }>(
      await this.db.execute(sql`
        select json_build_object(
          'sale_price', p.sale_price::text, 'discount_price', p.discount_price::text, 'quantity_available', p.quantity_available,
          'payment_timing', p.payment_timing::text, 'payment_deposit_percent', p.payment_deposit_percent::text, 'is_service', p.is_service,
          'billing_model', p.billing_model, 'track_quantity', p.track_quantity, 'rental_rate', p.rental_rate::text,
          'rental_rate_unit', p.rental_rate_unit::text, 'deposit_amount', coalesce(p.deposit_amount, 0)::text) as row
        from public.products p where p.id = ${productId} and p.vendor_id = ${vendorId} and p.status = 'active' ${lock ? sql`for update` : sql``}`),
    );
    return row?.row ?? null;
  }

  /** A variety (locked), its product and stock. */
  async lockVariant(variantId: string): Promise<{ product_id: string; quantity_available: number | null } | null> {
    const [row] = rowsOf<{ product_id: string; quantity_available: number | null }>(
      await this.db.execute(sql`select product_id, quantity_available from public.product_variants where id = ${variantId} for update`),
    );
    return row ?? null;
  }

  async variantProduct(variantId: string): Promise<string | null> {
    return (await jsonRow<{ product_id: string }>(this.db, sql`select product_id from public.product_variants where id = ${variantId}`))?.product_id ?? null;
  }

  variantPrices(variantId: string): Promise<{ sale_price: Numeric | null; discount_price: Numeric | null } | null> {
    return jsonRow(this.db, sql`select sale_price::text as sale_price, discount_price::text as discount_price from public.product_variants where id = ${variantId}`);
  }

  /** The discount when it is a real one (above 0, below the price), otherwise the price. */
  async unitPrice(sale: Numeric, discount: Numeric | null): Promise<Numeric> {
    const row = await jsonRow<{ p: Numeric }>(
      this.db,
      sql`select (case when ${discount}::numeric is not null and ${discount}::numeric > 0 and ${discount}::numeric < ${sale}::numeric then ${discount}::numeric else ${sale}::numeric end)::text as p`,
    );
    return row!.p;
  }

  /** a × b (+ c), exactly. */
  async times(a: Numeric | number, b: Numeric | number, plus: Numeric | number = 0): Promise<Numeric> {
    return (await jsonRow<{ v: Numeric }>(this.db, sql`select (${String(a)}::numeric * ${String(b)}::numeric + ${String(plus)}::numeric)::text as v`))!.v;
  }

  async add(a: Numeric | number, b: Numeric | number): Promise<Numeric> {
    return this.times(a, 1, b);
  }

  /** Stock goes down, never below zero. */
  async takeStock(productId: string, quantity: number, variantId: string | null = null): Promise<void> {
    if (variantId) await this.db.execute(sql`update public.product_variants set quantity_available = greatest(quantity_available - ${quantity}::int, 0) where id = ${variantId}`);
    else await this.db.execute(sql`update public.products set quantity_available = greatest(quantity_available - ${quantity}::int, 0) where id = ${productId}`);
  }

  /** Package orders take stock without the zero floor (the availability was checked first). */
  async takeStockExactly(productId: string, quantity: number): Promise<void> {
    await this.db.execute(sql`update public.products set quantity_available = quantity_available - ${quantity}::int where id = ${productId}`);
  }

  /**
   * Replaces: public.compute_product_delivery_fee(uuid, double precision, double precision)
   * Free, a flat fee, or per kilometre by straight-line distance from the shop (rounded to ₦50, at
   * least one kilometre). A distance fee needs the buyer's location.
   */
  async deliveryFee(productId: string, lat: number | null, lng: number | null): Promise<Numeric> {
    const p = await jsonRow<{ mode: string | null; fee: Numeric; per_km: Numeric; vlat: number | null; vlng: number | null }>(
      this.db,
      sql`select p.delivery_fee_mode::text as mode, coalesce(p.delivery_fee, 0)::text as fee, coalesce(p.delivery_fee_per_km, 0)::text as per_km, v.lat as vlat, v.lng as vlng
          from public.products p join public.vendors v on v.id = p.vendor_id where p.id = ${productId}`,
    );
    if (!p || p.mode == null || p.mode === "free") return "0";
    if (p.mode === "flat") return p.fee;
    if (p.mode !== "distance") return "0";
    if (Number(p.per_km) <= 0) return "0";
    if (p.vlat == null || p.vlng == null) return p.fee;
    if (lat == null || lng == null) throw new AppError(400, "bad_request", "Share your location to get this product's delivery fee.");
    const row = await jsonRow<{ fee: Numeric }>(
      this.db,
      sql`with c as (
            select radians(${lat}::double precision - ${p.vlat}::double precision) as dlat, radians(${lng}::double precision - ${p.vlng}::double precision) as dlng),
          a as (select sin(dlat/2)^2 + cos(radians(${p.vlat}::double precision)) * cos(radians(${lat}::double precision)) * sin(dlng/2)^2 as a from c)
          select (round((${p.per_km}::numeric * greatest(6371::double precision * 2 * atan2(sqrt(a), sqrt(1 - a)), 1)) / 50) * 50)::text as fee from a`,
    );
    return row!.fee;
  }

  /** The order row; optional columns are written only when given (otherwise the column default, as each function did). */
  async createOrder(o: NewOrder): Promise<string> {
    const cols = [sql`buyer_id`, sql`vendor_id`, sql`order_type`, sql`status`, sql`total_amount`, sql`deposit_amount`, sql`delivery_method`, sql`delivery_address`, sql`delivery_phone`, sql`delivery_fee`];
    const vals = [
      sql`${o.buyerId}::uuid`,
      sql`${o.vendorId}::uuid`,
      sql`${o.orderType}::public.order_type`,
      sql`'pending'`,
      sql`${o.total}::numeric`,
      sql`${o.deposit}::numeric`,
      sql`${o.deliveryMethod}::public.delivery_method`,
      sql`${o.deliveryAddress}::text`,
      sql`${o.deliveryPhone}::text`,
      sql`${o.deliveryFee}::numeric`,
    ];
    const optional: [keyof NewOrder, string, (v: unknown) => ReturnType<typeof sql>][] = [
      ["buyerNote", "buyer_note", (v) => sql`nullif(trim(${v as string | null}::text), '')`],
      ["paymentTiming", "payment_timing", (v) => sql`${v as string | null}::text`],
      ["paymentDepositPercent", "payment_deposit_percent", (v) => sql`${v as string | null}::numeric`],
      ["commissionExempt", "commission_exempt", (v) => sql`${v as boolean | null}::boolean`],
      ["packageId", "package_id", (v) => sql`${v as string | null}::uuid`],
    ];
    for (const [key, column, value] of optional) {
      if (o[key] === undefined) continue;
      cols.push(sql.raw(column));
      vals.push(value(o[key]));
    }
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`insert into public.orders (${sql.join(cols, sql`, `)}) values (${sql.join(vals, sql`, `)}) returning id`),
    );
    return row!.id;
  }

  async addItem(
    orderId: string,
    item: { productId: string; quantity: number; unitPrice: Numeric; variantId?: string | null; rentalStart?: string | null; rentalEnd?: string | null },
  ): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.order_items (order_id, product_id, quantity, unit_price, variant_id, rental_start_date, rental_end_date)
        values (${orderId}, ${item.productId}, ${item.quantity}::int, ${item.unitPrice}::numeric, ${item.variantId ?? null}::uuid,
                ${item.rentalStart ?? null}::date, ${item.rentalEnd ?? null}::date)
        returning id`),
    );
    return row!.id;
  }

  /* ---------------------------------------------------------------- rentals */

  /** Days in an inclusive date range (PostgreSQL date arithmetic; malformed dates fail like the database). */
  async rentalDays(start: string, end: string): Promise<number> {
    return (await jsonRow<{ d: number }>(this.db, sql`select (${end}::date - ${start}::date) + 1 as d`))!.d;
  }

  /**
   * Replaces: public.create_rental_booking(uuid, uuid, date, date, integer)
   * Books the product's units for the dates, refusing when the overlapping bookings would exceed the
   * product's total quantity.
   */
  async book(orderItemId: string, productId: string, start: string, end: string, quantity: number): Promise<string> {
    if (quantity <= 0) throw new AppError(400, "bad_request", "quantity must be positive");
    const order = await jsonRow<{ ok: boolean }>(this.db, sql`select ${end}::date >= ${start}::date as ok`);
    if (!order!.ok) throw new AppError(400, "bad_request", "end date must be on or after start date");
    const range = await jsonRow<{ r: string }>(this.db, sql`select daterange(${start}::date, ${end}::date, '[]')::text as r`);
    const [product] = rowsOf<{ quantity_total: number | null }>(await this.db.execute(sql`select quantity_total from public.products where id = ${productId} for update`));
    if (product?.quantity_total == null) throw new AppError(400, "bad_request", `product ${productId} not found`);
    const booked = (await jsonRow<{ n: number }>(
      this.db,
      sql`select coalesce(sum(quantity), 0)::int as n from public.bookings where product_id = ${productId} and date_range && ${range!.r}::daterange`,
    ))!.n;
    if (booked + quantity > product.quantity_total) {
      throw new AppError(400, "bad_request", `not enough availability for product ${productId} in range ${range!.r}`);
    }
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`insert into public.bookings (product_id, order_item_id, date_range, quantity) values (${productId}, ${orderItemId}, ${range!.r}::daterange, ${quantity}::int) returning id`),
    );
    return row!.id;
  }

  /* ---------------------------------------------------------------- packages */

  activePackage(packageId: string): Promise<{ id: string; vendor_id: string; price: Numeric } | null> {
    return jsonRow(this.db, sql`select id, vendor_id, price::text as price from public.vendor_packages where id = ${packageId} and status = 'active'`);
  }

  /** The package's products (locked), with their stock and status. */
  async lockPackageItems(packageId: string): Promise<{ product_id: string; quantity: number; quantity_available: number | null; status: string; sale_price: Numeric | null }[]> {
    return rowsOf<{ row: { product_id: string; quantity: number; quantity_available: number | null; status: string; sale_price: Numeric | null } }>(
      await this.db.execute(sql`
        select json_build_object('product_id', pi.product_id, 'quantity', pi.quantity, 'quantity_available', p.quantity_available,
                                 'status', p.status::text, 'sale_price', p.sale_price::text) as row
        from public.package_items pi join public.products p on p.id = pi.product_id
        where pi.package_id = ${packageId}
        for update of p`),
    ).map((r) => r.row);
  }

  /* ---------------------------------------------------------------- cart order */

  /** One cart line as create_cart_order() read it (conversions in PostgreSQL, so a malformed id or quantity fails the same way). */
  async parseCartLine(item: unknown): Promise<{ product_id: string | null; variant_id: string | null; quantity: number | null }> {
    return (await jsonRow(
      this.db,
      sql`select nullif(i->>'product_id','')::uuid as product_id, nullif(i->>'variant_id','')::uuid as variant_id, (i->>'quantity')::int as quantity
          from (select ${JSON.stringify(item ?? null)}::jsonb as i) x`,
    ))!;
  }

  /** The cart order's final amounts. */
  async finishCartOrder(orderId: string, itemsTotal: Numeric, deliveryFee: Numeric, deliveryMethod: string, timing: string, percent: Numeric | null): Promise<void> {
    await this.db.execute(sql`
      update public.orders
      set total_amount = ${itemsTotal}::numeric + ${deliveryFee}::numeric, delivery_fee = ${deliveryFee}::numeric,
          payment_timing = case when ${deliveryMethod}::text = 'delivery' and ${timing}::text <> '' then ${timing}::text else 'pay_before' end,
          payment_deposit_percent = case when ${deliveryMethod}::text = 'delivery' and ${timing}::text = 'pay_after' then ${percent}::numeric else 100 end,
          deposit_amount = case when ${deliveryMethod}::text = 'delivery' and ${timing}::text = 'pay_after'
                                then round((${itemsTotal}::numeric + ${deliveryFee}::numeric) * ${percent}::numeric / 100, 2)
                                else ${itemsTotal}::numeric + ${deliveryFee}::numeric end
      where id = ${orderId}`);
  }

  /** |a - b| > 0.001 */
  async differ(a: Numeric, b: Numeric): Promise<boolean> {
    return (await jsonRow<{ d: boolean }>(this.db, sql`select abs(${a}::numeric - ${b}::numeric) > 0.001 as d`))!.d;
  }

  /** greatest(1, least(99, coalesce(percent, 20))) */
  async clampDepositPercent(percent: Numeric | null): Promise<Numeric> {
    return (await jsonRow<{ v: Numeric }>(this.db, sql`select greatest(1, least(99, coalesce(${percent}::numeric, 20)))::text as v`))!.v;
  }

  /** Fails like PostgreSQL does for a value that is not a delivery_method. */
  async castDeliveryMethod(method: string): Promise<void> {
    await this.db.execute(sql`select ${method}::public.delivery_method`);
  }
}
