import type { DataContext, Identity } from "../../database/context.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { ShopsRepository, type VendorApplication } from "../../database/repositories/shops.repository.js";
import { isSqlBlank, sqlTrim } from "../../lib/sql-text.js";
import { badRequest, forbidden, notFound, unauthenticated } from "../../shared/errors/app-error.js";
import { ShopRowsRepository, type ShopChanges, type ShopListFilter } from "../../database/repositories/shop-rows.repository.js";
import { ShopRecordsRepository, type StudentVerificationInput } from "../../database/repositories/shop-records.repository.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";

export interface FaceCheck {
  selfieUrl?: string | null;
  distance?: number | null;
  match?: string | null;
  liveness?: boolean | null;
  ocrMatric?: boolean | null;
  ocrName?: boolean | null;
  ocrText?: string | null;
}

/** A vendor's own shop: applying, the storefront switch, the billing model and the student face check. */
export class ShopsService {
  constructor(private readonly db: () => DataContext) {}

  /**
   * Replaces: public.submit_vendor_application(uuid, text, text, text, text, text, text, text, text, text, text, text)
   * Sends (or re-sends) the application; the applicant and every admin are told.
   */
  async apply(me: Identity | null, a: { [K in keyof VendorApplication]?: VendorApplication[K] | null }): Promise<{ id: string }> {
    if (!me) throw unauthenticated("You must be signed in to submit a vendor application.");
    if (isSqlBlank(a.businessName)) throw badRequest("Business name is required.");
    if (isSqlBlank(a.whatsapp)) throw badRequest("WhatsApp number is required.");
    if (!a.sectorId) throw badRequest("Business sector is required.");
    const application = { ...a, businessName: a.businessName, whatsapp: a.whatsapp, sectorId: a.sectorId };
    return this.db().onBehalfOf(me, async (tx) => {
      const shops = new ShopsRepository(tx);
      const existing = await shops.anyShopOf(me.userId);
      if (existing && existing.verification_status === "verified") throw badRequest("Your vendor account is already active.");
      const id = await shops.apply(me.userId, application);
      const notify = new NotificationWriter(tx);
      await notify.create({
        userId: me.userId,
        type: "vendor_application_submitted",
        title: "Application submitted",
        body: "Your vendor application has been submitted successfully and is now awaiting review.",
        targetView: "home",
        targetParams: { vendorId: id },
        actorId: null,
      });
      await notify.notifyAdmins("New vendor application", `${sqlTrim(application.businessName)} submitted a vendor application awaiting review.`, "adminPanel", { vendorId: id }, me.userId);
      return { id };
    });
  }

  /**
   * Replaces: public.vendor_set_storefront_active(boolean) - the vendor shows or hides their storefront.
   * Turning it on is refused while an admin paused it or commission is owed.
   */
  async setStorefront(me: Identity | null, active: boolean): Promise<{ success: true; is_active: boolean; admin_paused: boolean; commission_owed: number }> {
    if (!me) throw notFound("Vendor profile not found.");
    return this.db().onBehalfOf(me, async (tx) => {
      const shops = new ShopsRepository(tx);
      const shop = await shops.lockOwnShop(me.userId);
      if (!shop) throw notFound("Vendor profile not found.");
      if (active && shop.admin_paused) throw forbidden("Your storefront was paused by an administrator. Only an administrator can reactivate it.");
      const owed = await shops.commissionOwed(shop.id);
      if (active && Number(owed) > 0) throw forbidden(`Your storefront is locked until your outstanding commission of ${owed} is paid.`);
      await shops.setOwnStorefront(shop.id, active);
      return { success: true as const, is_active: active, admin_paused: shop.admin_paused ?? false, commission_owed: Number(owed) };
    });
  }

  /** Replaces: public.set_vendor_billing_model(text) - commission per sale, or a monthly listing fee. */
  async setBillingModel(me: Identity | null, model: string): Promise<{ done: true }> {
    if (!["commission", "monthly"].includes(model)) throw badRequest("invalid billing model");
    await this.withOwnShop(me, "no vendor profile found", (shops, id) => shops.setBillingModel(id, model));
    return { done: true };
  }

  /** Replaces: public.submit_face_check(text, real, text, boolean, boolean, boolean, text) - the student selfie and ID-card check results. */
  async submitFaceCheck(me: Identity | null, c: FaceCheck): Promise<{ done: true }> {
    await this.withOwnShop(me, "no vendor profile", async (shops, id) => {
      if (c.match != null && !["strong", "possible", "mismatch", "unchecked"].includes(c.match)) throw badRequest("bad match value");
      await shops.recordFaceCheck(id, {
        selfieUrl: c.selfieUrl ?? null,
        distance: c.distance ?? null,
        match: c.match ?? null,
        liveness: c.liveness ?? null,
        ocrMatric: c.ocrMatric ?? null,
        ocrName: c.ocrName ?? null,
        ocrText: c.ocrText ?? null,
      });
    });
    return { done: true };
  }

  private async withOwnShop(me: Identity | null, missing: string, work: (shops: ShopsRepository, vendorId: string) => Promise<void>): Promise<void> {
    if (!me) throw notFound(missing);
    await this.db().onBehalfOf(me, async (tx) => {
      const shops = new ShopsRepository(tx);
      const id = await shops.liveShopIdOf(me.userId);
      if (!id) throw notFound(missing);
      await work(shops, id);
    });
  }

  /** The caller's own live shop, every column. Replaces the app's `select("*").eq("user_id", me).is("deleted_at", null)`. */
  mine(me: Identity): Promise<Record<string, unknown> | null> {
    return this.db().asUser(me, (tx) => new ShopRowsRepository(tx).mine(me.userId));
  }

  /** One shop with its sector: every column for its owner and admins, the public ones for others (FIX S12). */
  shop(me: Identity | null, vendorId: string, o: { verified: boolean; active: boolean }): Promise<Record<string, unknown> | null> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new ShopRowsRepository(tx).one(me?.userId ?? null, vendorId, o);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** The shop lists (public columns). */
  shops(me: Identity | null, f: ShopListFilter): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new ShopRowsRepository(tx).list(me?.userId ?? null, f);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** The admin's applications / shops and the recycle bin (empty for anyone but an admin). */
  adminShops(me: Identity, deleted: boolean, status: string | null): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new ShopRowsRepository(tx).adminList(deleted, status));
  }

  /**
   * The owner changes their shop's details. Replaces the app's updates of vendors (profile, logo and header,
   * location, hours, WhatsApp, campus and request settings, documents). FIX S11: only these fields - the table
   * let the owner change every column, including marking their own shop verified.
   */
  async updateMine(me: Identity, changes: ShopChanges): Promise<{ updated: number }> {
    if (changes.verification_docs?.some((p) => !p.startsWith(`${me.userId}/`) || p.includes(".."))) throw badRequest("Documents must be files uploaded to your own folder.");
    return { updated: await this.db().asUser(me, (tx) => new ShopRowsRepository(tx).update(me.userId, changes)) };
  }

  /** The owner saves the shop's payout account (after the bank check). */
  async setPayout(me: Identity, p: Parameters<ShopRowsRepository["setPayout"]>[1]): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new ShopRowsRepository(tx).setPayout(me.userId, p)) };
  }

  /** The application's clean-up after a failed step (users may not delete shops: nothing is removed, as before). */
  async removeApplication(me: Identity, vendorId: string): Promise<{ removed: number }> {
    return { removed: await this.db().asUser(me, (tx) => new ShopRowsRepository(tx).removeOwn(me.userId, vendorId)) };
  }

  /** Product varieties of some listings (active listings for everyone; one's own always). */
  variants(me: Identity | null, productIds: string[]): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new ShopRecordsRepository(tx).variants(productIds);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** A shop's student verification (its owner and admins). */
  studentVerification(me: Identity, vendorId: string): Promise<Record<string, unknown> | null> {
    return this.db().asUser(me, (tx) => new ShopRecordsRepository(tx).studentVerification(vendorId));
  }

  studentVerificationStatuses(me: Identity): Promise<{ vendor_id: string; status: string; matric_pending: boolean }[]> {
    return this.db().asUser(me, (tx) => new ShopRecordsRepository(tx).studentVerificationStatuses());
  }

  /** The owner (re)submits their student verification; it is pending again. Files must be in their own folder. */
  async submitStudentVerification(me: Identity, r: StudentVerificationInput): Promise<{ submitted: true }> {
    for (const url of [r.id_card_url, r.biodata_url, r.selfie_url]) {
      if (url && url.includes("..")) throw badRequest("Invalid document path.");
    }
    await this.db().asUser(me, async (tx) => {
      const shopId = (await new ShopRowsRepository(tx).mine(me.userId))?.id as string | undefined;
      if (!shopId) throw notFound("You do not have a shop.");
      await new ShopRecordsRepository(tx).submitStudentVerification(shopId, r);
    });
    return { submitted: true };
  }

  async recordStudentOcr(me: Identity, o: { matric: boolean | null; name: boolean | null; text: string | null }): Promise<{ updated: number }> {
    return this.db().asUser(me, async (tx) => {
      const shopId = (await new ShopRowsRepository(tx).mine(me.userId))?.id as string | undefined;
      if (!shopId) throw notFound("You do not have a shop.");
      return { updated: await new ShopRecordsRepository(tx).recordOcr(shopId, o) };
    });
  }

  /** The caller's shop's monthly-listing receipts (optionally of one kind). */
  mySubmissions(me: Identity, kind: string | null): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, async (tx) => {
      const shopId = (await new ShopRowsRepository(tx).mine(me.userId))?.id as string | undefined;
      return shopId ? new ShopRecordsRepository(tx).shopSubmissions(shopId, kind) : [];
    });
  }

  pendingSubmission(me: Identity, kind: string, listingId: string): Promise<Record<string, unknown> | null> {
    return this.db().asUser(me, (tx) => new ShopRecordsRepository(tx).pendingFor(kind, listingId));
  }

  /** Pending receipts: every one for admins, the caller's shop's for a vendor. */
  pendingSubmissions(me: Identity): Promise<{ id: string; kind: string; listing_id: string; vendor_id: string }[]> {
    return this.db().asUser(me, async (tx) => {
      const admin = await new AccessRepository(tx).isAdmin(me.userId);
      const shopId = admin ? null : (((await new ShopRowsRepository(tx).mine(me.userId))?.id as string | undefined) ?? null);
      if (!admin && !shopId) return [];
      return new ShopRecordsRepository(tx).pending(shopId);
    });
  }

  latestSubmissions(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new ShopRecordsRepository(tx).latest());
  }
}
