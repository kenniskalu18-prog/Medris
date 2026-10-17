import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { textArray, uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/**
 * A shop's columns anyone may see. FIX S12: the table showed every column of every verified shop to anyone -
 * bank account, Paystack codes (including the card authorization for monthly billing), ID documents, billing
 * and commission settings. (The CAC registration number stays public: the product page shows it as a trust sign.) The shop's owner and admins still get every column; a buyer
 * gets the bank details of a shop they ordered from on the order page.
 */
const PUBLIC = sql`v.id, v.user_id, v.business_name, v.logo_url, v.cover_image_url, v.cover_url, v.bio, v.address, v.city, v.phone,
  case when v.whatsapp_visible then v.whatsapp_number end as whatsapp_number, v.whatsapp_visible, v.verification_status, v.opening_hours,
  v.business_hours, v.allow_after_hours_messages, v.avg_rating, v.review_count, v.created_at, v.is_active, v.delivery_radius_km, v.delivery_fee,
  v.delivery_fee_mode, v.delivery_fee_per_km, v.sector_id, v.lat, v.lng, v.previous_business_name, v.name_changed_at, v.referral_code,
  v.campus_id, v.operating_scope, v.operating_campuses, v.request_pref, v.student_verified, v.campus_setup_done, v.profile_view_count, v.deleted_at,
  v.cac_number`;

/** Every column for the shop's owner and admins; the public ones for everyone else. */
const visibleColumns = (me: string | null) =>
  sql`case when v.user_id = ${me}::uuid or coalesce((select u.role = 'admin' from public.users u where u.id = ${me}::uuid), false)
           then to_jsonb(v) else (select to_jsonb(p) from (select ${PUBLIC}) p) end`;

/** The fields a shop's owner may change on their shop (FIX S11: never its verification, activity, pauses, ratings or billing). */
export interface ShopChanges {
  business_name?: string;
  sector_id?: string;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  whatsapp_number?: string | null;
  whatsapp_visible?: boolean;
  bio?: string | null;
  opening_hours?: string | null;
  business_hours?: Record<string, unknown> | null;
  allow_after_hours_messages?: boolean;
  logo_url?: string | null;
  cover_url?: string | null;
  lat?: number | null;
  lng?: number | null;
  request_pref?: string;
  operating_scope?: string;
  operating_campuses?: string[];
  request_campus_scope?: string;
  campus_id?: string | null;
  campus_setup_done?: boolean;
  verification_docs?: string[];
}

export interface ShopListFilter {
  ids: string[] | null;
  sectorId: string | null;
  q: string | null;
  /** Only shops marked as student-verified. */
  studentVerified: boolean;
  /** false: verified, active, not deleted (the public lists); true: any shop the caller may see. */
  anyStatus: boolean;
  orderBy: "name" | "rating" | "id" | "none";
  limit: number;
  offset: number;
}

/**
 * vendors rows as the app's table queries read and changed them. Run as the user: row-level security (public
 * shops, one's own, shops one bought from, admins) and the triggers (onboarding rules, phone checks, role sync,
 * renaming notice, commission lock, points) still decide.
 */
export class ShopRowsRepository {
  constructor(private readonly db: Executor) {}

  /** `from("vendors").select("*").eq("user_id", me).is("deleted_at", null).maybeSingle()` */
  mine(me: string): Promise<Record<string, unknown> | null> {
    return jsonRow(this.db, sql`select v.* from public.vendors v where v.user_id = ${me} and v.deleted_at is null limit 1`);
  }

  /** `from("vendors").select("*, sector:sectors(name, icon)").eq("id", id)[.eq("verification_status", "verified")][.eq("is_active", true)]` */
  async one(me: string | null, vendorId: string, o: { verified: boolean; active: boolean }): Promise<Record<string, unknown> | null> {
    const row = await jsonRow<{ shop: Record<string, unknown> }>(
      this.db,
      sql`select ${visibleColumns(me)} || jsonb_build_object('sector', (select json_build_object('name', s.name, 'icon', s.icon) from public.sectors s where s.id = v.sector_id)) as shop
          from public.vendors v
          where v.id = ${vendorId} ${o.verified ? sql`and v.verification_status = 'verified'` : sql``} ${o.active ? sql`and v.is_active = true` : sql``}`,
    );
    return row?.shop ?? null;
  }

  /** The shop lists (home, shops page, search, Levi, maps): the public columns, verified and active unless `anyStatus`. */
  async list(me: string | null, f: ShopListFilter): Promise<Record<string, unknown>[]> {
    const where: SQL[] = [];
    if (!f.anyStatus) where.push(sql`v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null`);
    if (f.ids) where.push(sql`v.id = any(${uuidArray(f.ids)})`);
    if (f.sectorId) where.push(sql`v.sector_id = ${f.sectorId}`);
    if (f.q) where.push(sql`v.business_name ilike ${`%${f.q.replace(/[%_\\]/g, "")}%`}`);
    if (f.studentVerified) where.push(sql`v.student_verified = true`);
    const order =
      f.orderBy === "name" ? sql`order by v.business_name` : f.orderBy === "rating" ? sql`order by v.avg_rating desc nulls last` : f.orderBy === "id" ? sql`order by v.id` : sql``;
    const rows = await jsonRows<{ shop: Record<string, unknown> }>(
      this.db,
      sql`select ${visibleColumns(me)} as shop from public.vendors v
          ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``} ${order} limit ${f.limit} offset ${f.offset}`,
    );
    return rows.map((r) => r.shop);
  }

  /**
   * The admin's shop lists: live applications and shops (`.is("deleted_at", null)`, optionally one status) or the
   * recycle bin (`.not("deleted_at", "is", null)`), each with the applicant's name and email.
   */
  adminList(deleted: boolean, status: string | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select v.id, v.business_name, v.address, v.city, v.phone, v.whatsapp_number, v.cac_number, v.bio, v.verification_docs, v.verification_status,
                 v.avg_rating, v.review_count, v.created_at, v.deleted_at, v.deleted_previous_verification_status, v.deleted_previous_is_active,
                 (select json_build_object('name', u.name, 'email', u.email) from public.users u where u.id = v.user_id) as applicant
          from public.vendors v
          where ${deleted ? sql`v.deleted_at is not null` : sql`v.deleted_at is null`} ${status ? sql`and v.verification_status::text = ${status}` : sql``}
          order by ${deleted ? sql`v.deleted_at desc` : sql`v.created_at desc`}`,
    );
  }

  /** `update({ ... }).eq("id", ownShop)` - only the fields given, on the caller's own live shop. How many changed. */
  async update(me: string, c: ShopChanges): Promise<number> {
    const col: [keyof ShopChanges, SQL][] = [];
    const add = (k: keyof ShopChanges, v: SQL) => c[k] !== undefined && col.push([k, v]);
    add("business_name", sql`business_name = ${c.business_name ?? null}`);
    add("sector_id", sql`sector_id = ${c.sector_id ?? null}::uuid`);
    add("address", sql`address = ${c.address ?? null}`);
    add("city", sql`city = ${c.city ?? null}`);
    add("phone", sql`phone = ${c.phone ?? null}`);
    add("whatsapp_number", sql`whatsapp_number = ${c.whatsapp_number ?? null}`);
    add("whatsapp_visible", sql`whatsapp_visible = ${c.whatsapp_visible ?? null}`);
    add("bio", sql`bio = ${c.bio ?? null}`);
    add("opening_hours", sql`opening_hours = ${c.opening_hours ?? null}`);
    add("business_hours", sql`business_hours = ${c.business_hours == null ? null : JSON.stringify(c.business_hours)}::jsonb`);
    add("allow_after_hours_messages", sql`allow_after_hours_messages = ${c.allow_after_hours_messages ?? null}`);
    add("logo_url", sql`logo_url = ${c.logo_url ?? null}`);
    add("cover_url", sql`cover_url = ${c.cover_url ?? null}`);
    add("lat", sql`lat = ${c.lat ?? null}::double precision`);
    add("lng", sql`lng = ${c.lng ?? null}::double precision`);
    add("request_pref", sql`request_pref = ${c.request_pref ?? null}`);
    add("operating_scope", sql`operating_scope = ${c.operating_scope ?? null}`);
    add("operating_campuses", sql`operating_campuses = ${textArray(c.operating_campuses ?? [])}`);
    add("request_campus_scope", sql`request_campus_scope = ${c.request_campus_scope ?? null}`);
    add("campus_id", sql`campus_id = ${c.campus_id ?? null}`);
    add("campus_setup_done", sql`campus_setup_done = ${c.campus_setup_done ?? null}`);
    add("verification_docs", sql`verification_docs = ${textArray(c.verification_docs ?? [])}`);
    if (col.length === 0) return 0;
    return (
      await jsonReturning(
        this.db,
        sql`update public.vendors set ${sql.join(
          col.map(([, v]) => v),
          sql`, `,
        )} where user_id = ${me} and deleted_at is null returning id`,
      )
    ).length;
  }

  /** `update({ bank_code, bank_name, account_name, account_number, paystack_subaccount_code })` on the caller's own live shop. */
  async setPayout(me: string, p: { bank_code: string; bank_name: string; account_name: string | null; account_number: string; paystack_subaccount_code: string | null }): Promise<number> {
    return (
      await jsonReturning(
        this.db,
        sql`update public.vendors set bank_code = ${p.bank_code}, bank_name = ${p.bank_name}, account_name = ${p.account_name}, account_number = ${p.account_number},
                   paystack_subaccount_code = coalesce(${p.paystack_subaccount_code}::text, paystack_subaccount_code)
            where user_id = ${me} and deleted_at is null returning id`,
      )
    ).length;
  }

  /** `delete().eq("id", id).eq("user_id", me)` - the application's clean-up after a failed step. Users may not delete shops: 0, as before. */
  async removeOwn(me: string, vendorId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from public.vendors where id = ${vendorId} and user_id = ${me} returning id`)).length;
  }
}
