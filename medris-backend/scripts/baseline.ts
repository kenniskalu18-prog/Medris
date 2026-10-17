import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The live database's structure, as exported by `supabase/export.sh` and kept in
 * `src/database/baseline/` (see its README). Local, test and CI databases are
 * built from it, then every migration in `src/database/migrations/` is applied on
 * top - the same order production went through.
 */
export const BASELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "database", "baseline");

/**
 * The baseline files in load order, one SQL string each.
 *
 * pg_dump output changes session settings for the rest of the connection
 * (an empty search_path, row_security off, check_function_bodies off...). Each
 * chunk therefore ends with RESET ALL, inside the same string, so a pooled
 * connection that ran it behaves normally afterwards.
 */
export function baselineSql(): string[] {
  return fs
    .readdirSync(BASELINE_DIR)
    .filter((f) => /^\d{2}-.*\.sql$/.test(f))
    .sort()
    .map((f) => `${fs.readFileSync(path.join(BASELINE_DIR, f), "utf8")}\nRESET ALL;\n`);
}
