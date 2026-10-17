import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { AdminLog } from "../../database/repositories/admin-log.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { ShopsRepository } from "../../database/repositories/shops.repository.js";
import { sqlTrim } from "../../lib/sql-text.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

interface Tools {
  shops: ShopsRepository;
  log: AdminLog;
  notify: NotificationWriter;
  adminId: string;
}

/** The admin's vendor tools. Every change runs on the admin's behalf and is written to the audit log. */
export class AdminVendorsService {
  constructor(private readonly db: () => DataContext) {}

  private asAdmin<T>(me: Identity | null, refusal: string, work: (t: Tools) => Promise<T>, level: "admin" | "super" = "admin"): Promise<T> {
    if (!me) return Promise.reject(forbidden(refusal));
    return this.db().onBehalfOf(me, async (tx: Tx) => {
      const access = new AccessRepository(tx);
      if (!(level === "super" ? await access.isSuperAdmin(me.userId) : await access.isAdmin(me.userId))) throw forbidden(refusal);
      return work({ shops: new ShopsRepository(tx), log: new AdminLog(tx), notify: new NotificationWriter(tx), adminId: me.userId });
    });
  }

  /** Replaces: public.admin_set_vendor_status(uuid, vendor_verification_status) - approve (shop live, account becomes a vendor), reject, or back to pending. */
  async setStatus(me: Identity | null, vendorId: string, status: string): Promise<Record<string, unknown>> {
    // The original's parameter was the enum type: an unknown value failed before anything else.
    await this.db().asService((tx) => new ShopsRepository(tx).castVerificationStatus(status));
    return this.asAdmin(me, "Only admins can change vendor status.", async ({ shops, log, adminId }) => {
      if (!["verified", "rejected", "pending"].includes(status)) throw badRequest("Invalid vendor status.");
      const vendor = await shops.lock(vendorId, "live");
      if (!vendor) throw notFound("Vendor not found.");
      if (!(await shops.userRow(vendor.user_id, true))) throw notFound("Vendor account profile not found.");
      const name = vendor.business_name ?? "this business";
      await shops.setVerification(vendorId, status);
      let action: string;
      if (status === "verified") {
        await shops.setAccountRole(vendor.user_id, "vendor");
        action = "approve_vendor";
        await shops.notifyFromAdminQuietly({
          userId: vendor.user_id,
          type: "vendor_approved",
          title: "Vendor application approved",
          body: `Congratulations! ${name} has been approved. Your Levromart vendor account is now active and your storefront is live.`,
          targetView: "vendorDashboard",
          targetParams: {},
          adminId,
        });
      } else if (status === "rejected") {
        await shops.setAccountRole(vendor.user_id, "buyer");
        action = "reject_vendor";
        await shops.notifyFromAdminQuietly({
          userId: vendor.user_id,
          type: "vendor_rejected",
          title: "Vendor application update",
          body: `Your application for ${name} was not approved at this time. Please review your application details or contact Levromart support.`,
          targetView: "home",
          targetParams: {},
          adminId,
        });
      } else {
        await shops.setAccountRole(vendor.user_id, "buyer");
        action = "set_vendor_pending";
      }
      await log.recordQuietly(adminId, action, "vendor", vendorId, name, { nameOrEmail: true });
      const user = await shops.userRow(vendor.user_id);
      return {
        success: true,
        vendor: { id: vendor.id, user_id: vendor.user_id, verification_status: status, is_active: status === "verified", lat: vendor.lat, lng: vendor.lng },
        user: { id: user?.id ?? null, role: user?.role ?? null, role_selected: user?.role_selected ?? null },
      };
    });
  }

  /** Replaces: public.admin_reject_vendor(uuid, text) - with a reason (up to 1000 characters) the applicant is shown. */
  async reject(me: Identity | null, vendorId: string, reasonInput: string | null | undefined): Promise<Record<string, unknown>> {
    return this.asAdmin(me, "Only admins can reject vendor applications.", async ({ shops, log, adminId }) => {
      const reason = sqlTrim(reasonInput ?? "");
      if (reason === "") throw badRequest("Please provide a reason for rejecting this vendor.");
      if ([...reason].length > 1000) throw badRequest("Rejection reason must be 1000 characters or fewer.");
      const vendor = await shops.lock(vendorId, "live");
      if (!vendor) throw notFound("Vendor application not found.");
      if (!(await shops.userRow(vendor.user_id, true))) throw notFound("Vendor account profile not found.");
      const name = vendor.business_name ?? "this business";
      await shops.reject(vendorId);
      await shops.setAccountRole(vendor.user_id, "buyer");
      await shops.notifyFromAdminQuietly({
        userId: vendor.user_id,
        type: "vendor_rejected",
        title: "Vendor application rejected",
        body: `Your application for ${name} was rejected by a Levromart administrator. Reason: ${reason}`,
        targetView: "home",
        targetParams: { reason },
        adminId,
      });
      await log.recordQuietly(adminId, "reject_vendor", "vendor", vendorId, `${name} — ${[...reason].slice(0, 180).join("")}`, { nameOrEmail: true });
      return { success: true, rejected: true, vendor_id: vendorId, user_id: vendor.user_id, user_role: await shops.role(vendor.user_id), reason };
    });
  }

  /** Replaces: public.admin_set_vendor_storefront_active(uuid, boolean) - pause a storefront as an admin, or reactivate it (clears every pause). */
  async setStorefront(me: Identity | null, vendorId: string, active: boolean): Promise<Record<string, unknown>> {
    return this.asAdmin(me, "Only admins can change vendor storefront status.", async ({ shops, log, adminId }) => {
      const vendor = await shops.lock(vendorId, "live");
      if (!vendor) throw notFound("Vendor not found.");
      await shops.setStorefrontByAdmin(vendorId, active);
      await log.recordQuietly(adminId, active ? "reactivate_storefront" : "pause_storefront", "vendor", vendorId, vendor.business_name ?? "this vendor", { nameOrEmail: true });
      return {
        success: true,
        vendor: {
          id: vendor.id,
          is_active: active,
          admin_paused: !active,
          commission_paused: active ? false : vendor.commission_paused,
          commission_pause_reason: active ? "admin_override" : vendor.commission_pause_reason,
        },
      };
    });
  }

  /** Replaces: public.admin_force_unlock_vendor(uuid) - reopen a storefront locked for unpaid commission (the commission stays owed). */
  async forceUnlock(me: Identity | null, vendorId: string): Promise<Record<string, unknown>> {
    return this.asAdmin(me, "Only admins can unlock vendor storefronts.", async ({ shops, log, adminId }) => {
      const vendor = await shops.lock(vendorId, "live");
      if (!vendor) throw notFound("Vendor not found.");
      const owed = Number(await shops.commissionOwed(vendorId));
      await shops.forceUnlock(vendorId);
      await log.recordQuietly(adminId, "unlock_vendor_storefront", "vendor", vendorId, vendor.business_name ?? "this vendor", { nameOrEmail: true });
      return {
        success: true,
        vendor: {
          id: vendorId,
          is_active: true,
          admin_paused: false,
          commission_paused: false,
          commission_pause_reason: "admin_override",
          commission_owed: owed,
          commission_remains_owed: owed > 0,
        },
      };
    });
  }

  /** Replaces: public.admin_delete_vendor(uuid) - to the recycle bin: listings hidden (their statuses remembered), account back to buyer. */
  async delete(me: Identity | null, vendorId: string): Promise<Record<string, unknown>> {
    return this.asAdmin(me, "Only admins can delete a vendor.", async ({ shops, log, notify, adminId }) => {
      const vendor = await shops.lock(vendorId, "live");
      if (!vendor) throw notFound("Vendor not found.");
      const name = vendor.business_name ?? "Vendor";
      await shops.recycle(vendor, adminId);
      await shops.setAccountRole(vendor.user_id, "buyer");
      await notify.createQuietly({
        userId: vendor.user_id,
        type: "vendor_deleted",
        title: "Vendor moved to recycle bin",
        body: `Your Levromart vendor account for ${name} has been deactivated by an administrator. Your storefront and listings are temporarily hidden.`,
        targetView: "home",
        targetParams: {},
        actorId: adminId,
      });
      await log.recordQuietly(adminId, "delete_vendor", "vendor", vendorId, name, { nameOrEmail: true });
      return { deleted: true, recycled: true, vendor_id: vendorId, user_id: vendor.user_id };
    });
  }

  /** Replaces: public.admin_restore_vendor(uuid) - out of the recycle bin, as it was. */
  async restore(me: Identity | null, vendorId: string): Promise<Record<string, unknown>> {
    return this.asAdmin(me, "Only admins can restore a vendor.", async ({ shops, log, adminId }) => {
      const vendor = await shops.lock(vendorId, "deleted");
      if (!vendor) throw notFound("Vendor is not in the recycle bin.");
      const { status, active } = await shops.restore(vendor);
      await shops.setAccountRole(vendor.user_id, status === "verified" ? "vendor" : "buyer");
      await log.recordQuietly(adminId, "restore_vendor", "vendor", vendorId, vendor.business_name ?? "Vendor", { nameOrEmail: true });
      return { restored: true, vendor_id: vendorId, user_id: vendor.user_id, verification_status: status, is_active: active };
    });
  }

  /** Replaces: public.admin_permanently_delete_vendor(uuid) - the super admin erases a recycled shop's details; the owner must apply again. */
  async deletePermanently(me: Identity | null, vendorId: string): Promise<Record<string, unknown>> {
    return this.asAdmin(
      me,
      "Only a super admin can permanently delete a vendor.",
      async ({ shops, log, adminId }) => {
        const vendor = await shops.lock(vendorId, "deleted");
        if (!vendor) throw notFound("Vendor is not in the recycle bin.");
        const name = vendor.business_name == null || vendor.business_name === "Deleted vendor" ? "Vendor" : vendor.business_name;
        await shops.erase(vendorId);
        await shops.setAccountRole(vendor.user_id, "buyer");
        await shops.eraseDetails(vendorId);
        await log.recordQuietly(adminId, "permanently_delete_vendor", "vendor", vendorId, name, { nameOrEmail: true });
        return { deleted_permanently: true, vendor_id: vendorId, user_id: vendor.user_id, reapply_required: true };
      },
      "super",
    );
  }

  /** Replaces: public.admin_list_locked_vendors() - verified shops switched off by an admin or for unpaid commission. */
  async locked(me: Identity | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("Admin access required.");
      return new ShopsRepository(tx).locked();
    });
  }

  /** Replaces: public.admin_list_transactions() - empty for anyone but admins. */
  async transactions(me: Identity | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => ((await new AccessRepository(tx).isAdmin(me?.userId)) ? new ShopsRepository(tx).transactions() : []));
  }

  /** Replaces: public.admin_list_vendor_payouts() - empty for anyone but admins. */
  async payouts(me: Identity | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => ((await new AccessRepository(tx).isAdmin(me?.userId)) ? new ShopsRepository(tx).payouts() : []));
  }

  /** Replaces: public.admin_review_student_verification(uuid, text, text) - approving needs a matric number; the vendor is told. */
  async reviewStudent(me: Identity | null, vendorId: string, status: string, note: string | null): Promise<{ success: true; status: string }> {
    return this.asAdmin(me, "Only admins can review student verification.", async ({ shops, notify, adminId }) => {
      if (!["approved", "rejected", "pending"].includes(status)) throw badRequest("Invalid status.");
      const row = await shops.studentVerification(vendorId);
      if (!row) throw notFound("No verification submitted for this vendor.");
      if (status === "approved" && (row.matric_pending || sqlTrim(row.matric_number ?? "") === "")) {
        throw badRequest("This vendor has not added a matric number yet, so they cannot be verified.");
      }
      const owner = await shops.decideStudentVerification(vendorId, status, note, adminId);
      await notify.createQuietly({
        userId: owner,
        type: "student_verification",
        title: status === "approved" ? "Student verification approved" : status === "rejected" ? "Student verification needs attention" : "Student verification updated",
        body:
          status === "approved"
            ? "Your student details were verified. A Verified student badge now shows on your store."
            : status === "rejected"
              ? note == null || note === ""
                ? "Please re-upload clearer documents and submit again."
                : note
              : "Your verification is back under review.",
        targetView: "vendorEditProfile",
        targetParams: {},
        actorId: null,
      });
      return { success: true, status };
    });
  }
}
