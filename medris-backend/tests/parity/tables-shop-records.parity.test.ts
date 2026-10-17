import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { ShopsService } from "../../src/modules/shops/shops.service.js";
import { identityOf, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on product_variants, vendor_student_verification and monthly_listing_submissions. */
describe("parity: table queries - varieties, student verification, monthly-listing receipts", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let otherOwner: string;
  let shop: string;
  let otherShop: string;
  let active: string;
  let paused: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    otherOwner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner)).id;
    otherShop = (await seedVendor(db, otherOwner)).id;
    active = await seedProduct(db, shop, { name: "Phone" });
    paused = await seedProduct(db, shop, { name: "Lamp", status: "paused" });
    await db.query(`do $$ begin perform set_config('levromart.batch_variant_save','1',true);
      insert into public.product_variants (product_id, name, sale_price, sort_order) values ('${active}', '64GB', 9000, 1), ('${active}', '128GB', 11000, 0), ('${paused}', 'Red', 500, 0); end $$`);
    await db.query(`insert into public.vendor_student_verification (vendor_id, matric_number, status) values ($1, 'U123', 'pending'), ($2, 'U999', 'approved')`, [shop, otherShop]);
    await db.query(`insert into public.monthly_listing_submissions (kind, listing_id, vendor_id, user_id, payer_name, receipt_path) values ('product', $1, $2, $3, 'Dayo', 'r/1.jpg')`, [paused, shop, owner]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const shops = (ctx: DataContext) => new ShopsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  it("varieties: of active listings for everyone; of a paused one only for its shop", async () => {
    for (const who of [null, buyer, owner]) {
      await same(
        runTableQuery(db, who ? me(who) : null, sql`select * from public.product_variants where product_id in (${active}, ${paused}) order by sort_order asc, created_at asc`),
        runIsolated(db, (ctx) => shops(ctx).variants(who ? me(who) : null, [active, paused])),
      );
    }
  });

  describe("student verification", () => {
    it("read: the owner and admins; statuses", async () => {
      for (const who of [owner, admin, buyer]) {
        await same(runTableQuery(db, me(who), sql`select * from public.vendor_student_verification where vendor_id = ${shop}`).then(single), runIsolated(db, (ctx) => shops(ctx).studentVerification(me(who), shop)));
        await same(
          runTableQuery(db, me(who), sql`select vendor_id, status, matric_pending from public.vendor_student_verification`),
          runIsolated(db, (ctx) => shops(ctx).studentVerificationStatuses(me(who))),
        );
      }
    });
    const rec = { matric_number: "U124", matric_pending: false, faculty: "Science", department: "Physics", level: "200", id_card_url: "sv/id.jpg", biodata_url: null, selfie_url: null, face_distance: 0.3, face_match: "strong", face_liveness: true, face_checked_at: null, face_v: 1 };
    it("resubmit (pending again); an approved one cannot be changed", async () => {
      await same(
        runTableQuery(
          db,
          me(owner),
          sql`insert into public.vendor_student_verification (vendor_id, matric_number, matric_pending, faculty, department, level, id_card_url, biodata_url, selfie_url, face_distance, face_match, face_liveness, face_checked_at, face_v, status)
              values (${shop}, 'U124', false, 'Science', 'Physics', '200', 'sv/id.jpg', null, null, 0.3, 'strong', true, null, 1, 'pending')
              on conflict (vendor_id) do update set matric_number = excluded.matric_number, matric_pending = excluded.matric_pending, faculty = excluded.faculty, department = excluded.department,
                level = excluded.level, id_card_url = excluded.id_card_url, biodata_url = excluded.biodata_url, selfie_url = excluded.selfie_url, face_distance = excluded.face_distance,
                face_match = excluded.face_match, face_liveness = excluded.face_liveness, face_checked_at = excluded.face_checked_at, face_v = excluded.face_v, status = 'pending', updated_at = now()`,
          false,
        ),
        runIsolated(db, (ctx) => shops(ctx).submitStudentVerification(me(owner), rec).then(() => null)),
      );
      const o = await runTableQuery(db, me(otherOwner), sql`update public.vendor_student_verification set matric_number = 'X' where vendor_id = ${otherShop} returning vendor_id`);
      expect(o.result).toEqual([]);
      const p = await runIsolated(db, (ctx) => shops(ctx).submitStudentVerification(me(otherOwner), rec));
      expect(p.error).toBeDefined();
      expect(comparable(p, o).port.changes).toEqual(comparable(p, o).original.changes);
    });
    it("record the text check", () =>
      same(
        runTableQuery(db, me(owner), sql`update public.vendor_student_verification set ocr_matric_found = true, ocr_name_found = false, ocr_text = 'U123', ocr_checked_at = now(), status = 'pending' where vendor_id = ${shop}`, false),
        runIsolated(db, (ctx) => shops(ctx).recordStudentOcr(me(owner), { matric: true, name: false, text: "U123" }).then(() => null)),
      ));
  });

  describe("monthly-listing receipts", () => {
    it("the shop's, one listing's pending one, all pending, the latest (admins)", async () => {
      for (const who of [owner, admin, otherOwner]) {
        const shopOf = who === owner ? shop : who === otherOwner ? otherShop : null;
        if (shopOf) {
          await same(
            runTableQuery(
              db,
              me(who),
              sql`select id, kind, listing_id, status, submitted_at, reviewed_at, review_note, payer_name, receipt_path from public.monthly_listing_submissions where vendor_id = ${shopOf} order by submitted_at desc limit 100`,
            ),
            runIsolated(db, (ctx) => shops(ctx).mySubmissions(me(who), null)),
          );
        }
        await same(
          runTableQuery(
            db,
            me(who),
            sql`select id, kind, listing_id, payer_name, receipt_path, status, submitted_at, review_note from public.monthly_listing_submissions where kind = 'product' and listing_id = ${paused} and status = 'pending' order by submitted_at desc limit 1`,
          ).then(single),
          runIsolated(db, (ctx) => shops(ctx).pendingSubmission(me(who), "product", paused)),
        );
        await same(
          runTableQuery(db, me(who), sql`select id, kind, listing_id, vendor_id from public.monthly_listing_submissions where status = 'pending' ${who === admin ? sql`` : sql`and vendor_id = ${shopOf}`}`),
          runIsolated(db, (ctx) => shops(ctx).pendingSubmissions(me(who))),
        );
      }
      await same(
        runTableQuery(db, me(admin), sql`select id, kind, listing_id, vendor_id, user_id, payer_name, receipt_path, status, submitted_at, reviewed_at, review_note from public.monthly_listing_submissions order by submitted_at desc limit 100`),
        runIsolated(db, (ctx) => shops(ctx).latestSubmissions(me(admin))),
      );
    });
  });
});
