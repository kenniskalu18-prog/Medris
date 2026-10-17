import { z } from "../openapi/zod.js";

/**
 * Request validation with Zod. Controllers declare their schemas on the route
 * (see shared/openapi); failures become 400 `validation_failed` responses with
 * a list of { path, message } entries, never a stack trace.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "(body)", message: issue.message }));
}

/**
 * Database ids. Supabase generates v4 UUIDs, but older rows and seed data use
 * other variants, so any 8-4-4-4-12 hex id is accepted (Postgres validates it).
 */
export const id = z.guid({ message: "Must be a valid id." });

export const pageLimit = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
