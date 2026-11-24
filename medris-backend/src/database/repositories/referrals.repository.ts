import { randomBytes, randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";
import { PointsReadsRepository, PointsRepository } from "./points.repository.js";

/** A customer's first name (or a friendly stand-in), as shown to the person they invited. */
function firstNameOf(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first === "" ? "A Levromart member" : first;
}

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
    let shop: { id: string | null; user_id: string; business_name: string | null } | null = await reads.shopByCode(c);
    if (!shop) {
      const member = await reads.userByCode(c);
      if (member) shop = { id: null, user_id: member.id, business_name: firstNameOf(member.name) };
    }
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
          note: "Your referred member brought in a customer",
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
      if (!(await jsonRow(this.db, sql`select 1 as x from public.vendors where referral_code = ${code} union all select 1 from public.users where referral_code = ${code}`))) return code;
    }
  }

  /** set_my_referral_code(): the shop of this user takes a new code. Codes are kept in capitals; the old one is remembered. */
  async changeCode(userId: string, input: string | null): Promise<Record<string, unknown>> {
    const code = String(input ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const shop = await jsonRow<{ id: string; referral_code: string | null }>(this.db, sql`select id, referral_code from public.vendors where user_id = ${userId} and deleted_at is null limit 1`);
    if (!shop) return { ok: false, error: "not_a_shop", message: "Only shops have a referral code." };
    if (code.length < 4 || code.length > 16) return { ok: false, error: "bad_length", message: "Use 4 to 16 letters or numbers, no spaces." };
    if (["VOID", "LEVROMART", "LEVROMARTADMIN", "ADMIN"].includes(code)) return { ok: false, error: "reserved", message: "That code is not available. Try another." };
    if (code === shop.referral_code) return { ok: true, referral_code: code, unchanged: true };
    if (await jsonRow(this.db, sql`select 1 as x from public.vendors where referral_code = ${code} and id <> ${shop.id}`)) {
      return { ok: false, error: "taken", message: "Someone already uses that code. Try another." };
    }
    const recent = await jsonRow<{ n: number }>(this.db, sql`select count(*)::int as n from public.vendor_referral_code_history where vendor_id = ${shop.id} and changed_at > now() - interval '1 day'`);
    if ((recent?.n ?? 0) >= 5) return { ok: false, error: "too_many", message: "You changed it a lot today. Try again tomorrow." };
    await this.db.execute(sql`select set_config('levro.referral_change', 'on', true)`);
    await this.db.execute(sql`update public.vendors set referral_code = ${code} where id = ${shop.id}`);
    await this.db.execute(sql`select set_config('levro.referral_change', 'off', true)`);
    await this.db.execute(sql`insert into public.vendor_referral_code_history (vendor_id, old_code, new_code) values (${shop.id}, ${shop.referral_code}, ${code})`);
    return { ok: true, referral_code: code };
  }
}
