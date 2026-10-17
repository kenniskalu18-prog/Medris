/**
 * Refreshes src/database/baseline/ from a fresh export of production:
 *
 *   ./supabase/export.sh                                   # writes supabase/export/ (git-ignored)
 *   npm run db:baseline:update -w medris-backend           # copies it into the baseline
 *
 * The baseline is the real structure every local, test and CI database is built
 * from, so this is how the code learns about a change made in production outside
 * the migration process. Review the diff it produces like any other change.
 *
 * Refuses to copy anything that may contain a secret: the export must have
 * finished cleanly (no CHECK_BEFORE_SHARING.txt) and no known key format may
 * remain. Normalises line endings (pg_dump on Windows writes CRLF) and makes
 * `CREATE SCHEMA public` re-runnable; nothing else is changed.
 */
import fs from "node:fs";
import path from "node:path";
import { BASELINE_DIR } from "./baseline.js";

const exportDir = path.resolve(BASELINE_DIR, "..", "..", "..", "..", "supabase", "export");

/** Export file -> baseline file. The full schema is the dump with grants. */
const FILES: [string[], string][] = [
  [["25_full_schema_with_grants.sql", "00_full_schema.sql"], "01-public-schema.sql"],
  [["50_storage.sql"], "02-storage.sql"],
  [["60_auth_triggers.sql"], "03-auth-triggers.sql"],
  [["70_realtime.sql"], "04-realtime.sql"],
  [["40_cron_jobs.sql"], "05-cron-jobs.sql"],
];

/** The same key formats export.sh removes; any left over stops the copy. */
const SECRET_PATTERNS = [
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  /\bsk_(?:live|test)_\w{10,}/,
  /\bAIza[\w-]{30,}/,
  /\bre_\w{20,}/,
  /x-webhook-secret['"]?\s*[,:]\s*['"]?(?!<WEBHOOK_SECRET>)[^'"\s(),]{6,}/i,
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(exportDir)) fail(`No export found at ${exportDir}. Run ./supabase/export.sh first.`);
if (fs.existsSync(path.join(exportDir, "CHECK_BEFORE_SHARING.txt"))) {
  fail("The export did not finish cleanly or may contain a secret (CHECK_BEFORE_SHARING.txt). Run ./supabase/export.sh again.");
}

const outputs: [string, string][] = [];
for (const [candidates, target] of FILES) {
  const source = candidates.map((name) => path.join(exportDir, name)).find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
  if (!source) fail(`Missing or empty in the export: ${candidates.join(" or ")}.`);
  let text = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n");
  if (target === "01-public-schema.sql") {
    if (!/^GRANT /m.test(text)) fail(`${path.basename(source)} has no GRANT statements: export it with permissions (export.sh does).`);
    text = text.replace(/^CREATE SCHEMA public;$/m, "CREATE SCHEMA IF NOT EXISTS public;");
  }
  const leak = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  if (leak) fail(`${path.basename(source)} still contains something that looks like a secret (${leak}). Not copying anything.`);
  outputs.push([target, text]);
}

for (const [target, text] of outputs) {
  const file = path.join(BASELINE_DIR, target);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  fs.writeFileSync(file, text);
  console.log(`${before === text ? "unchanged" : before === null ? "created  " : "updated  "}  src/database/baseline/${target}`);
}
console.log("\nReview the changes with `git diff -- medris-backend/src/database/baseline`, then run `npm test`.");
