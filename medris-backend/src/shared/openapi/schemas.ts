import { z } from "./zod.js";
import { ERROR_CODES } from "../errors/app-error.js";
import { id } from "../validation/index.js";

/**
 * Building blocks for the OpenAPI description of /api/v1: the response
 * envelopes, the standard error responses and common parameters.
 *
 * Every success body is `{ "data": ... }`; every failure is the ErrorResponse
 * below (shared/errors/handler.ts produces it).
 */

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ example: "validation_failed" }),
      message: z.string().openapi({ example: "The request is not valid." }),
      details: z
        .unknown()
        .optional()
        .openapi({
          description: "validation_failed: a list of { path, message }; rate_limited: { retryAfterSeconds }",
          example: [{ path: "productId", message: "Must be a valid id." }],
        }),
    }),
    requestId: z.string().optional().openapi({ description: "Quote this when reporting a problem (also in the X-Request-Id header)." }),
  })
  .openapi("ErrorResponse");

/** `{ "data": <schema> }` */
export function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

/** A JSON response for a route's `responses` map. */
export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } };
}

/** A success response wrapped in the `{ data }` envelope. */
export function dataResponse<T extends z.ZodType>(schema: T, description: string) {
  return jsonResponse(dataEnvelope(schema), description);
}

/** A required JSON request body. */
export function jsonBody<T extends z.ZodType>(schema: T, description?: string) {
  return { required: true, ...(description ? { description } : {}), content: { "application/json": { schema } } };
}

const ERROR_DESCRIPTIONS = {
  400: "Invalid input (`validation_failed` with details, or `bad_request`).",
  401: "Not signed in, or the token/session is invalid or expired (`unauthenticated`).",
  403: "Signed in but not allowed (`forbidden`).",
  404: "Not found, or the feature is switched off on this deployment (`feature_disabled`).",
  409: "Conflicts with the current state (`conflict`).",
  415: "A body was sent without `Content-Type: application/json` (`unsupported_media_type`).",
  429: "Too many requests (`rate_limited`); see the Retry-After header.",
  503: "A dependency (usually the database) is not available (`service_unavailable`).",
} as const;

const ERROR_EXAMPLES: Record<keyof typeof ERROR_DESCRIPTIONS, { code: string; message: string; details?: unknown }> = {
  400: { code: "validation_failed", message: "The request is not valid.", details: [{ path: "productId", message: "Must be a valid id." }] },
  401: { code: "unauthenticated", message: "Invalid or expired session. Please log in again." },
  403: { code: "forbidden", message: "You are not allowed to do that." },
  404: { code: "not_found", message: "Not found." },
  409: { code: "conflict", message: "That conflicts with the current state." },
  415: { code: "unsupported_media_type", message: "Send the request body as JSON (Content-Type: application/json)." },
  429: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again.", details: { retryAfterSeconds: 30 } },
  503: { code: "service_unavailable", message: "DATABASE_URL is not configured on this deployment." },
};

type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;
type ErrorResponseConfig = {
  description: string;
  content: { "application/json": { schema: typeof ErrorResponseSchema; example: unknown } };
};

/** The standard error responses, e.g. `...errorResponses(400, 401, 429)`. */
export function errorResponses<S extends ErrorStatus>(...statuses: S[]): Record<S, ErrorResponseConfig> {
  const out = {} as Record<S, ErrorResponseConfig>;
  for (const status of statuses) {
    out[status] = {
      description: ERROR_DESCRIPTIONS[status],
      content: { "application/json": { schema: ErrorResponseSchema, example: { error: ERROR_EXAMPLES[status], requestId: "3f2b9c1e-7a4d-4e8b-9c0a-1d2e3f4a5b6c" } } },
    };
  }
  return out;
}

/** Every request may hit these. */
export const commonErrors = errorResponses(503);

/** A database id in the path. */
export const idParam = id.openapi({ example: "6f1c2a0e-8a4b-4c1e-9d2f-3b5a7c9e1f20" });

export const IdParams = z.object({ id: idParam });

export const CountSchema = z.object({ count: z.number().int().min(0) }).openapi("Count");

export const isoDateTime = z.iso.datetime({ offset: true, message: "Must be an ISO-8601 date-time." }).openapi({ example: "2026-10-01T12:00:00Z" });

/**
 * A comma-separated list of ids in the query string (`?productIds=a,b,c`), for the
 * ported functions that took a uuid[] argument. Empty items are ignored.
 */
export function idList(description: string, max = 500) {
  return z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(id).max(max))
    .openapi({ description: `${description} Comma-separated, up to ${max}.`, example: "6f1c2a0e-8a4b-4c1e-9d2f-3b5a7c9e1f20" });
}

/** Path parameter objects used across the ported endpoints. */
export const ProductParams = z.object({ productId: idParam });
export const PackageParams = z.object({ packageId: idParam });
export const VendorIdParams = z.object({ vendorId: idParam });
export const OrderParams = z.object({ orderId: idParam });
export const UserParams = z.object({ userId: idParam });
export const ConversationParams = z.object({ conversationId: idParam });

/** Result of an endpoint that replaces a function returning nothing (void). */
export const DoneSchema = z.object({ done: z.literal(true) }).openapi("Done");
