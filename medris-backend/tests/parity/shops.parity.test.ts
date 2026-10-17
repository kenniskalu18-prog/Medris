import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { AdminVendorsService } from "../../src/modules/admin-vendors/admin-vendors.service.js";
import { CampusService } from "../../src/modules/campus/campus.service.js";
import { ShopsService } from "../../src/modules/shops/shops.service.js";
import { asUserSeed, identityOf, seedOrder, seedPackage, seedProduct, seedSector, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { bothRefused, comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * ShopsService, AdminVendorsService and CampusService replace the vendor, admin-vendor and campus
 * functions; each case runs the original and the port on the same rows.
 */
describe("parity: shops, admin vendor tools and campus", () => {
  let db: TestDatabase;
  let admin: string;
  let superAdmin: string;
  let buyer: string;
  let applicant: string; // pending application
  let liveOwner: string;
  let pausedOwner: string;
  let owingOwner: string;
  let recycledOwner: string;
  let sector: string;
  let live: string;
  let pending: string;
  let paused: string;
  let owing: string;
  let recycled: string;
  let recycledBare: string; // recycled, had no packages
  let student: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    superAdmin = (await seedUser(db)).id;
    await setRole(db, superAdmin, "admin");
    await db.query(`update public.users set is_super_admin = true where id = $1`, [superAdmin]);
    buyer = (await seedUser(db)).id;
    applicant = (await seedUser(db)).id;
    liveOwner = (await seedUser(db, { role: "vendor" })).id;
    pausedOwner = (await seedUser(db, { role: "vendor" })).id;
    owingOwner = (await seedUser(db, { role: "vendor" })).id;
    recycledOwner = (await seedUser(db, { role: "vendor" })).id;
    sector = await seedSector(db, { name: "Food" });

    live = (await seedVendor(db, liveOwner, { name: "Mama Put" })).id;
    pending = (await seedVendor(db, applicant, { verified: false, name: "New Kitchen" })).id;
    paused = (await seedVendor(db, pausedOwner, { name: "Paused Place" })).id;
    owing = (await seedVendor(db, owingOwner, { name: "Owing Oven" })).id;
    recycled = (await seedVendor(db, recycledOwner, { name: "Gone Grill" })).id;
    for (const shop of [live, recycled]) {
      await seedProduct(db, shop);
      await seedProduct(db, shop, { status: "paused" });
      await seedPackage(db, shop);
    }
    await db.query(`update public.vendors set is_active = false, admin_paused = true where id = $1`, [paused]);
    const order = await seedOrder(db, buyer, owing, { status: "completed" });
    await db.query(`insert into public.commission_charges (vendor_id, order_id, amount) values ($1, $2, 1250.50)`, [owing, order]);
    await db.query(`update public.vendors set commission_paused = true, commission_pause_reason = 'overdue' where id = $1`, [owing]);
    await db.query(`update public.vendors set is_active = false where id = $1`, [owing]);
    recycledBare = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Bare Bar" })).id;
    await seedProduct(db, recycledBare, { status: "paused" });
    await asUserSeed(db, admin, [
      [`select public.admin_delete_vendor($1)`, [recycled]],
      [`select public.admin_delete_vendor($1)`, [recycledBare]],
    ]);

    student = live;
    await db.query(`insert into public.vendor_student_verification (vendor_id, matric_number, status) values ($1, 'LAG/2021/001', 'pending'), ($2, null, 'pending')`, [
      live,
      paused,
    ]);
    await db.query(`insert into public.campus_submissions (name_norm, name, submitted_by) values ('unilagakoka', 'UNILAG Akoka', $1), ('oauife', 'OAU Ife', $1)`, [buyer]);
    await db.query(`update public.campus_submissions set status = 'approved' where name_norm = 'oauife'`);
    await db.query(`update public.users set campus_id = 'custom:Unilag Akoka' where id = $1`, [buyer]);
    await db.query(`update public.vendors set campus_id = 'custom:UNILAG-akoka' where id = $1`, [live]);
  }, 60_000);
  afterAll(() => db.close());

  const shops = (ctx: DataContext) => new ShopsService(() => ctx);
  const adminVendors = (ctx: DataContext) => new AdminVendorsService(() => ctx);
  const campus = (ctx: DataContext) => new CampusService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }
  const voidResult = { result: () => null };
  type Who = () => string | null;

  describe("submit_vendor_application", () => {
    const full = () => ({
      sectorId: sector,
      businessName: "  Suya Spot ",
      address: " 1 Allen Ave ",
      city: "",
      phone: null,
      whatsapp: " 08035550000 ",
      cacNumber: " RC123 ",
      bio: "Best suya",
      bankCode: "058",
      bankName: "GTBank",
      accountName: "Suya Spot",
      accountNumber: "0123456789",
    });
    const args = (a: ReturnType<typeof full>) => ({
      p_sector_id: a.sectorId,
      p_business_name: a.businessName,
      p_address: a.address,
      p_city: a.city,
      p_phone: a.phone,
      p_whatsapp: a.whatsapp,
      p_cac_number: a.cacNumber,
      p_bio: a.bio,
      p_bank_code: a.bankCode,
      p_bank_name: a.bankName,
      p_account_name: a.accountName,
      p_account_number: a.accountNumber,
    });
    const cases: [string, Who, (a: ReturnType<typeof full>) => ReturnType<typeof full>][] = [
      ["a buyer applies; the admins are told", () => buyer, (a) => a],
      ["a pending applicant applies again", () => applicant, (a) => a],
      ["an active vendor is refused", () => liveOwner, (a) => a],
      ["a recycled shop's owner applies again", () => recycledOwner, (a) => a],
      ["a business name is required", () => buyer, (a) => ({ ...a, businessName: "  " })],
      ["a WhatsApp number is required", () => buyer, (a) => ({ ...a, whatsapp: "" })],
      ["a sector is required", () => buyer, (a) => ({ ...a, sectorId: null as unknown as string })],
      ["signed out", () => null, (a) => a],
    ];
    for (const [label, who, change] of cases) {
      it(label, () => {
        const a = change(full());
        return same(
          runOriginal(db, me(who()), "submit_vendor_application", args(a)),
          runIsolated(db, (ctx) => shops(ctx).apply(me(who()), a).then((r) => r.id)),
          // A new shop's referral code ends in random digits.
          { volatile: ["referral_code"] },
        );
      });
    }
  });

  describe("vendor_set_storefront_active", () => {
    const cases: [string, Who, boolean][] = [
      ["a vendor hides the storefront", () => liveOwner, false],
      ["and shows it again", () => liveOwner, true],
      ["an admin-paused storefront cannot be turned on", () => pausedOwner, true],
      ["it can be turned off", () => pausedOwner, false],
      ["owed commission keeps it locked", () => owingOwner, true],
      ["a buyer has no shop", () => buyer, true],
      ["signed out", () => null, true],
    ];
    for (const [label, who, active] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "vendor_set_storefront_active", { p_active: active }),
          runIsolated(db, (ctx) => shops(ctx).setStorefront(me(who()), active)),
        ),
      );
    }
  });

  describe("set_vendor_billing_model / submit_face_check", () => {
    for (const [label, who, model] of [
      ["monthly", () => liveOwner, "monthly"],
      ["commission", () => liveOwner, "commission"],
      ["an unknown model", () => liveOwner, "weekly"],
      ["no shop", () => buyer, "monthly"],
    ] as const) {
      it(`billing model: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "set_vendor_billing_model", { p_billing_model: model }),
          runIsolated(db, (ctx) => shops(ctx).setBillingModel(me(who()), model)),
          voidResult,
        ),
      );
    }
    const check = { selfieUrl: "https://img.test/selfie.jpg", distance: 0.31, match: "strong", liveness: true, ocrMatric: true, ocrName: null, ocrText: "x".repeat(500) };
    const args = (c: typeof check) => ({
      p_selfie_url: c.selfieUrl,
      p_distance: c.distance,
      p_match: c.match,
      p_liveness: c.liveness,
      p_ocr_matric: c.ocrMatric,
      p_ocr_name: c.ocrName,
      p_ocr_text: c.ocrText,
    });
    for (const [label, who, c] of [
      ["results recorded", () => liveOwner, check],
      ["no text check", () => liveOwner, { ...check, ocrMatric: null, ocrText: null, selfieUrl: null }],
      ["a bad match value", () => liveOwner, { ...check, match: "maybe" }],
      ["no shop", () => buyer, check],
    ] as const) {
      it(`face check: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "submit_face_check", args(c as typeof check)),
          runIsolated(db, (ctx) => shops(ctx).submitFaceCheck(me(who()), c as typeof check)),
          voidResult,
        ),
      );
    }
  });

  describe("admin_set_vendor_status", () => {
    const cases: [string, Who, () => string, string][] = [
      ["approve a pending application", () => admin, () => pending, "verified"],
      ["reject it", () => admin, () => pending, "rejected"],
      ["set a live shop back to pending", () => admin, () => live, "pending"],
      ["an unknown shop", () => admin, () => uuid(), "verified"],
      ["a recycled shop is not found", () => admin, () => recycled, "verified"],
      ["not an admin", () => liveOwner, () => pending, "verified"],
      ["a value that is not a status", () => admin, () => pending, "approved"],
    ];
    for (const [label, who, vendor, status] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "admin_set_vendor_status", { p_vendor_id: vendor(), p_status: status }),
          runIsolated(db, (ctx) => adminVendors(ctx).setStatus(me(who()), vendor(), status)),
        ),
      );
    }
  });

  it("admin_set_vendor_status signed out: refused by both (the original is not open to visitors)", async () => {
    const a = await runOriginal(db, null, "admin_set_vendor_status", { p_vendor_id: pending, p_status: "verified" });
    const b = await runIsolated(db, (ctx) => adminVendors(ctx).setStatus(null, pending, "verified"));
    expect(bothRefused(a, b)).toBe(true);
  });

  describe("admin_reject_vendor", () => {
    const cases: [string, Who, () => string, string | null][] = [
      ["with a reason", () => admin, () => pending, "  Blurry ID card. ".repeat(20)],
      ["a reason is required", () => admin, () => pending, "   "],
      ["1000 characters at most", () => admin, () => pending, "x".repeat(1001)],
      ["an unknown shop", () => admin, () => uuid(), "No"],
      ["not an admin", () => buyer, () => pending, "No"],
    ];
    for (const [label, who, vendor, reason] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "admin_reject_vendor", { p_vendor_id: vendor(), p_reason: reason }),
          runIsolated(db, (ctx) => adminVendors(ctx).reject(me(who()), vendor(), reason)),
        ),
      );
    }
  });

  // parity-tested: admin_set_vendor_storefront_active, admin_force_unlock_vendor, admin_delete_vendor, admin_restore_vendor, admin_permanently_delete_vendor
  describe("storefront, unlock, recycle bin", () => {
    const pairs: [string, string, (s: AdminVendorsService, who: Identity | null, v: string) => Promise<unknown>, Record<string, unknown>][] = [
      ["admin_set_vendor_storefront_active", "pause", (s, w, v) => s.setStorefront(w, v, false), { p_active: false }],
      ["admin_set_vendor_storefront_active", "reactivate", (s, w, v) => s.setStorefront(w, v, true), { p_active: true }],
      ["admin_force_unlock_vendor", "unlock", (s, w, v) => s.forceUnlock(w, v), {}],
      ["admin_delete_vendor", "recycle", (s, w, v) => s.delete(w, v), {}],
      ["admin_restore_vendor", "restore", (s, w, v) => s.restore(w, v), {}],
      ["admin_permanently_delete_vendor", "erase", (s, w, v) => s.deletePermanently(w, v), {}],
    ];
    const targets: [string, Who, () => string][] = [
      ["a live shop", () => admin, () => live],
      ["a commission-locked shop", () => admin, () => owing],
      ["a recycled shop", () => admin, () => recycledBare],
      ["a recycled shop, by the super admin", () => superAdmin, () => recycledBare],
      ["an unknown shop", () => admin, () => uuid()],
      ["not an admin", () => liveOwner, () => live],
    ];
    for (const [fn, label, port, extra] of pairs) {
      for (const [target, who, vendor] of targets) {
        it(`${fn} (${label}): ${target}`, () =>
          same(
            runOriginal(db, me(who()), fn, { p_vendor_id: vendor(), ...extra }),
            runIsolated(db, (ctx) => port(adminVendors(ctx), me(who()), vendor())),
          ),
        );
      }
    }
  });

  it("FIX B10: restoring a shop that had packages (the original always failed)", async () => {
    const original = await runOriginal(db, me(admin), "admin_restore_vendor", { p_vendor_id: recycled });
    expect(original.error?.message).toBe('column "status" is of type product_status but expression is of type text');
    const port = await runIsolated(db, (ctx) => adminVendors(ctx).restore(me(admin), recycled));
    expect(port.error).toBeUndefined();
    expect(port.result).toMatchObject({ restored: true, verification_status: "verified", is_active: true });
    // Every listing is back with the status it had before the shop was recycled.
    const statuses = (rows: { after: Record<string, unknown> }[]) => rows.map((r) => r.after.status).sort();
    expect(statuses(port.changes.products!.updated)).toEqual(["active", "paused"]);
    expect(statuses(port.changes.vendor_packages!.updated)).toEqual(["active"]);
    expect(port.changes.vendor_recycle_bin!.deleted).toHaveLength(1);
  });

  describe("admin lists", () => {
    for (const [label, who] of [["an admin", () => admin], ["not an admin", () => liveOwner]] as const) {
      it(`admin_list_locked_vendors, ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_list_locked_vendors"), runIsolated(db, (ctx) => adminVendors(ctx).locked(me(who())))),
      );
      it(`admin_list_transactions, ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_list_transactions"), runIsolated(db, (ctx) => adminVendors(ctx).transactions(me(who())))),
      );
      it(`admin_list_vendor_payouts, ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_list_vendor_payouts"), runIsolated(db, (ctx) => adminVendors(ctx).payouts(me(who())))),
      );
    }
  });

  describe("admin_review_student_verification", () => {
    const cases: [string, Who, () => string, string, string | null][] = [
      ["approve", () => admin, () => student, "approved", null],
      ["reject with a note", () => admin, () => student, "rejected", "ID card unreadable"],
      ["reject without a note", () => admin, () => student, "rejected", ""],
      ["back to pending", () => admin, () => student, "pending", null],
      ["no matric number: cannot approve", () => admin, () => paused, "approved", null],
      ["nothing submitted", () => admin, () => owing, "approved", null],
      ["an unknown status", () => admin, () => student, "done", null],
      ["not an admin", () => liveOwner, () => student, "approved", null],
    ];
    for (const [label, who, vendor, status, note] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "admin_review_student_verification", { p_vendor_id: vendor(), p_status: status, p_note: note }),
          runIsolated(db, (ctx) => adminVendors(ctx).reviewStudent(me(who()), vendor(), status, note)),
        ),
      );
    }
  });

  describe("campus", () => {
    it("campus_school_names", () => same(runOriginal(db, null, "campus_school_names"), runIsolated(db, (ctx) => campus(ctx).schoolNames())));
    for (const [label, who, name] of [
      ["a new school", () => buyer, " Yaba College of Tech "],
      ["the same school again counts a request", () => liveOwner, "UNILAG, Akoka!"],
      ["too short", () => buyer, " U.I "],
      ["signed out", () => null, "Covenant University"],
    ] as const) {
      it(`submit_campus_school: ${label}`, () =>
        same(runOriginal(db, me(who()), "submit_campus_school", { p_name: name }), runIsolated(db, (ctx) => campus(ctx).submit(me(who()), name))),
      );
    }
    for (const [label, who] of [["an admin", () => admin], ["not an admin", () => buyer]] as const) {
      it(`admin_campus_submissions, ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_campus_submissions"), runIsolated(db, (ctx) => campus(ctx).pending(me(who())))),
      );
    }
    const reviews: [string, Who, string, string | null][] = [
      ["approve", () => admin, "approve", null],
      ["merge into a listed school", () => admin, "merge", "unilag"],
      ["merge needs a target", () => admin, "merge", ""],
      ["reject", () => admin, "reject", null],
      ["an unknown action", () => admin, "close", null],
      ["not an admin", () => buyer, "approve", null],
    ];
    for (const [label, who, action, target] of reviews) {
      it(`admin_review_campus_school: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_review_campus_school", { p_norm: "unilagakoka", p_action: action, p_target: target }),
          runIsolated(db, (ctx) => campus(ctx).review(me(who()), "unilagakoka", action, target)),
          voidResult,
        ),
      );
    }
  });
});
