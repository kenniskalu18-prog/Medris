import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/** What a shop's owner sends for student verification (the review fields are never theirs to set). */
export interface StudentVerificationInput {
  matric_number: string | null;
  matric_pending: boolean;
  faculty: string | null;
  department: string | null;
  level: string | null;
  id_card_url: string | null;
  biodata_url: string | null;
  selfie_url: string | null;
  face_distance: number | null;
  face_match: string | null;
  face_liveness: boolean | null;
  face_checked_at: string | null;
  face_v: number | null;
}

/**
 * Smaller shop records the app read and wrote directly: product varieties (reading), student verification
 * and monthly-listing receipts. Run as the user: row-level security (varieties of active listings or one's own;
 * one's own verification and receipts; admins) still decides.
 */
export class ShopRecordsRepository {
  constructor(private readonly db: Executor) {}

  /** `from("product_variants").select("*").in("product_id", ids).order("sort_order").order("created_at")` (and `.eq("product_id", id)`). */
  variants(productIds: string[]): Promise<Record<string, unknown>[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    return jsonRows(this.db, sql`select * from public.product_variants where product_id = any(${uuidArray(productIds)}) order by sort_order asc, created_at asc`);
  }

  /** `from("vendor_student_verification").select("*").eq("vendor_id", id).maybeSingle()` - the shop's owner and admins. */
  studentVerification(vendorId: string): Promise<Record<string, unknown> | null> {
    return jsonRow(this.db, sql`select * from public.vendor_student_verification where vendor_id = ${vendorId}`);
  }

  /** `select("vendor_id,status,matric_pending")` - every verification the caller may see (admins: all). */
  studentVerificationStatuses(): Promise<{ vendor_id: string; status: string; matric_pending: boolean }[]> {
    return jsonRows(this.db, sql`select vendor_id, status, matric_pending from public.vendor_student_verification`);
  }

  /**
   * `upsert({ vendor_id, ... }, { onConflict: "vendor_id" })` - the owner (re)submits; the request is always
   * pending again (the table refuses anything else, and an approved one cannot be changed).
   */
  async submitStudentVerification(vendorId: string, r: StudentVerificationInput): Promise<void> {
    await this.db.execute(sql`
      insert into public.vendor_student_verification (vendor_id, matric_number, matric_pending, faculty, department, level, id_card_url, biodata_url,
                                                      selfie_url, face_distance, face_match, face_liveness, face_checked_at, face_v, status)
      values (${vendorId}, ${r.matric_number}, ${r.matric_pending}, ${r.faculty}, ${r.department}, ${r.level}, ${r.id_card_url}, ${r.biodata_url},
              ${r.selfie_url}, ${r.face_distance}::real, ${r.face_match}, ${r.face_liveness}::boolean, ${r.face_checked_at}::timestamptz, coalesce(${r.face_v}::int, 0), 'pending')
      on conflict (vendor_id) do update set
        matric_number = excluded.matric_number, matric_pending = excluded.matric_pending, faculty = excluded.faculty, department = excluded.department,
        level = excluded.level, id_card_url = excluded.id_card_url, biodata_url = excluded.biodata_url, selfie_url = excluded.selfie_url,
        face_distance = excluded.face_distance, face_match = excluded.face_match, face_liveness = excluded.face_liveness,
        face_checked_at = excluded.face_checked_at, face_v = excluded.face_v, status = 'pending', updated_at = now()`);
  }

  /** `update({ ocr_matric_found, ocr_name_found, ocr_text, ocr_checked_at: now, status: "pending" }).eq("vendor_id", id)` */
  async recordOcr(vendorId: string, o: { matric: boolean | null; name: boolean | null; text: string | null }): Promise<number> {
    return (
      await jsonReturning(
        this.db,
        sql`update public.vendor_student_verification set ocr_matric_found = ${o.matric}::boolean, ocr_name_found = ${o.name}::boolean, ocr_text = ${o.text},
                   ocr_checked_at = now(), status = 'pending'
            where vendor_id = ${vendorId} returning vendor_id`,
      )
    ).length;
  }

  /** The shop's monthly-listing receipts, newest first (`select(...).eq("vendor_id", shop)[.eq("kind", kind)].order("submitted_at", desc).limit(100)`). */
  shopSubmissions(vendorId: string, kind: string | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, kind, listing_id, status, submitted_at, reviewed_at, review_note, payer_name, receipt_path from public.monthly_listing_submissions
          where vendor_id = ${vendorId} ${kind ? sql`and kind = ${kind}` : sql``} order by submitted_at desc limit 100`,
    );
  }

  /** The pending receipt of one listing (`.eq("kind", kind).eq("listing_id", id).eq("status", "pending")...limit(1).maybeSingle()`). */
  pendingFor(kind: string, listingId: string): Promise<Record<string, unknown> | null> {
    return jsonRow(
      this.db,
      sql`select id, kind, listing_id, payer_name, receipt_path, status, submitted_at, review_note from public.monthly_listing_submissions
          where kind = ${kind} and listing_id = ${listingId} and status = 'pending' order by submitted_at desc limit 1`,
    );
  }

  /** Every pending receipt the caller may see (admins: all; a shop: its own), and the latest 100 of all (admins). */
  pending(vendorId: string | null): Promise<{ id: string; kind: string; listing_id: string; vendor_id: string }[]> {
    return jsonRows(
      this.db,
      sql`select id, kind, listing_id, vendor_id from public.monthly_listing_submissions where status = 'pending' ${vendorId ? sql`and vendor_id = ${vendorId}` : sql``}`,
    );
  }

  latest(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, kind, listing_id, vendor_id, user_id, payer_name, receipt_path, status, submitted_at, reviewed_at, review_note
          from public.monthly_listing_submissions order by submitted_at desc limit 100`,
    );
  }
}
