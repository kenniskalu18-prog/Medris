import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { FILE_BUCKETS } from "../../database/repositories/storage-access.repository.js";
import { commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/**
 * Files in Supabase Storage, brokered by the backend. Replaces the app's `sb.storage` calls (27, in 9 buckets):
 * the same rules as the storage policies decide who may upload, read or delete.
 */

const tags = ["Files"];
const limit = rateLimit({ name: "files", limit: 120, windowMs: 60_000 });
const Bucket = z.enum(FILE_BUCKETS);
const Path = z.string().min(1).max(512);

export const uploadLink = defineRoute({
  method: "post",
  path: "/files/upload-links",
  tags,
  summary: "A link to upload one file",
  description: "Replaces `sb.storage.from(bucket).upload(path, file)`. The browser PUTs the file to `uploadUrl` within 2 hours. Refused (403) where the storage policies refused.",
  security: signedIn,
  middleware: [limit] as const,
  request: { body: jsonBody(z.object({ bucket: Bucket, path: Path, contentType: z.string().min(1).max(100), upsert: z.boolean().default(false) })) },
  responses: {
    200: dataResponse(z.object({ uploadUrl: z.string(), method: z.enum(["PUT", "POST"]), expiresInSeconds: z.number(), fields: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), publicUrl: z.string().optional() }), "The upload."),
    ...errorResponses(400, 401, 403, 415, 429),
    ...commonErrors,
  },
});

export const signedUrls = defineRoute({
  method: "post",
  path: "/files/signed-urls",
  tags,
  summary: "Links to read private files",
  description: "Replaces `createSignedUrl` / `createSignedUrls`. Refused (403) if any of the files may not be read by the caller.",
  security: optionalSignIn,
  middleware: [limit] as const,
  request: { body: jsonBody(z.object({ bucket: Bucket, paths: z.array(Path).min(1).max(100), expiresIn: z.number().int().min(60).max(86_400).default(3600) })) },
  responses: { 200: dataResponse(z.array(z.object({ path: z.string(), signedUrl: z.string().nullable() })), "One link per file (null if it does not exist)."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

export const removeFiles = defineRoute({
  method: "post",
  path: "/files/delete",
  tags,
  summary: "Delete files",
  description: "Replaces `sb.storage.from(bucket).remove(paths)`. Refused (403) if any of the files may not be deleted by the caller.",
  security: signedIn,
  middleware: [limit] as const,
  request: { body: jsonBody(z.object({ bucket: Bucket, paths: z.array(Path).min(1).max(100) })) },
  responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many were deleted."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const listFiles = defineRoute({
  method: "post",
  path: "/files/list",
  tags,
  summary: "List a public folder",
  description: "Replaces `sb.storage.from(bucket).list(prefix)`: one level, folders marked. Only the public buckets (avatars, vendor-logos, product-photos, homepage-carousel).",
  security: optionalSignIn,
  middleware: [limit] as const,
  request: { body: jsonBody(z.object({ bucket: Bucket, prefix: z.string().max(512).default("") })) },
  responses: { 200: dataResponse(z.array(z.object({ name: z.string(), folder: z.boolean() })), "The entries."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});
