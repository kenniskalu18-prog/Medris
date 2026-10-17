import type { Request, Response } from "express";
import { readBodyText } from "../shared/http/body.js";

/**
 * Reads the request body as JSON the same way the original Vercel functions
 * did: an empty body counts as `{}`, and malformed JSON throws (which the
 * controller turns into a 500 with the parser's message, as before).
 */
export async function readJsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  const raw = await readBodyText(req);
  return JSON.parse(raw || "{}") as T;
}

export function json(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function methodNotAllowed(res: Response, message = "Method not allowed"): void {
  json(res, 405, { error: message });
}

/** Origin of the incoming request, falling back to its host (as the original code did). */
export function requestOrigin(req: Request): string {
  return req.get("origin") || `https://${req.get("host") ?? ""}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/**
 * The message an error response may show. A failed query is reported by its
 * PostgreSQL message only (as Supabase's REST API did): the query layer wraps it
 * as "Failed query: <sql> params: <values>", and those values can be personal data.
 */
export function publicErrorMessage(err: unknown): string {
  let current: unknown = err;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code) && typeof candidate.message === "string") return candidate.message;
    current = candidate.cause;
  }
  const message = errorMessage(err);
  return message.startsWith("Failed query:") ? "" : message;
}
