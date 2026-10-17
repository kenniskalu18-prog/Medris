import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

export interface VendorApplication {
  sectorId: string;
  businessName: string;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  whatsapp: string;
  cacNumber?: string | null;
  bio?: string | null;
  bankCode?: string | null;
  bankName?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
}

/** The fields the vendor functions read from a vendors row. */
export interface VendorRow {
  id: string;
  user_id: string;
  business_name: string | null;
  verification_status: string;
  is_active: boolean;
  admin_paused: boolean | null;
  commission_paused: boolean | null;
  commission_pause_reason: string | null;
  deleted_previous_verification_status: string | null;
  deleted_previous_is_active: boolean | null;
  lat: number | null;
  lng: number | null;
}

const VENDOR_FIELDS = sql`id, user_id, business_name, verification_status::text as verification_status, is_active, admin_paused, commission_paused,
  commission_pause_reason, deleted_previous_verification_status::text as deleted_previous_verification_status, deleted_previous_is_active, lat, lng`;

/** Shops: applying, the storefront switch, and the admin's vendor tools. */
export class ShopsRepository {
  constructor(private readonly db: Executor) {}

  /** The user's shop (any one, as the functions' `limit 1`) and its verification status. */
  anyShopOf(userId: string): Promise<{ id: string; verification_status: string } | null> {
    return jsonRow(this.db, sql`select id, verification_status::text as verification_status from public.vendors where user_id = ${userId} limit 1`);
  }

  async liveShopIdOf(userId: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.vendors where user_id = ${userId} and deleted_at is null limit 1`))?.id ?? null;
  }

  /** submit_vendor_application(): a new application, or the existing shop row reset to a pending application. */
  async apply(userId: string, a: VendorApplication): Promise<string> {
    const t = (v: string | null | undefined) => sql`nullif(btrim(${v ?? null}::text), '')`;
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.vendors (user_id, sector_id, business_name, address, city, phone, whatsapp_number, cac_number, bio,
                                    bank_code, bank_name, account_name, account_number, is_active, verification_status, deleted_at)
        values (${userId}, ${a.sectorId}, btrim(${a.businessName}::text), ${t(a.address)}, ${t(a.city)}, ${t(a.phone)}, btrim(${a.whatsapp}::text),
                ${t(a.cacNumber)}, ${t(a.bio)}, ${t(a.bankCode)}, ${t(a.bankName)}, ${t(a.accountName)}, ${t(a.accountNumber)},
                false, 'pending'::public.vendor_verification_status, null)
        on conflict (user_id) do update set
          sector_id = excluded.sector_id, business_name = excluded.business_name, address = excluded.address, city = excluded.city,
          phone = excluded.phone, whatsapp_number = excluded.whatsapp_number, cac_number = excluded.cac_number, bio = excluded.bio,
          bank_code = excluded.bank_code, bank_name = excluded.bank_name, account_name = excluded.account_name,
          account_number = excluded.account_number, is_active = false,
          verification_status = 'pending'::public.vendor_verification_status, deleted_at = null
        returning id`),
    );
    return row!.id;
  }

  /** The user's newest live shop, locked. */
  async lockOwnShop(userId: string): Promise<VendorRow | null> {
    const [row] = rowsOf<{ row: VendorRow }>(
      await this.db.execute(sql`
        select to_json(x) as row from (
          select ${VENDOR_FIELDS} from public.vendors where user_id = ${userId} and deleted_at is null
          order by created_at desc nulls last limit 1 for update) x`),
    );
    return row?.row ?? null;
  }

  /** A shop, locked: a live one, or (deleted) one in the recycle bin. */
  async lock(vendorId: string, which: "live" | "deleted"): Promise<VendorRow | null> {
    const filter = which === "live" ? sql`deleted_at is null` : sql`deleted_at is not null`;
    const [row] = rowsOf<{ row: VendorRow }>(
      await this.db.execute(sql`select to_json(x) as row from (select ${VENDOR_FIELDS} from public.vendors where id = ${vendorId} and ${filter} for update) x`),
    );
    return row?.row ?? null;
  }

  /** get_vendor_commission_owed()'s sum: owed commission on completed orders. Numeric as text. */
  async commissionOwed(vendorId: string): Promise<string> {
    const row = await jsonRow<{ owed: string }>(
      this.db,
      sql`select coalesce(sum(c.amount),0)::text as owed from public.commission_charges c join public.orders o on o.id = c.order_id
          where c.vendor_id = ${vendorId} and c.status = 'owed' and o.status = 'completed'`,
    );
    return row!.owed;
  }

  /** The vendor's own switch: on clears every pause, off keeps them. */
  async setOwnStorefront(vendorId: string, active: boolean): Promise<void> {
    await this.db.execute(sql`
      update public.vendors
      set is_active = ${active},
          admin_paused = case when ${active} then false else coalesce(admin_paused, false) end,
          commission_paused = case when ${active} then false else commission_paused end,
          commission_pause_reason = case when ${active} then null else commission_pause_reason end
      where id = ${vendorId}`);
  }

  async setBillingModel(vendorId: string, model: string): Promise<void> {
    await this.db.execute(sql`update public.vendors set billing_model = ${model} where id = ${vendorId}`);
  }

  /* ------------------------------------------------------------------- admin tools */

  async userRow(userId: string, lock = false): Promise<{ id: string; role: string; role_selected: boolean | null } | null> {
    const [row] = rowsOf<{ row: { id: string; role: string; role_selected: boolean | null } }>(
      await this.db.execute(sql`select to_json(x) as row from (select id, role::text as role, role_selected from public.users where id = ${userId} ${lock ? sql`for update` : sql``}) x`),
    );
    return row?.row ?? null;
  }

  /** Fails like PostgreSQL does for a value that is not a vendor_verification_status. */
  async castVerificationStatus(status: string): Promise<void> {
    await this.db.execute(sql`select ${status}::public.vendor_verification_status`);
  }

  /** The verification decision; a decided shop is shown (verified) or hidden, and no longer paused by an admin. */
  async setVerification(vendorId: string, status: string): Promise<void> {
    await this.db.execute(sql`
      update public.vendors
      set verification_status = ${status}::public.vendor_verification_status,
          is_active = (${status}::public.vendor_verification_status = 'verified'::public.vendor_verification_status),
          avg_rating = coalesce(avg_rating, 0), review_count = coalesce(review_count, 0), admin_paused = false
      where id = ${vendorId}`);
  }

  async reject(vendorId: string): Promise<void> {
    await this.db.execute(sql`update public.vendors set verification_status = 'rejected'::public.vendor_verification_status, is_active = false where id = ${vendorId}`);
  }

  /** The account's role (admins are never changed). */
  async setAccountRole(userId: string, role: "vendor" | "buyer"): Promise<void> {
    await this.db.execute(sql`update public.users set role = ${role}::public.user_role, role_selected = true where id = ${userId} and role <> 'admin'`);
  }

  async role(userId: string): Promise<string | null> {
    return (await jsonRow<{ role: string }>(this.db, sql`select role::text as role from public.users where id = ${userId}`))?.role ?? null;
  }

  /** A notification written directly with the admin's name as actor (name, else email, else "Levromart Admin"); never fails the caller. */
  async notifyFromAdminQuietly(n: { userId: string; type: string; title: string; body: string; targetView: string; targetParams: Record<string, unknown>; adminId: string }): Promise<void> {
    try {
      await this.db.transaction((sp) =>
        sp.execute(sql`
          insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name)
          values (${n.userId}, ${n.type}, ${n.title}, ${n.body}, ${n.targetView}, ${JSON.stringify(n.targetParams)}::jsonb, ${n.adminId},
                  (select coalesce(name, email, 'Levromart Admin') from public.users where id = ${n.adminId}))`),
      );
    } catch {
      // ignored, as the original did (it only raised a warning)
    }
  }

  /** The admin's storefront switch: off pauses it as an admin; on clears the pauses ("admin override"). */
  async setStorefrontByAdmin(vendorId: string, active: boolean): Promise<void> {
    await this.db.execute(sql`
      update public.vendors
      set is_active = ${active},
          admin_paused = case when ${active} then false else true end,
          commission_paused = case when ${active} then false else commission_paused end,
          commission_pause_reason = case when ${active} then 'admin_override' else commission_pause_reason end
      where id = ${vendorId}`);
  }

  async forceUnlock(vendorId: string): Promise<void> {
    await this.db.execute(sql`update public.vendors set is_active = true, admin_paused = false, commission_paused = false, commission_pause_reason = 'admin_override' where id = ${vendorId}`);
  }

  /** admin_delete_vendor(): remembers every listing's status, hides them all, and moves the shop to the recycle bin. */
  async recycle(vendor: VendorRow, adminId: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.vendor_recycle_bin (vendor_id, deleted_at, deleted_by, product_statuses, package_statuses)
      values (${vendor.id}, now(), ${adminId},
              coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status::text)) from public.products p where p.vendor_id = ${vendor.id}), '[]'::jsonb),
              coalesce((select jsonb_agg(jsonb_build_object('id', vp.id, 'status', vp.status::text)) from public.vendor_packages vp where vp.vendor_id = ${vendor.id}), '[]'::jsonb))
      on conflict (vendor_id) do update set deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
        product_statuses = excluded.product_statuses, package_statuses = excluded.package_statuses`);
    await this.db.execute(sql`update public.products set status = 'removed' where vendor_id = ${vendor.id} and status <> 'removed'`);
    await this.db.execute(sql`update public.vendor_packages set status = 'removed' where vendor_id = ${vendor.id} and status <> 'removed'`);
    await this.db.execute(sql`
      update public.vendors
      set is_active = false, verification_status = 'rejected'::public.vendor_verification_status,
          deleted_previous_verification_status = ${vendor.verification_status}::public.vendor_verification_status,
          deleted_previous_is_active = ${vendor.is_active}, deleted_at = now()
      where id = ${vendor.id}`);
  }

  /** admin_restore_vendor(): back with its previous status, and every listing with the status it had. Returns the status. */
  async restore(vendor: VendorRow): Promise<{ status: string; active: boolean }> {
    const status = vendor.deleted_previous_verification_status && vendor.deleted_previous_verification_status !== "" ? vendor.deleted_previous_verification_status : "verified";
    const active = vendor.deleted_previous_is_active ?? false;
    await this.db.execute(sql`
      update public.vendors
      set deleted_at = null, verification_status = ${status}::public.vendor_verification_status, is_active = ${active},
          deleted_previous_verification_status = null, deleted_previous_is_active = null
      where id = ${vendor.id}`);
    const bin = await jsonRow<{ product_statuses: { id: string; status: string }[]; package_statuses: { id: string; status: string }[] }>(
      this.db,
      sql`select product_statuses, package_statuses from public.vendor_recycle_bin where vendor_id = ${vendor.id}`,
    );
    if (bin) {
      for (const item of bin.product_statuses) {
        await this.db.execute(sql`update public.products set status = ${item.status}::public.product_status where id = ${item.id}::uuid and vendor_id = ${vendor.id}`);
      }
      for (const item of bin.package_statuses) {
        // FIX (BASELINE_FINDINGS B10): the original assigned the text without a cast to the column's
        // type (product_status), which PostgreSQL refuses - restoring a shop that had packages failed.
        await this.db.execute(sql`update public.vendor_packages set status = ${item.status}::public.product_status where id = ${item.id}::uuid and vendor_id = ${vendor.id}`);
      }
    } else {
      await this.db.execute(sql`update public.products set status = 'active' where vendor_id = ${vendor.id} and status = 'removed'`);
      await this.db.execute(sql`update public.vendor_packages set status = 'active' where vendor_id = ${vendor.id} and status = 'removed'`);
    }
    await this.db.execute(sql`delete from public.vendor_recycle_bin where vendor_id = ${vendor.id}`);
    return { status, active };
  }

  /** admin_permanently_delete_vendor(): listings removed, the shop's details erased ("Deleted vendor"), the bin entry gone. */
  async erase(vendorId: string): Promise<void> {
    await this.db.execute(sql`update public.products set status = 'removed' where vendor_id = ${vendorId}`);
    await this.db.execute(sql`update public.vendor_packages set status = 'removed' where vendor_id = ${vendorId}`);
  }

  async eraseDetails(vendorId: string): Promise<void> {
    await this.db.execute(sql`
      update public.vendors
      set is_active = false, verification_status = 'rejected'::public.vendor_verification_status, deleted_at = coalesce(deleted_at, now()),
          business_name = 'Deleted vendor', bio = null, address = null, city = null, phone = null, whatsapp_number = null,
          cac_number = null, logo_url = null, cover_image_url = null, cover_url = null, verification_docs = '{}'::text[]
      where id = ${vendorId}`);
    await this.db.execute(sql`delete from public.vendor_recycle_bin where vendor_id = ${vendorId}`);
  }

  /** admin_list_locked_vendors(): verified shops that are switched off because an admin or unpaid commission paused them. */
  locked(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select v.id as vendor_id, v.business_name, v.city, u.name as applicant_name, u.email as applicant_email,
                 coalesce(v.admin_paused,false) as admin_paused, coalesce(v.commission_paused,false) as commission_paused, v.commission_pause_reason,
                 coalesce((select sum(c.amount) from public.commission_charges c join public.orders o on o.id = c.order_id
                           where c.vendor_id = v.id and c.status = 'owed' and o.status = 'completed'), 0) as commission_owed
          from public.vendors v left join public.users u on u.id = v.user_id
          where v.deleted_at is null and v.verification_status = 'verified' and v.is_active = false
            and (coalesce(v.admin_paused,false) = true or coalesce(v.commission_paused,false) = true)
          order by v.business_name asc`,
    );
  }

  /** admin_list_transactions(): the latest 300 payments with shop, buyer and Levromart's cut. */
  transactions(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select p.id as payment_id, p.created_at, p.order_id, p.payment_type, p.amount, p.method, p.status, p.provider_reference,
                 v.business_name as vendor_name, u.name as buyer_name, v.commission_pct, round(p.amount * v.commission_pct / 100, 2) as platform_cut
          from public.payments p join public.orders o on o.id = p.order_id join public.vendors v on v.id = o.vendor_id join public.users u on u.id = o.buyer_id
          order by p.created_at desc limit 300`,
    );
  }

  /** admin_list_vendor_payouts(): every live shop with bank details, sales and the state of its commission. */
  payouts(): Promise<Record<string, unknown>[]> {
    const owedCharges = sql`from public.commission_charges c join public.orders o on o.id = c.order_id where c.vendor_id = v.id and c.status = 'owed' and o.status = 'completed'`;
    const due = sql`(select min(coalesce(c.due_at, c.created_at + interval '7 days')) ${owedCharges})`;
    const owed = sql`coalesce((select sum(c.amount) ${owedCharges}), 0)`;
    return jsonRows(
      this.db,
      sql`select v.id as vendor_id, v.business_name, v.verification_status, v.bank_name, v.account_number, v.account_name, v.paystack_subaccount_code, v.commission_pct,
                 (select count(*)::int from public.orders o where o.vendor_id = v.id and o.status = 'completed') as completed_orders,
                 (select coalesce(sum(p.amount),0) from public.payments p join public.orders o on o.id = p.order_id where o.vendor_id = v.id and p.status = 'paid') as total_paid_in,
                 ${owed} as commission_owed,
                 ${due} as commission_due_at,
                 case when ${due} is null then null else floor(extract(epoch from (${due} - now())) / 86400)::int end as commission_days_remaining,
                 case when ${owed} <= 0 then 'paid' when ${due} <= now() then 'overdue' when ${due} <= now() + interval '48 hours' then 'due_soon' else 'owing' end as commission_status,
                 v.commission_paused, v.commission_pause_reason, coalesce(v.admin_paused,false) as admin_paused, v.is_active
          from public.vendors v where v.deleted_at is null order by v.business_name`,
    );
  }

  /* --------------------------------------------------------- student verification */

  studentVerification(vendorId: string): Promise<{ matric_pending: boolean; matric_number: string | null } | null> {
    return jsonRow(this.db, sql`select matric_pending, matric_number from public.vendor_student_verification where vendor_id = ${vendorId}`);
  }

  /** The admin's decision; the shop's "Verified student" badge follows it. Returns the shop owner. */
  async decideStudentVerification(vendorId: string, status: string, note: string | null, adminId: string): Promise<string | null> {
    await this.db.execute(sql`
      update public.vendor_student_verification set status = ${status}, review_note = ${note}, reviewed_by = ${adminId}, reviewed_at = now(), updated_at = now()
      where vendor_id = ${vendorId}`);
    const [row] = rowsOf<{ user_id: string }>(
      await this.db.execute(sql`update public.vendors set student_verified = (${status}::text = 'approved') where id = ${vendorId} returning user_id`),
    );
    return row?.user_id ?? null;
  }

  /** submit_face_check(): the selfie match and ID-card text check results, kept on the shop's verification. */
  async recordFaceCheck(
    vendorId: string,
    c: { selfieUrl: string | null; distance: number | null; match: string | null; liveness: boolean | null; ocrMatric: boolean | null; ocrName: boolean | null; ocrText: string | null },
  ): Promise<void> {
    await this.db.execute(sql`
      update public.vendor_student_verification set
        selfie_url = coalesce(${c.selfieUrl}::text, selfie_url), face_distance = ${c.distance}::real, face_match = ${c.match}::text, face_liveness = ${c.liveness}::boolean,
        face_checked_at = now(), face_v = 2,
        ocr_matric_found = coalesce(${c.ocrMatric}::boolean, ocr_matric_found), ocr_name_found = coalesce(${c.ocrName}::boolean, ocr_name_found),
        ocr_text = coalesce(left(${c.ocrText}::text, 400), ocr_text),
        ocr_checked_at = case when ${c.ocrMatric}::boolean is not null or ${c.ocrName}::boolean is not null or ${c.ocrText}::text is not null then now() else ocr_checked_at end
      where vendor_id = ${vendorId}`);
  }
}

/** Schools for campus listings: what users typed when their school was not in the list, and the admin's review. */
export class CampusRepository {
  constructor(private readonly db: Executor) {}

  /** Replaces: public.lv_norm_school(text) - lower case, letters and digits only - the key schools are matched on. */
  async normalise(name: string | null): Promise<string> {
    return (await jsonRow<{ n: string }>(this.db, sql`select lower(regexp_replace(coalesce(${name}::text,''),'[^a-zA-Z0-9]','','g')) as n`))!.n;
  }

  /** submit_campus_school(): a new submission, or one more request for the same school. */
  submit(norm: string, name: string, userId: string): Promise<{ status: string; merged_into: string | null }[]> {
    return jsonReturning(
      this.db,
      sql`insert into public.campus_submissions (name_norm, name, submitted_by) values (${norm}, left(trim(${name}::text), 80), ${userId})
          on conflict (name_norm) do update set requests = public.campus_submissions.requests + 1
          returning status, merged_into`,
    );
  }

  /** campus_school_names(): pending and approved schools, newest first (500). */
  names(): Promise<{ name: string; status: string }[]> {
    return jsonRows(this.db, sql`select name, status from public.campus_submissions where status in ('pending','approved') order by created_at desc limit 500`);
  }

  /** admin_campus_submissions(): pending schools, with how many accounts and shops use each. */
  pending(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select s.name_norm, s.name, s.requests,
                 (select count(*) from public.users u where u.campus_id like 'custom:%' and lower(regexp_replace(coalesce(substr(u.campus_id,8),''),'[^a-zA-Z0-9]','','g')) = s.name_norm) as users_count,
                 (select count(*) from public.vendors v where v.campus_id like 'custom:%' and lower(regexp_replace(coalesce(substr(v.campus_id,8),''),'[^a-zA-Z0-9]','','g')) = s.name_norm) as vendors_count,
                 s.created_at
          from public.campus_submissions s where s.status = 'pending' order by s.created_at`,
    );
  }

  /** Points every account and shop that typed this school at `campusId` ('none' when rejected). */
  async reassign(norm: string, campusId: string): Promise<void> {
    for (const table of [sql`public.users`, sql`public.vendors`]) {
      await this.db.execute(sql`
        update ${table} set campus_id = ${campusId}
        where campus_id like 'custom:%' and lower(regexp_replace(coalesce(substr(campus_id,8),''),'[^a-zA-Z0-9]','','g')) = ${norm}`);
    }
  }

  async setStatus(norm: string, status: "approved" | "merged" | "rejected", mergedInto: string | null = null): Promise<void> {
    await this.db.execute(sql`
      update public.campus_submissions set status = ${status}, reviewed_at = now() ${status === "merged" ? sql`, merged_into = ${mergedInto}` : sql``}
      where name_norm = ${norm}`);
  }
}
