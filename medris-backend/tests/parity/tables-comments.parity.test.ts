import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { asUserSeed, identityOf, seedPackage, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on product/package comments, their likes and the listings' engagement
 * settings, against the endpoints that replace them (the browser's query as the same user, through
 * row-level security, and the port, on the same rows).
 */
describe("parity: table queries - comments, likes and engagement settings", () => {
  let db: TestDatabase;
  let buyer: string;
  let follower: string;
  let owner: string;
  let rivalOwner: string;
  let shop: string;
  let rivalShop: string;
  let open: string; // comments from everyone
  let closed: string; // comments off
  let followersOnly: string;
  let fresh: string; // no settings row yet
  let pkg: string; // followers-only package
  let comment: string;
  let pkgComment: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db, { name: "Bola" })).id;
    follower = (await seedUser(db, { name: "Chi" })).id;
    owner = (await seedUser(db, { role: "vendor", name: "Dayo" })).id;
    rivalOwner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    rivalShop = (await seedVendor(db, rivalOwner, { name: "Rival" })).id;
    open = await seedProduct(db, shop, { name: "Open" });
    closed = await seedProduct(db, shop, { name: "Closed" });
    followersOnly = await seedProduct(db, shop, { name: "Followers" });
    fresh = await seedProduct(db, shop, { name: "Fresh" });
    pkg = await seedPackage(db, shop, { name: "Bundle" });
    await db.query(`insert into public.vendor_follows (vendor_id, follower_id) values ($1, $2)`, [shop, follower]);
    await db.query(
      `insert into public.product_engagement_settings (product_id, vendor_id, allow_comments, comment_audience, like_visibility) values
         ($1, $4, true, 'everyone', 'everyone'), ($2, $4, false, 'everyone', 'no_one'), ($3, $4, true, 'followers', 'followers')`,
      [open, closed, followersOnly, shop],
    );
    await db.query(`insert into public.package_engagement_settings (package_id, vendor_id, comment_audience) values ($1, $2, 'followers')`, [pkg, shop]);
    await asUserSeed(db, follower, [
      [`insert into public.product_comments (product_id, user_id, content, author_name) values ($1, $2, 'Nice!', 'x')`, [open, follower]],
      [`insert into public.package_comments (package_id, user_id, content, author_name) values ($1, $2, 'Members only', 'x')`, [pkg, follower]],
    ]);
    comment = (await db.query<{ id: string }>(`select id from public.product_comments where product_id = $1`, [open]))[0]!.id;
    pkgComment = (await db.query<{ id: string }>(`select id from public.package_comments where package_id = $1`, [pkg]))[0]!.id;
    await db.query(`insert into public.product_comment_likes (comment_id, user_id) values ($1, $2)`, [comment, owner]);
  }, 60_000);
  afterAll(() => db.close());

  function me(id: string): Identity;
  function me(id: string | null): Identity | null;
  function me(id: string | null) {
    return id ? identityOf(id) : null;
  }
  const eng = (ctx: DataContext) => new EngagementService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  async function bothRefused(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const [o, p] = [await original, await port];
    expect(o.error).toBeDefined();
    expect(p.error?.message).toBe(o.error?.message);
    expect(comparable(o, p).port.changes).toEqual(comparable(o, p).original.changes);
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  describe("comments and likes", () => {
    const read = (kind: "product" | "package", listing: string, who: string | null) =>
      runIsolated(db, (ctx) =>
        ctx.asCaller(me(who), async (tx) => {
          const t = kind === "product" ? { c: sql`public.product_comments`, l: sql`public.product_comment_likes`, k: sql`product_id` } : { c: sql`public.package_comments`, l: sql`public.package_comment_likes`, k: sql`package_id` };
          const rows = (await tx.execute(sql`select coalesce(json_agg(to_json(x)), '[]'::json) as j from (select id, ${t.k}, user_id, parent_comment_id, content, author_name, author_avatar_url, created_at, updated_at from ${t.c} where ${t.k} = ${listing} order by created_at desc limit 120) x`)) as unknown as { rows: { j: { id: string }[] }[] };
          const comments = rows.rows[0]!.j;
          const likes = comments.length
            ? ((await tx.execute(sql`select coalesce(json_agg(to_json(x)), '[]'::json) as j from (select id, comment_id, user_id from ${t.l} where comment_id in (${sql.join(comments.map((c) => sql`${c.id}::uuid`), sql`, `)})) x`)) as unknown as { rows: { j: unknown[] }[] }).rows[0]!.j
            : [];
          return { comments, likes };
        }),
      );
    it("a product's comments and likes (signed in or out)", async () => {
      for (const who of [buyer, null]) await same(read("product", open, who), runIsolated(db, (ctx) => eng(ctx).listingComments(who ? identityOf(who) : null, "product", open)));
    });
    it("a followers-only package's comments: followers and the shop see them, others do not", async () => {
      for (const who of [follower, owner, buyer, null]) {
        const o = await same(read("package", pkg, who), runIsolated(db, (ctx) => eng(ctx).listingComments(me(who), "package", pkg)));
        expect((o.result as { comments: unknown[] }).comments.length).toBe(who === follower || who === owner ? 1 : 0);
      }
    });
    const insert = (kind: "product" | "package", listing: string, who: string, content: string) =>
      kind === "product"
        ? sql`insert into public.product_comments (product_id, user_id, parent_comment_id, content, author_name, author_avatar_url) values (${listing}, ${who}, null, ${content}, 'Bola', null)`
        : sql`insert into public.package_comments (package_id, user_id, parent_comment_id, content, author_name, author_avatar_url) values (${listing}, ${who}, null, ${content}, 'Bola', null)`;
    it("comment: open listing, a reply, and followers-only as a follower (the shop is notified)", async () => {
      await same(runTableQuery(db, me(buyer), insert("product", open, buyer, "Price?"), false), runIsolated(db, (ctx) => eng(ctx).addComment(me(buyer), "product", open, "Price?", null).then(() => null)));
      await same(
        runTableQuery(db, me(owner), sql`insert into public.product_comments (product_id, user_id, parent_comment_id, content, author_name) values (${open}, ${owner}, ${comment}, 'Thanks', 'x')`, false),
        runIsolated(db, (ctx) => eng(ctx).addComment(me(owner), "product", open, "Thanks", comment).then(() => null)),
      );
      await same(runTableQuery(db, me(follower), insert("product", followersOnly, follower, "Hi"), false), runIsolated(db, (ctx) => eng(ctx).addComment(me(follower), "product", followersOnly, "Hi", null).then(() => null)));
    });
    it("FINDING S7: a package comment takes the author's name from the browser (anyone can post as anyone); the endpoint uses the profile", async () => {
      const forged = await runTableQuery(
        db,
        me(follower),
        sql`insert into public.package_comments (package_id, user_id, content, author_name, author_avatar_url) values (${pkg}, ${follower}, 'Official notice', 'Levromart Support', 'https://evil.test/logo.png') returning author_name, author_avatar_url`,
      );
      expect(forged.result).toEqual([{ author_name: "Levromart Support", author_avatar_url: "https://evil.test/logo.png" }]);
      const port = await runIsolated(db, (ctx) => eng(ctx).addComment(me(follower), "package", pkg, "Official notice", null));
      expect(port.changes.package_comments!.inserted).toMatchObject([{ author_name: "Chi", author_avatar_url: null }]);
      expect(port.changes.notifications!.inserted).toMatchObject([{ title: 'Chi commented on your package "Bundle"' }]);
    });
    it("comment refused: comments off, followers-only as a non-follower", async () => {
      await bothRefused(runTableQuery(db, me(buyer), insert("product", closed, buyer, "x"), false), runIsolated(db, (ctx) => eng(ctx).addComment(me(buyer), "product", closed, "x", null)));
      await bothRefused(runTableQuery(db, me(buyer), insert("product", followersOnly, buyer, "x"), false), runIsolated(db, (ctx) => eng(ctx).addComment(me(buyer), "product", followersOnly, "x", null)));
      await bothRefused(runTableQuery(db, me(buyer), insert("package", pkg, buyer, "x"), false), runIsolated(db, (ctx) => eng(ctx).addComment(me(buyer), "package", pkg, "x", null)));
    });
    it("delete one's own comment (someone else's stays)", async () => {
      for (const who of [follower, buyer]) {
        await same(
          runTableQuery(db, me(who), sql`delete from public.product_comments where id = ${comment} and user_id = ${who}`, false),
          runIsolated(db, (ctx) => eng(ctx).deleteComment(me(who), "product", comment).then(() => null)),
        );
      }
      await same(
        runTableQuery(db, me(follower), sql`delete from public.package_comments where id = ${pkgComment} and user_id = ${follower}`, false),
        runIsolated(db, (ctx) => eng(ctx).deleteComment(me(follower), "package", pkgComment).then(() => null)),
      );
    });
    it("like (the commenter is notified) and unlike", async () => {
      const toggle = (who: string) =>
        runIsolated(db, (ctx) =>
          ctx.asCaller(me(who), async (tx) => {
            const found = ((await tx.execute(sql`select id from public.product_comment_likes where comment_id = ${comment} and user_id = ${who}`)) as unknown as { rows: { id: string }[] }).rows[0];
            if (found) await tx.execute(sql`delete from public.product_comment_likes where id = ${found.id} and user_id = ${who}`);
            else await tx.execute(sql`insert into public.product_comment_likes (comment_id, user_id) values (${comment}, ${who})`);
            return { liked: !found };
          }),
        );
      for (const who of [buyer, owner]) await same(toggle(who), runIsolated(db, (ctx) => eng(ctx).toggleCommentLike(me(who), "product", comment)));
    });
  });

  describe("engagement settings", () => {
    it("one listing's settings, and several listings' like visibility", async () => {
      for (const listing of [open, closed, fresh]) {
        await same(
          runTableQuery(db, me(buyer), sql`select vendor_id, like_visibility, allow_comments, comment_audience from public.product_engagement_settings where product_id = ${listing}`).then(single),
          runIsolated(db, (ctx) => eng(ctx).listingSettings(me(buyer), "product", listing)),
        );
      }
      await same(
        runTableQuery(db, null, sql`select product_id, vendor_id, like_visibility from public.product_engagement_settings where product_id in (${open}, ${closed}, ${fresh})`),
        runIsolated(db, (ctx) => eng(ctx).settingsFor(null, "product", [open, closed, fresh])),
      );
      await same(
        runTableQuery(db, me(buyer), sql`select vendor_id, like_visibility, allow_comments, comment_audience from public.package_engagement_settings where package_id = ${pkg}`).then(single),
        runIsolated(db, (ctx) => eng(ctx).listingSettings(me(buyer), "package", pkg)),
      );
    });
    const upsert = (listing: string, vendor: string, allow: boolean) =>
      sql`insert into public.product_engagement_settings (product_id, vendor_id, like_visibility, allow_comments, comment_audience)
          values (${listing}, ${vendor}, 'everyone', ${allow}, 'everyone')
          on conflict (product_id) do update set vendor_id = excluded.vendor_id, like_visibility = excluded.like_visibility,
            allow_comments = excluded.allow_comments, comment_audience = excluded.comment_audience`;
    it("the shop saves settings (new row and change)", async () => {
      for (const listing of [fresh, closed]) {
        await same(
          runTableQuery(db, me(owner), upsert(listing, shop, true), false),
          runIsolated(db, (ctx) => eng(ctx).saveSettings(me(owner), "product", listing, shop, { like_visibility: "everyone", allow_comments: true, comment_audience: "everyone" }).then(() => null)),
        );
      }
    });
    it("FINDING S6: another shop could turn off comments on this listing (and the owner could not undo it); the endpoint refuses", async () => {
      const takeover = await runIsolated(db, async (ctx) => {
        await ctx.asCaller(me(rivalOwner), (tx) => tx.execute(upsert(fresh, rivalShop, false)));
        const undo = await ctx.asCaller(me(owner), (tx) => tx.execute(upsert(fresh, shop, true))).then(
          () => "undone",
          () => "refused",
        );
        const row = ((await ctx.asService((tx) => tx.execute(sql`select vendor_id, allow_comments from public.product_engagement_settings where product_id = ${fresh}`))) as unknown as { rows: unknown[] }).rows[0];
        return { undo, row };
      });
      expect(takeover.result).toEqual({ undo: "refused", row: { vendor_id: rivalShop, allow_comments: false } });
      const port = await runIsolated(db, (ctx) => eng(ctx).saveSettings(me(rivalOwner), "product", fresh, rivalShop, { allow_comments: false }));
      expect(port.error?.message).toBe("This listing does not belong to that shop.");
    });
    it("someone who does not own the shop: refused by both", () =>
      bothRefused(runTableQuery(db, me(buyer), upsert(open, shop, false), false), runIsolated(db, (ctx) => eng(ctx).saveSettings(me(buyer), "product", open, shop, { allow_comments: false }))));
  });
});
