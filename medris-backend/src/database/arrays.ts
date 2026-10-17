import { sql, type SQL } from "drizzle-orm";
import { pgArrayLiteral } from "./rpc.js";

/**
 * Array parameters for raw SQL. A JavaScript array interpolated into `sql`...``
 * becomes a list of separate parameters, not one PostgreSQL array, so array
 * values are sent as one array literal and cast.
 */
export const uuidArray = (values: readonly string[]): SQL => sql`${pgArrayLiteral(values)}::uuid[]`;
export const textArray = (values: readonly string[]): SQL => sql`${pgArrayLiteral(values)}::text[]`;
