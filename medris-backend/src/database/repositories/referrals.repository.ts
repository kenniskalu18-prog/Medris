import { randomBytes, randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";
import { PointsReadsRepository, PointsRepository } from "./points.repository.js";

/** Referral codes: who brought whom to Levromart, and the points for it. */
export class ReferralsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Replaces: public.apply_referral_internal(uuid, text, boolean) - records the referral and, for a
   * buyer account, gives the shop (and whoever referred that shop) customer-referral points.
   */
  async apply(userId: string | null, code: string | null, skipCustomer: boolean): Promise<Record<string, unknown>> {
    const reads = new PointsReadsRepository(this.db);
    const c = await reads.normaliseCode(code);
    if (!userId || c === "") return { ok: false, error: "no_code" };
    const user = await reads.profile(userId);
    if (!user) return { ok: false, error: "no_profile" };
    if (await reads.referralOf(userId)) return { ok: false, error: "already_used", message: "You have already used a referral code." };
    if (user.too_late) return { ok: false, error: "too_late", message: "Referral codes can only be added within 7 days of creating your account." };
    const shop = await reads.shopByCode(c);
    if (!shop) return { ok: false, error: "invalid", message: "That referral code was not found." };
    const owner = await reads.profile(shop.user_id);
    if (shop.user_id === userId || ((user.phone ?? "") !== "" && user.phone === owner?.phone)) {
      return { ok: false, error: "own_code", message: "You cannot use your own referral code." };
    }
    await reads.recordReferral(userId, shop, c);
    if (!skipCustomer && user.role === "buyer" && !(await reads.isVendorAccount(userId))) {
      const points = new PointsRepository(this.db);
      await points.award({ userId: shop.user_id, kind: "ref_customer", key: `refc:${userId}`, sourceUserId: userId, note: "Customer joined with your code" });
      const upline = await reads.referralOf(shop.user_id);
      if (upline) {
        await points.award({
          userId: upline.referrer_user_id,
          kind: "ref2_customer",
          key: `refc2:${userId}`,
          sourceUserId: userId,
          note: "Your referred vendor brought in a customer",
        });
      }
    }
    return { ok: true, business_name: shop.business_name };
  }

  /**
   * Replaces: public.generate_referral_code(text) - up to five letters/digits of the name (LEVRO when fewer than
   * three) plus three random digits; after 20 taken codes, five random hex characters instead.
   * The random parts can be supplied (tests).
   */
  async generateCode(name: string | null, random: { digits?: () => number; hex?: () => string } = {}): Promise<string> {
    const digits = random.digits ?? (() => randomInt(100, 1000));
    const hex = random.hex ?? (() => randomBytes(3).toString("hex").slice(0, 5).toUpperCase());
    let base = (name ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 5).toUpperCase();
    if (base.length < 3) base = "LEVRO";
    for (let attempt = 1; ; attempt += 1) {
      const code = attempt > 20 ? base + hex() : base + String(digits()).padStart(3, "0");
      if (!(await jsonRow(this.db, sql`select 1 as x from public.vendors where referral_code = ${code}`))) return code;
    }
  }
}
