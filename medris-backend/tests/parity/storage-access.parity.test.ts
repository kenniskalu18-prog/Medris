import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageAccessRepository, type FileBucket } from "../../src/database/repositories/storage-access.repository.js";
import { rowsOf } from "../../src/database/client.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { runIsolated } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * Who may upload, read, overwrite or delete a file: the storage policies on storage.objects (what Supabase Storage
 * applied to the browser's own session) against StorageAccessRepository.allowed() (what the files endpoints check
 * before acting with the service key). Every bucket, every kind of caller, the paths the app writes plus forged ones.
 *
 * The original is run the way Storage runs it as the user: insert ... returning (upload), select (read),
 * insert ... on conflict do update ... returning (upload over an existing file), delete ... returning (delete).
 * A policy error (a folder that is not a uuid where the policy casts it) counts as refused.
 */
describe("parity: storage policies", () => {
  let db: TestDatabase;
  const who: Record<string, string | null> = { anon: null };
  let shop: string;
  let otherShop: string;
  let conv: string;
  let otherConv: string;
  let order: string;
  const paths: Partial<Record<FileBucket, string[]>> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    who.admin = (await seedUser(db)).id;
    await setRole(db, who.admin, "admin");
    who.buyer = (await seedUser(db)).id;
    who.owner = (await seedUser(db, { role: "vendor" })).id;
    who.otherOwner = (await seedUser(db, { role: "vendor" })).id;
    who.outsider = (await seedUser(db)).id;
    shop = (await seedVendor(db, who.owner)).id;
    otherShop = (await seedVendor(db, who.otherOwner)).id;
    const product = await seedProduct(db, shop);
    conv = (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [who.buyer, shop]))[0]!.id;
    otherConv = (await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [who.outsider, otherShop]))[0]!.id;
    order = await seedOrder(db, who.buyer, shop, { status: "pending", productIds: [product] });
    const { buyer, owner, outsider } = who as Record<string, string>;
    const mine = [`${buyer}/a.jpg`, `${owner}/a.jpg`, `${buyer}/sub/a.jpg`, `a.jpg`];
    Object.assign(paths, {
      "vendor-docs": mine,
      "support-attachments": mine,
      "listing-payment-receipts": mine,
      avatars: [`${buyer}/avatar.jpg`, `${owner}/avatar.jpg`, `avatar.jpg`],
      "chat-attachments": [`conv/${conv}/a.jpg`, `conv/${otherConv}/a.jpg`, `ai/${buyer}/a.jpg`, `ai/${owner}/a.jpg`, `conv/not-a-uuid/a.jpg`, `${buyer}/a.jpg`],
      "dispute-evidence": [`${buyer}/${order}/a.jpg`, `${owner}/${order}/a.jpg`, `${outsider}/${order}/a.jpg`, `${buyer}/x/a.jpg`, `${outsider}/a.jpg`],
      "product-photos": [`${shop}/a.jpg`, `${otherShop}/a.jpg`, `nope/a.jpg`],
      "vendor-logos": [`${shop}/cover.jpg`, `${otherShop}/cover.jpg`, `verification/${owner}/a.jpg`, `verification/${buyer}/a.jpg`, `nope/a.jpg`],
      "homepage-carousel": [`slides/a.jpg`, `a.jpg`],
    } satisfies Partial<Record<FileBucket, string[]>>);
    for (const [bucket, list] of Object.entries(paths)) {
      for (const name of list!) await db.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]);
    }
  }, 60_000);
  afterAll(() => db.close());

  const fresh = (path: string) => path.replace(/[^/]+$/, "new.jpg");
  const ops = {
    upload: (bucket: string, path: string) => sql`insert into storage.objects (bucket_id, name) values (${bucket}, ${fresh(path)}) returning id`,
    read: (bucket: string, path: string) => sql`select id from storage.objects where bucket_id = ${bucket} and name = ${path}`,
    overwrite: (bucket: string, path: string) =>
      sql`insert into storage.objects (bucket_id, name) values (${bucket}, ${path}) on conflict (bucket_id, name) do update set updated_at = now(), version = 'v2' returning id`,
    delete: (bucket: string, path: string) => sql`delete from storage.objects where bucket_id = ${bucket} and name = ${path} returning id`,
  } satisfies Record<string, (b: string, p: string) => SQL>;

  async function original(caller: string | null, query: SQL): Promise<boolean> {
    const o = await runIsolated(db, (ctx) => ctx.asCaller(caller ? identityOf(caller) : null, async (tx) => rowsOf(await tx.execute(query)).length === 1), []);
    return o.error ? false : Boolean(o.result);
  }
  async function port(caller: string | null, bucket: FileBucket, op: keyof typeof ops, path: string): Promise<boolean> {
    const o = await runIsolated(
      db,
      (ctx) =>
        ctx.asService((tx) => {
          const access = new StorageAccessRepository(tx);
          if (op === "overwrite") return access.allowed(caller, bucket, "upload", path, { upsert: true });
          if (op === "upload") return access.allowed(caller, bucket, "upload", fresh(path), { upsert: false });
          return access.allowed(caller, bucket, op, path);
        }),
      [],
    );
    if (o.error) throw new Error(o.error.message);
    return o.result!;
  }

  it.each(Object.keys(ops) as (keyof typeof ops)[])("%s: same answer for every bucket, caller and path", async (op) => {
    const differences: string[] = [];
    let allowedCount = 0;
    for (const [bucket, list] of Object.entries(paths) as [FileBucket, string[]][]) {
      for (const path of list) {
        for (const [name, caller] of Object.entries(who)) {
          const [a, b] = [await original(caller, ops[op](bucket, path)), await port(caller, bucket, op, path)];
          if (a) allowedCount++;
          if (a !== b) differences.push(`${bucket} ${path.replaceAll(/[0-9a-f-]{36}/g, (id) => Object.entries({ ...who, shop, otherShop, conv, otherConv, order }).find(([, v]) => v === id)?.[0] ?? id)} as ${name}: policy ${a}, port ${b}`);
        }
      }
    }
    expect(differences).toEqual([]);
    expect(allowedCount).toBeGreaterThan(0);
  }, 120_000);

  it("a file a caller may upload but not overwrite (no update rule in the bucket) is refused only when it exists", async () => {
    const buyer = who.buyer!;
    const path = `${buyer}/a.jpg`;
    expect(await port(buyer, "vendor-docs", "overwrite", path)).toBe(false);
    expect(await port(buyer, "vendor-docs", "overwrite", fresh(path))).toBe(true);
  });

  it("a shop owner may upload their verification photo to vendor-logos/verification/<own id>/, and nobody else's", async () => {
    const owner = who.owner!;
    expect(await original(owner, ops.upload("vendor-logos", `verification/${owner}/a.jpg`))).toBe(await port(owner, "vendor-logos", "upload", `verification/${owner}/a.jpg`));
    expect(await port(owner, "vendor-logos", "upload", `verification/${owner}/a.jpg`)).toBe(true);
    expect(await port(owner, "vendor-logos", "upload", `verification/${who.buyer}/a.jpg`)).toBe(false);
  });
});
