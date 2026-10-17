import { AppError } from "../shared/errors/app-error.js";

/**
 * Maps PostgreSQL errors (SQLSTATE codes) to API errors.
 *
 * The database's SECURITY DEFINER functions report business-rule failures with
 * `raise exception '<message>'`, usually with SQLSTATE P0001, 22023 (invalid
 * input, "You cannot follow your own shop."), 42501 (not allowed, "Only admins
 * can ...") or P0002 (not found). Supabase passed those messages straight to the
 * browser, which shows them in a toast, so they are kept: any error raised by a
 * RAISE statement (PostgreSQL reports "... at RAISE" in the error's context) keeps
 * its message, with the status its code implies. Errors from PostgreSQL itself
 * (a policy refusing a row, a malformed uuid...) get a generic, safe message.
 */

export interface PgErrorLike {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
  /** Context, e.g. "PL/pgSQL function f() line 3 at RAISE". */
  where?: string;
}

/** Drizzle wraps driver errors (DrizzleQueryError.cause); walk the cause chain to the PostgreSQL error. */
export function findPgError(err: unknown): PgErrorLike | null {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current === "object" && current !== null) {
      const candidate = current as Partial<PgErrorLike> & { cause?: unknown };
      if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code) && typeof candidate.message === "string") {
        return candidate as PgErrorLike;
      }
      current = candidate.cause;
    } else {
      break;
    }
  }
  return null;
}

export function mapDatabaseError(err: unknown): AppError | null {
  const pg = findPgError(err);
  if (!pg) return null;
  const { code } = pg;
  const cause = { cause: err };

  // raise_exception and other PL/pgSQL errors raised on purpose by the database functions.
  if (code.startsWith("P0")) return new AppError(400, "bad_request", pg.message, undefined, cause);
  // The first context line is where the error started (later lines are the callers).
  if ((pg.where ?? "").split("\n")[0]!.endsWith(" at RAISE")) {
    if (code === "42501") return new AppError(403, "forbidden", pg.message, undefined, cause);
    if (code === "40001" || code === "40P01") return new AppError(409, "conflict", pg.message, undefined, cause);
    if (code.startsWith("22") || code.startsWith("23")) return new AppError(400, "bad_request", pg.message, undefined, cause);
  }
  if (code === "42501") return new AppError(403, "forbidden", "You are not allowed to do that.", undefined, cause);
  if (code === "23505") return new AppError(409, "conflict", "That already exists.", undefined, cause);
  if (code === "23503") return new AppError(409, "conflict", "A related record is missing or still in use.", undefined, cause);
  if (code === "23502" || code === "23514" || code.startsWith("22")) {
    return new AppError(400, "bad_request", "Some of the values sent are not valid.", undefined, cause);
  }
  if (code === "57014") return new AppError(504, "request_timeout", "The request took too long. Please try again.", undefined, cause);
  if (code === "40001" || code === "40P01") return new AppError(409, "conflict", "Please try again.", undefined, cause);
  if (code.startsWith("08") || code === "53300" || code === "57P01" || code === "57P03" || code.startsWith("28")) {
    return new AppError(503, "service_unavailable", "The database is temporarily unavailable. Please try again.", undefined, cause);
  }
  return null;
}
