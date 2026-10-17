import type { Response } from "express";
import { json, publicErrorMessage } from "../lib/http.js";
import type { LegacyResult } from "./types/service.js";

export type { LegacyResult };

/**
 * Helper for the controllers of the original endpoints (/api/notify,
 * /api/chat, ...). They answer exactly as the original Vercel functions did:
 * the service's status and body, or `{ "error": "<message>" }` with 500 when
 * something unexpected fails.
 */

export interface LegacyErrorOptions {
  /** Body message when the error has none (or when `hideMessage` is set). */
  fallback?: string;
  /** Never send the error's own message (Levi). */
  hideMessage?: boolean;
  /** Log prefix for console.error, as the original functions logged. */
  log?: string;
}

export async function respond(res: Response, work: () => Promise<LegacyResult>, options: LegacyErrorOptions = {}): Promise<void> {
  try {
    const result = await work();
    if ("redirect" in result) res.redirect(302, result.redirect);
    else json(res, result.status, result.body);
  } catch (err) {
    if (options.log) console.error(options.log, err);
    const fallback = options.fallback ?? "Server error";
    json(res, 500, { error: options.hideMessage ? fallback : publicErrorMessage(err) || fallback });
  }
}
