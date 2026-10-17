import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { CarouselService } from "../../src/modules/carousel/carousel.service.js";
import { SupportService } from "../../src/modules/support/support.service.js";
import { identityOf, seedUser, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on support_requests and homepage_carousel_slides, against the endpoints that replace them. */
describe("parity: table queries - support requests and the home page carousel", () => {
  let db: TestDatabase;
  let admin: string;
  let user: string;
  let other: string;
  let request: string;
  let visible: string;
  let hidden: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    user = (await seedUser(db)).id;
    other = (await seedUser(db)).id;
    request = (await db.query<{ id: string }>(`insert into public.support_requests (user_id, subject, message) values ($1, 'Order', 'Where is it?') returning id`, [user]))[0]!.id;
    await db.query(`insert into public.support_requests (user_id, subject, message) values ($1, 'Mine', 'x')`, [other]);
    visible = (await db.query<{ id: string }>(`insert into public.homepage_carousel_slides (storage_path, image_url, sort_order) values ('homepage-carousel/a.jpg', 'https://cdn.test/a.jpg', 1) returning id`))[0]!.id;
    hidden = (await db.query<{ id: string }>(`insert into public.homepage_carousel_slides (storage_path, image_url, sort_order, is_active) values ('homepage-carousel/b.jpg', 'https://cdn.test/b.jpg', 0, false) returning id`))[0]!.id;
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const support = (ctx: DataContext) => new SupportService(() => ctx);
  const carousel = (ctx: DataContext) => new CarouselService(() => ctx);
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
  }

  describe("support_requests", () => {
    it("one's own requests; all of them for admins", async () => {
      for (const who of [user, admin]) {
        await same(
          runTableQuery(db, me(who), sql`select id, subject, message, status, admin_reply, attachments, created_at, updated_at from public.support_requests where user_id = ${who} order by created_at desc`),
          runIsolated(db, (ctx) => support(ctx).mine(me(who))),
        );
        await same(
          runTableQuery(db, me(who), sql`select id, user_id, subject, message, status, admin_reply, attachments, created_at, updated_at from public.support_requests order by created_at desc`),
          runIsolated(db, (ctx) => support(ctx).all(me(who))),
        );
      }
    });
    it("send a request", () =>
      same(
        runTableQuery(db, me(user), sql`insert into public.support_requests (user_id, subject, message, attachments) values (${user}, 'Refund', 'Please', '[]'::jsonb) returning id`),
        runIsolated(db, (ctx) => support(ctx).create(me(user), "Refund", "Please").then((r) => [r])),
      ));
    it("FIX B13: the user's update of the attachments matched no row, so they were never saved; the endpoint saves them", async () => {
      const files = [{ path: `${user}/${request}/a.jpg`, name: "a.jpg", type: "image/jpeg", size: 100 }];
      const original = await runTableQuery(db, me(user), sql`update public.support_requests set attachments = ${JSON.stringify(files)}::jsonb where id = ${request} and user_id = ${user} returning id`);
      expect(original.result).toEqual([]);
      const port = await runIsolated(db, (ctx) => support(ctx).setAttachments(me(user), request, files));
      expect(port.changes.support_requests!.updated).toMatchObject([{ after: { attachments: files } }]);
      const elsewhere = await runIsolated(db, (ctx) => support(ctx).setAttachments(me(user), request, [{ ...files[0]!, path: `${other}/x/a.jpg` }]));
      expect(elsewhere.error?.message).toBe("Attachments must be files uploaded for this request.");
      const notMine = await runIsolated(db, (ctx) => support(ctx).setAttachments(me(other), request, [{ ...files[0]!, path: `${other}/${request}/a.jpg` }]));
      expect(notMine.error?.message).toBe("Support request not found.");
    });
    it("delete (nobody may: nothing is removed, as before)", () =>
      same(
        runTableQuery(db, me(user), sql`delete from public.support_requests where id = ${request} and user_id = ${user}`, false),
        runIsolated(db, (ctx) => support(ctx).remove(me(user), request).then(() => null)),
      ));
    it("an admin answers (others change nothing)", async () => {
      for (const who of [admin, user]) {
        await same(
          runTableQuery(db, me(who), sql`update public.support_requests set status = 'resolved', admin_reply = 'Done' where id = ${request}`, false),
          runIsolated(db, (ctx) => support(ctx).answer(me(who), request, "resolved", "Done").then(() => null)),
        );
      }
    });
  });

  describe("homepage_carousel_slides", () => {
    const listSql = (activeOnly: boolean) =>
      sql`select id, storage_path, image_url, link_url, alt_text, sort_order, is_active, created_by, created_at, updated_at from public.homepage_carousel_slides
          ${activeOnly ? sql`where is_active = true` : sql``} order by sort_order asc, created_at asc`;
    it("the banners: active for everyone; hidden ones only for admins", async () => {
      for (const who of [null, user, admin]) {
        for (const includeInactive of [false, true]) {
          await same(runTableQuery(db, who ? me(who) : null, listSql(!includeInactive)), runIsolated(db, (ctx) => carousel(ctx).slides(who ? me(who) : null, includeInactive)));
        }
      }
    });
    it("add a banner (admins; refused for others)", async () => {
      const slide = { storage_path: "homepage-carousel/c.jpg", image_url: "https://cdn.test/c.jpg", link_url: null, alt_text: "Sale", sort_order: 5, is_active: true };
      await same(
        runTableQuery(
          db,
          me(admin),
          sql`insert into public.homepage_carousel_slides (storage_path, image_url, link_url, alt_text, sort_order, is_active, created_by) values ('homepage-carousel/c.jpg', 'https://cdn.test/c.jpg', null, 'Sale', 5, true, ${admin})`,
          false,
        ),
        runIsolated(db, (ctx) => carousel(ctx).add(me(admin), [slide]).then(() => null)),
      );
      await bothRefused(
        runTableQuery(db, me(user), sql`insert into public.homepage_carousel_slides (storage_path, image_url) values ('x', 'y')`, false),
        runIsolated(db, (ctx) => carousel(ctx).add(me(user), [slide])),
      );
    });
    it("FIX B14: publishing the bundled banners sent storage_path null, which the table refuses", async () => {
      const original = await runTableQuery(db, me(admin), sql`insert into public.homepage_carousel_slides (image_url, storage_path, alt_text, sort_order, is_active, created_by) values ('/img/banner1.jpg', null, 'Welcome', 1, true, ${admin})`, false);
      expect(original.error?.message).toMatch(/null value in column "storage_path"/);
      const port = await runIsolated(db, (ctx) => carousel(ctx).add(me(admin), [{ image_url: "/img/banner1.jpg", storage_path: null, alt_text: "Welcome", sort_order: 1, is_active: true }]));
      expect(port.changes.homepage_carousel_slides!.inserted).toMatchObject([{ storage_path: "", image_url: "/img/banner1.jpg" }]);
    });
    it("change, hide and reorder (admins; others change nothing)", async () => {
      for (const who of [admin, user]) {
        await same(
          runTableQuery(db, me(who), sql`update public.homepage_carousel_slides set alt_text = 'New', link_url = '/sale', sort_order = 3, updated_at = now() where id = ${visible}`, false),
          runIsolated(db, (ctx) => carousel(ctx).update(me(who), visible, { alt_text: "New", link_url: "/sale", sort_order: 3 }).then(() => null)),
        );
        await same(
          runTableQuery(db, me(who), sql`update public.homepage_carousel_slides set is_active = true, updated_at = now() where id = ${hidden}`, false),
          runIsolated(db, (ctx) => carousel(ctx).update(me(who), hidden, { is_active: true }).then(() => null)),
        );
      }
      await same(
        runIsolated(db, (ctx) =>
          ctx.asCaller(me(admin), async (tx) => {
            await tx.execute(sql`update public.homepage_carousel_slides set sort_order = 0, updated_at = now() where id = ${visible}`);
            await tx.execute(sql`update public.homepage_carousel_slides set sort_order = 1, updated_at = now() where id = ${hidden}`);
            return null;
          }),
        ),
        runIsolated(db, (ctx) => carousel(ctx).reorder(me(admin), [{ id: visible, sort_order: 0 }, { id: hidden, sort_order: 1 }]).then(() => null)),
      );
    });
    it("delete (returns the file to remove); others remove nothing", async () => {
      const o = await runIsolated(db, (ctx) => carousel(ctx).remove(me(admin), visible));
      expect(o.result).toEqual({ removed: true, storage_path: "homepage-carousel/a.jpg" });
      await same(runTableQuery(db, me(admin), sql`delete from public.homepage_carousel_slides where id = ${visible}`, false), runIsolated(db, (ctx) => carousel(ctx).remove(me(admin), visible).then(() => null)));
      await same(runTableQuery(db, me(user), sql`delete from public.homepage_carousel_slides where id = ${visible}`, false), runIsolated(db, (ctx) => carousel(ctx).remove(me(user), visible).then(() => null)));
    });
  });
});
