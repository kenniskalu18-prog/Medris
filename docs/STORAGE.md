# Files and images

## Today

| Where | What | Access |
|---|---|---|
| **Cloudflare R2** (`R2_*`) | public images: `product-photos/`, `avatars/`, `vendor-logos/`, `homepage-carousel/` | the browser uploads with a 2-minute presigned PUT from `/api/vendor-payments` (`r2-presign-upload`); public URLs, immutable cache headers |
| **Supabase Storage**, private buckets | `vendor-docs`, `chat-attachments`, `support-attachments`, `listing-payment-receipts`, `dispute-evidence` | browser uploads with the user's session; storage policies decide; signed URLs to read |
| **Supabase Storage**, legacy public buckets | `product-photos` (~277 files, 144 MB), `avatars`, `vendor-logos`, `homepage-carousel` | older images not yet copied to R2 (admin "R2 migration" tool) |

No file has been moved, renamed or deleted by this work, and every existing URL keeps working.

## In the backend

`medris-backend/src/integrations/storage/` puts every provider behind one interface:

```ts
interface ObjectStorage {
  createDirectUpload(key, contentType): Promise<DirectUpload>; // presigned PUT (R2), signed upload (Supabase), signed POST (Cloudinary)
  put(key, bytes, contentType): Promise<void>;
  publicUrl(key): string;
  remove(keys): Promise<void>;
  list(prefix): Promise<string[]>;
}
```

| Adapter | Used for | Status |
|---|---|---|
| `R2Storage` | public images (presigned uploads, the copy/optimise admin tools) | in use (same behaviour as before) |
| `SupabaseStorage` | private buckets; account deletion's clean-up; reading legacy public files to copy them to R2 | in use, isolated (only place that calls `/storage/v1`) |
| `CloudinaryStorage` | images, if chosen: server-signed direct uploads (SHA-1 signature over sorted params + API secret), `f_auto,q_auto` delivery URLs, deletes | built, **inactive** |

Keys are validated (no `..`, no absolute paths, no control characters); service credentials never leave the backend.

### `/api/v1/files` - the browser's Storage calls, brokered (built, not switched on)

| Endpoint | Replaces | Who may |
|---|---|---|
| `POST /files/upload-links {bucket, path, contentType, upsert}` | `.upload(path, file, { upsert })` | the bucket's insert rule; with `upsert`, also its update rule when the file exists |
| `POST /files/signed-urls {bucket, paths, expiresIn}` | `.createSignedUrl(s)` | the bucket's select rule, for every path |
| `POST /files/delete {bucket, paths}` | `.remove(paths)` | the bucket's delete rule, for every path |
| `POST /files/list {bucket, prefix}` | `.list(prefix)` (admin copy-to-R2 tool) | public buckets only |
| - | `.getPublicUrl(path)` | nothing to call: the URL is fixed, and an upload link to a public bucket returns it |

The rules are the storage.objects policies, ported in `StorageAccessRepository` and compared with the real policies
for every bucket, caller, path and operation in `tests/parity/storage-access.parity.test.ts`. The files stay where
they are; Supabase keeps hosting them.

## Switching public images to Cloudinary (needs approval)

1. Create a Cloudinary account; set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   (`CLOUDINARY_FOLDER`, default `levromart`) in Vercel.
2. Set `IMAGE_STORAGE=cloudinary` (the config check refuses it without the credentials). `publicImageStorage()` then
   returns the Cloudinary adapter.
3. Frontend: the shared upload helper (the `r2-presign-upload` call in
   `src/legacy/assets/js/01-app/15-toasts-confirm-dialog-replace-native-ale.js`) asks the backend for an upload and
   follows the returned `DirectUpload` (method, URL, fields) instead of always doing an R2 PUT.
4. Existing images stay where they are; their URLs are stored in the database and keep working. Copying them is a
   separate, approved job (idempotent, like the existing R2 migration tool), followed by a URL rewrite in the database
   only after the copies are verified.

## Private files off Supabase Storage (later, needs approval)

Move the private buckets to R2 (private bucket) or S3 with backend-issued signed URLs, replacing the 32 storage
policies with backend authorisation (the same owner/participant/admin rules). Requires: new upload/download
endpoints, moving the objects, rewriting stored paths. Not started.
