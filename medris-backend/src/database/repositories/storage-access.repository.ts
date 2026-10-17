import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";

export type StorageOperation = "upload" | "read" | "delete";
type Rule = StorageOperation | "update";

/** The buckets the app uses, private ones first. */
export const FILE_BUCKETS = [
  "vendor-docs",
  "chat-attachments",
  "support-attachments",
  "listing-payment-receipts",
  "dispute-evidence",
  "avatars",
  "vendor-logos",
  "product-photos",
  "homepage-carousel",
] as const;
export type FileBucket = (typeof FILE_BUCKETS)[number];

/** The bucket's public files anyone may read (no signed link needed). */
export const PUBLIC_BUCKETS: readonly FileBucket[] = ["avatars", "vendor-logos", "product-photos", "homepage-carousel"];

/** A JS boolean as SQL `true`/`false` (a bound parameter would arrive as the text 'true'/'false'). */
const lit = (value: boolean): SQL => (value ? sql`true` : sql`false`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may upload, read or delete a file - the storage policies on storage.objects, ported. Each rule takes the
 * caller's id explicitly and the path's folders (`a/b/file.jpg` -> ["a", "b"]), as `storage.foldername()` gives.
 * Uploading over a file that already exists (upsert) needs the bucket's update rule as well; only avatars,
 * vendor-logos, homepage-carousel and listing-payment-receipts have one, so elsewhere an overwrite is refused.
 */
export class StorageAccessRepository {
  constructor(private readonly db: Executor) {}

  async allowed(me: string | null, bucket: FileBucket, op: StorageOperation, path: string, options: { upsert?: boolean } = {}): Promise<boolean> {
    const rule = this.rule(me, bucket, op, path);
    if (op !== "upload" || !options.upsert) return this.check(rule);
    const exists = sql`exists (select 1 from storage.objects where bucket_id = ${bucket} and name = ${path})`;
    return this.check(sql`(${rule}) and (not ${exists} or (${this.rule(me, bucket, "update", path)}))`);
  }

  private async check(rule: SQL): Promise<boolean> {
    return (await jsonRow<{ ok: boolean }>(this.db, sql`select coalesce((${rule})::boolean, false) as ok`))?.ok === true;
  }

  private rule(me: string | null, bucket: FileBucket, op: Rule, path: string): SQL {
    const folders = path.split("/").slice(0, -1);
    const f1 = folders[0] ?? null;
    const f2 = folders[1] ?? null;
    if (op === "read" && PUBLIC_BUCKETS.includes(bucket)) return sql`true`;
    if (!me) return sql`false`;
    const isMe = lit(f1 === me);
    const admin = sql`coalesce((select role = 'admin' from public.users where id = ${me}), false)`;
    const ownsShop = (id: string | null) => (id && UUID.test(id) ? sql`exists (select 1 from public.vendors where id = ${id}::uuid and user_id = ${me})` : sql`false`);
    if (op === "update") {
      if (bucket === "avatars") return isMe;
      if (bucket === "homepage-carousel") return admin;
      if (bucket === "listing-payment-receipts") return sql`(${isMe} or ${admin})`;
      if (bucket === "vendor-logos") return ownsShop(f1);
      return sql`false`;
    }
    let rule: SQL;
    switch (bucket) {
      case "vendor-docs":
      case "support-attachments":
        rule = op === "upload" ? isMe : op === "read" ? sql`(${isMe} or ${admin})` : bucket === "support-attachments" ? sql`(${isMe} or ${admin})` : isMe;
        break;
      case "listing-payment-receipts":
        rule = op === "upload" ? isMe : sql`(${isMe} or ${admin})`;
        break;
      case "avatars":
        rule = isMe;
        break;
      case "chat-attachments": {
        // The policy casts the folder after conv/ to a uuid; anything else makes it fail, for admins too.
        if (f1 === "conv" && !(f2 && UUID.test(f2))) return sql`false`;
        const participant =
          f1 === "conv" && f2 && UUID.test(f2)
            ? sql`exists (select 1 from public.conversations c where c.id = ${f2}::uuid and (c.buyer_id = ${me} or (select v.user_id from public.vendors v where v.id = c.vendor_id) = ${me}))`
            : sql`false`;
        const own = lit(f1 === "ai" && f2 === me);
        rule = op === "upload" ? sql`(${participant} or ${own})` : op === "read" ? sql`(${participant} or ${own} or ${admin})` : sql`false`;
        break;
      }
      case "dispute-evidence": {
        const party =
          f2 && UUID.test(f2)
            ? sql`exists (select 1 from public.orders o where o.id = ${f2}::uuid and (o.buyer_id = ${me} or exists (select 1 from public.vendors v where v.id = o.vendor_id and v.user_id = ${me})))`
            : sql`false`;
        rule = op === "upload" ? isMe : op === "read" ? sql`(${isMe} or ${admin} or ${party})` : sql`false`;
        break;
      }
      case "homepage-carousel":
        rule = op === "read" ? sql`true` : admin;
        break;
      case "product-photos":
        rule = ownsShop(f1);
        break;
      case "vendor-logos":
        rule = op === "upload" ? sql`(${ownsShop(f1)} or ${lit(f1 === "verification" && f2 === me)})` : ownsShop(f1);
        break;
    }
    return rule;
  }
}
