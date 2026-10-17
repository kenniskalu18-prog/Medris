import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { asUserSeed, identityOf, seedOrder, seedPackage, seedProduct, seedReview, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** EngagementService replaces the listing counters and statistics functions. */
describe("parity: engagement", () => {
  let db: TestDatabase;
  let buyer: string;
  let other: string;
  let owner: string;
  let shop: string;
  let lamp: string;
  let fan: string;
  let unsold: string;
  let bundle: string;
  let emptyBundle: string;
  const missing = "00000000-0000-4000-8000-000000000999";

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db)).id;
    other = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Ada Electronics" })).id;
    lamp = await seedProduct(db, shop, { name: "Lamp" });
    fan = await seedProduct(db, shop, { name: "Fan" });
    unsold = await seedProduct(db, shop, { name: "Kettle" });
    bundle = await seedPackage(db, shop, { name: "Starter bundle" });
    emptyBundle = await seedPackage(db, shop, { name: "Empty bundle" });
    for (const [who, product] of [[buyer, lamp], [other, lamp], [buyer, fan]]) {
      await db.query(`insert into public.favorites (buyer_id, product_id) values ($1, $2)`, [who, product]);
    }
    await db.query(`insert into public.package_favorites (buyer_id, package_id) values ($1, $2)`, [buyer, bundle]);
    const comment = `insert into public.product_comments (product_id, user_id, content, author_name) values ($1, $2, $3, 'User')`;
    await asUserSeed(db, buyer, [[comment, [lamp, buyer, "Nice"]]]);
    await asUserSeed(db, other, [[comment, [lamp, other, "Price?"]]]);
    await db.query(`insert into public.package_comments (package_id, user_id, content) values ($1, $2, 'Good deal')`, [bundle, buyer]);
    const done = await seedOrder(db, buyer, shop, { status: "completed", productIds: [lamp, fan] });
    await seedReview(db, done, buyer, shop, 4, "Bright");
    await seedOrder(db, other, shop, { status: "completed", productIds: [lamp] }); // completed, not reviewed yet
    await seedOrder(db, buyer, shop, { status: "pending", productIds: [unsold] });
  }, 60_000);
  afterAll(() => db.close());

  const port = <T>(work: (s: EngagementService) => Promise<T>) => runIsolated(db, (ctx) => work(new EngagementService(() => ctx)));
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>) {
    const { original: a, port: b } = comparable(await original, await ported);
    expect(b).toEqual(a);
    return a;
  }

  it("get_favorite_counts", () =>
    same(runOriginal(db, null, "get_favorite_counts", { p_product_ids: [lamp, fan, unsold, missing] }), port((s) => s.favoriteCounts([lamp, fan, unsold, missing]))));
  it("get_package_favorite_counts", () =>
    same(
      runOriginal(db, null, "get_package_favorite_counts", { p_package_ids: [bundle, emptyBundle, missing] }),
      port((s) => s.packageFavoriteCounts([bundle, emptyBundle, missing])),
    ));
  it("get_product_comment_counts", () =>
    same(runOriginal(db, null, "get_product_comment_counts", { p_product_ids: [lamp, fan] }), port((s) => s.productCommentCounts([lamp, fan]))));
  it("get_package_comment_counts", () =>
    same(
      runOriginal(db, null, "get_package_comment_counts", { p_package_ids: [bundle, emptyBundle] }),
      port((s) => s.packageCommentCounts([bundle, emptyBundle])),
    ));
  it("get_comment_authors (buyers and a shop owner)", () =>
    same(runOriginal(db, null, "get_comment_authors", { p_user_ids: [buyer, owner, missing] }), port((s) => s.commentAuthors([buyer, owner, missing]))));
  it("get_vendor_stats", () => same(runOriginal(db, null, "get_vendor_stats", { p_vendor_id: shop }), port((s) => s.vendorStats(shop))));
  it("get_vendor_stats of an unknown shop", () => same(runOriginal(db, null, "get_vendor_stats", { p_vendor_id: missing }), port((s) => s.vendorStats(missing))));
  it("get_product_reviews", () => same(runOriginal(db, null, "get_product_reviews", { p_product_id: lamp }), port((s) => s.productReviews(lamp))));

  describe("get_reviewable_order_for_product", () => {
    for (const [label, who, product] of [
      ["completed and not reviewed", () => other, () => lamp],
      ["already reviewed", () => buyer, () => fan],
      ["not completed", () => buyer, () => unsold],
      ["signed out", () => null, () => lamp],
    ] as const) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "get_reviewable_order_for_product", { p_product_id: product() }),
          port((s) => s.reviewableOrder(me(who()), product())),
        ),
      );
    }
  });

  // Void functions: the port answers { done: true } instead of null; the rows changed must be identical.
  const done = { result: () => null };
  it("increment_product_view", async () => {
    const { original: a, port: b } = comparable(
      await runOriginal(db, null, "increment_product_view", { p_product_id: lamp }),
      await port((s) => s.countProductView(lamp)),
      done,
    );
    expect(b).toEqual(a);
  });
  it("increment_vendor_profile_view", async () => {
    const { original: a, port: b } = comparable(
      await runOriginal(db, null, "increment_vendor_profile_view", { p_vendor_id: shop }),
      await port((s) => s.countProfileView(shop)),
      done,
    );
    expect(b).toEqual(a);
    expect((a.changes["vendor_profile_view_events"] as { inserted: unknown[] }).inserted).toHaveLength(1);
  });
});
