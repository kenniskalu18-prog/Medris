import type { DataContext, Identity } from "../../database/context.js";
import { PUBLIC_BUCKETS, StorageAccessRepository, type FileBucket, type StorageOperation } from "../../database/repositories/storage-access.repository.js";
import { SupabaseStorage, type DirectUpload } from "../../integrations/storage/index.js";
import { assertSafeKey } from "../../integrations/storage/types.js";
import { badRequest, forbidden } from "../../shared/errors/app-error.js";

/** What the service needs from a bucket (Supabase Storage in production, a fake in tests). */
export interface BucketClient {
  createDirectUpload(key: string, contentType: string, options?: { upsert?: boolean }): Promise<DirectUpload>;
  signedUrls(keys: string[], expiresInSeconds: number): Promise<{ path: string; signedUrl: string | null }[]>;
  remove(keys: string[]): Promise<void>;
  listEntries(prefix: string): Promise<{ name: string; folder: boolean }[]>;
  publicUrl(key: string): string;
}

/**
 * Files in Supabase Storage (they stay there; Supabase keeps hosting them). The browser no longer talks to Storage
 * with its own session: it asks here, the caller is checked against the same rules as the storage policies
 * (StorageAccessRepository), and the backend hands out a one-file upload link, signed read links, or deletes.
 */
export class FilesService {
  constructor(
    private readonly db: () => DataContext,
    private readonly bucket: (name: FileBucket) => BucketClient = (name) => SupabaseStorage.fromEnv(name),
  ) {}

  private async check(me: Identity | null, bucket: FileBucket, op: StorageOperation, paths: string[], upsert = false): Promise<void> {
    for (const p of paths) {
      try {
        assertSafeKey(p);
      } catch {
        throw badRequest("Invalid file path.");
      }
    }
    const denied = await this.db().asService(async (tx) => {
      const access = new StorageAccessRepository(tx);
      for (const p of paths) if (!(await access.allowed(me?.userId ?? null, bucket, op, p, { upsert }))) return p;
      return null;
    });
    if (denied) throw forbidden("You are not allowed to do that with this file.");
  }

  /** Replaces `sb.storage.from(bucket).upload(path, file, { upsert })`: a one-file upload link (2 hours). */
  async uploadLink(me: Identity, bucket: FileBucket, path: string, contentType: string, upsert: boolean): Promise<DirectUpload> {
    await this.check(me, bucket, "upload", [path], upsert);
    const client = this.bucket(bucket);
    const upload = await client.createDirectUpload(path, contentType, { upsert });
    return PUBLIC_BUCKETS.includes(bucket) ? { ...upload, publicUrl: client.publicUrl(path) } : upload;
  }

  /** Replaces `createSignedUrl(s)`: read links, only for files the caller may read. */
  async signedUrls(me: Identity | null, bucket: FileBucket, paths: string[], expiresInSeconds: number): Promise<{ path: string; signedUrl: string | null }[]> {
    await this.check(me, bucket, "read", paths);
    return this.bucket(bucket).signedUrls(paths, expiresInSeconds);
  }

  /** Replaces `remove(paths)`: deletes the caller's files. */
  async remove(me: Identity, bucket: FileBucket, paths: string[]): Promise<{ removed: number }> {
    await this.check(me, bucket, "delete", paths);
    await this.bucket(bucket).remove(paths);
    return { removed: paths.length };
  }

  /**
   * Replaces `sb.storage.from(bucket).list(prefix)` (the admin's one-time copy to R2). The public buckets' files
   * are readable by anyone, so anyone may list them; the private buckets are not listed.
   */
  async list(bucket: FileBucket, prefix: string): Promise<{ name: string; folder: boolean }[]> {
    if (!PUBLIC_BUCKETS.includes(bucket)) throw forbidden("This folder cannot be listed.");
    if (prefix) {
      try {
        assertSafeKey(prefix);
      } catch {
        throw badRequest("Invalid folder.");
      }
    }
    return this.bucket(bucket).listEntries(prefix);
  }
}
