import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../../src/database/context.js";
import { FollowsService } from "../../src/modules/follows/follows.service.js";
import { identityOf, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** FollowsService replaces the follow functions; each case runs the original and the port on the same rows. */
describe("parity: follows", () => {
  let db: TestDatabase;
  let fan: string;
  let ownerA: string;
  let ownerB: string;
  let ownerC: string;
  let shopA: string;
  let shopB: string;
  let shopC: string;
  let pending: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    fan = (await seedUser(db)).id;
    ownerA = (await seedUser(db, { role: "vendor" })).id;
    ownerB = (await seedUser(db, { role: "vendor" })).id;
    ownerC = (await seedUser(db, { role: "vendor" })).id;
    shopA = (await seedVendor(db, ownerA, { name: "Alpha Store" })).id;
    shopB = (await seedVendor(db, ownerB, { name: "Bravo Store" })).id;
    shopC = (await seedVendor(db, ownerC, { name: "Charlie Store" })).id;
    pending = (await seedVendor(db, (await seedUser(db)).id, { verified: false })).id;
    // A network: B and C follow A, the fan follows B, A follows C, and the fan muted B for 8 hours.
    const follow = (who: string, shop: string) => db.query(`insert into public.vendor_follows (follower_id, vendor_id) values ($1, $2)`, [who, shop]);
    await follow(ownerB, shopA);
    await follow(ownerC, shopA);
    await follow(fan, shopB);
    await follow(ownerA, shopC);
    await db.query(
      `insert into public.vendor_follow_preferences (follower_id, vendor_id, mute_mode, muted_until, notify_discount) values ($1, $2, '8h', now() + interval '8 hours', false)`,
      [fan, shopB],
    );
  }, 60_000);
  afterAll(() => db.close());

  const service = (ctx: Parameters<Parameters<typeof runIsolated>[1]>[0]) => new FollowsService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const { original: a, port: b } = comparable(await original, await port);
    expect(b).toEqual(a);
    return a;
  }

  describe("toggle_vendor_follow", () => {
    const cases: [string, () => string, () => string, boolean][] = [
      ["follows a shop (rows, preferences, notification)", () => fan, () => shopA, true],
      ["unfollowing a shop not followed changes nothing", () => fan, () => shopC, false],
      ["unfollows a followed shop and forgets its settings", () => fan, () => shopB, false],
      ["refuses your own shop", () => ownerA, () => shopA, true],
      ["refuses a shop that is not verified", () => fan, () => pending, true],
    ];
    for (const [name, who, shop, following] of cases) {
      it(name, () =>
        same(
          runOriginal(db, identityOf(who()), "toggle_vendor_follow", { p_vendor_id: shop(), p_following: following }),
          runIsolated(db, (ctx) => service(ctx).setFollowing(identityOf(who()), shop(), following).then((r) => r.result)),
        ),
      );
    }
  });

  describe("get_vendor_follow_state / get_vendor_follow_states", () => {
    for (const [label, who] of [["signed in, following and muted", () => fan], ["signed out", () => null]] as const) {
      it(`one shop, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "get_vendor_follow_state", { p_vendor_id: shopB }),
          runIsolated(db, (ctx) => service(ctx).followState(me(who()), shopB)),
        ),
      );
      it(`several shops (with an unknown id), ${label}`, () => {
        const ids = [shopB, shopA, "00000000-0000-4000-8000-000000000999"];
        return same(
          runOriginal(db, me(who()), "get_vendor_follow_states", { p_vendor_ids: ids }),
          runIsolated(db, (ctx) => service(ctx).followStates(me(who()), ids)),
        );
      });
    }
  });

  it("get_vendor_follower_counts", () => {
    const ids = [shopA, shopB, shopC, pending, "00000000-0000-4000-8000-000000000999"];
    return same(
      runOriginal(db, null, "get_vendor_follower_counts", { p_vendor_ids: ids }),
      runIsolated(db, (ctx) => service(ctx).followerCounts(ids)),
    );
  });

  describe("get_vendor_followers / get_vendor_followers_v2 (owner only)", () => {
    // parity-tested: get_vendor_followers, get_vendor_followers_v2
    for (const fn of ["get_vendor_followers", "get_vendor_followers_v2"] as const) {
      const port = (ctx: Parameters<typeof service>[0], who: string | null) =>
        fn === "get_vendor_followers" ? service(ctx).followers(me(who), shopA) : service(ctx).followersDetailed(me(who), shopA);
      it(`${fn}: the owner sees the list`, async () => {
        const a = await same(runOriginal(db, me(ownerA), fn, { p_vendor_id: shopA }), runIsolated(db, (ctx) => port(ctx, ownerA)));
        expect(a.result).toHaveLength(2);
      });
      it(`${fn}: anyone else is refused`, async () => {
        const a = await same(runOriginal(db, me(fan), fn, { p_vendor_id: shopA }), runIsolated(db, (ctx) => port(ctx, fan)));
        expect(a.error).toBe("Only the vendor owner can view the follower list");
      });
    }
  });

  for (const [label, who] of [["as a follower of the network", () => ownerA], ["as the fan", () => fan], ["signed out", () => null]] as const) {
    it(`get_vendor_follower_network ${label}`, () =>
      same(
        runOriginal(db, me(who()), "get_vendor_follower_network", { p_vendor_id: shopA }),
        runIsolated(db, (ctx) => service(ctx).followerNetwork(me(who()), shopA)),
      ),
    );
  }

  describe("set_vendor_follow_preferences", () => {
    const prefs = { muteMode: "1h", notifyNewListing: true, notifyNewService: false, notifyNewPackage: true, notifyNewVariety: true, notifyPriceChange: false, notifyDiscount: true };
    const args = (mode: string) => ({
      p_vendor_id: shopB,
      p_mute_mode: mode,
      p_notify_new_listing: true,
      p_notify_new_service: false,
      p_notify_new_package: true,
      p_notify_new_variety: true,
      p_notify_price_change: false,
      p_notify_discount: true,
    });
    for (const mode of ["1h", "always", "none", "forever"]) {
      it(`mute ${mode}`, () =>
        same(
          runOriginal(db, me(fan), "set_vendor_follow_preferences", args(mode)),
          runIsolated(db, (ctx) => service(ctx).setPreferences(me(fan), shopB, { ...prefs, muteMode: mode })),
        ),
      );
    }
    it("refuses a shop you do not follow", () =>
      same(
        runOriginal(db, me(fan), "set_vendor_follow_preferences", { ...args("none"), p_vendor_id: shopC }),
        runIsolated(db, (ctx) => service(ctx).setPreferences(me(fan), shopC, { ...prefs, muteMode: "none" })),
      ));
    it("refuses a signed-out caller", () =>
      same(
        runOriginal(db, null, "set_vendor_follow_preferences", args("none")),
        runIsolated(db, (ctx) => service(ctx).setPreferences(null, shopB, prefs)),
      ));
  });
});
