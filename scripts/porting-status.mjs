#!/usr/bin/env node
/**
 * Porting status: which database functions already have a backend replacement.
 *
 *   npm run porting:status            # prints the summary, rewrites docs/PORTING.md
 *   npm run porting:status -- --check # also fails if docs/PORTING.md is out of date
 *
 * Sources (no database needed):
 * - every function in the production baseline (medris-backend/src/database/baseline/01-public-schema.sql);
 * - which of them the browser calls (sb.rpc in medris-frontend/src/legacy), which pg_cron runs,
 *   which triggers run, and which only other functions call;
 * - backend methods marked with a comment `Replaces: public.<name>(...)` in medris-backend/src;
 * - parity tests: `runOriginal(db, ..., "<name>"` (or `runOriginalAsService(db, "<name>"` for helpers) in medris-backend/tests,
 *   or, where a test loops over several functions by name, a comment `// parity-tested: name1, name2`.
 *
 * A function counts as ported when it has a replacement AND a parity test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function walk(dir, exts) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && exts.includes(path.extname(e.name)))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/* ---------------------------------------------------- functions in the baseline */

const schema = read("medris-backend/src/database/baseline/01-public-schema.sql");
const functions = new Map(); // name -> { body, returnsTrigger }
for (const m of schema.matchAll(/^CREATE FUNCTION public\.([a-z_0-9]+)\((.*?)\) RETURNS ([^\n]+)\n([\s\S]*?)(?=^CREATE |^ALTER |^COMMENT |^-- Name:)/gm)) {
  const [, name, , returns, body] = m;
  const entry = functions.get(name) ?? { body: "", returnsTrigger: false, overloads: 0 };
  entry.body += body;
  entry.returnsTrigger ||= /^trigger\b/.test(returns.trim());
  entry.overloads += 1;
  functions.set(name, entry);
}

const cron = read("medris-backend/src/database/baseline/05-cron-jobs.sql");
const cronFns = new Set([...cron.matchAll(/public\.([a-z_0-9]+)\(/g)].map((m) => m[1]));
const triggerFns = new Set([...schema.matchAll(/EXECUTE FUNCTION public\.([a-z_0-9]+)\(/g)].map((m) => m[1]));
for (const m of read("medris-backend/src/database/baseline/03-auth-triggers.sql").matchAll(/EXECUTE FUNCTION public\.([a-z_0-9]+)\(/g)) triggerFns.add(m[1]);

/* ------------------------------------------------------------- browser calls */

// The app: sb.rpc() in the legacy frontend and the data gateway, the Vercel functions' REST calls
// (/rest/v1/rpc/<name>) and the backend's own callFunction(db, "<name>") (a port still delegating).
const browser = new Map(); // name -> call count
const count1 = (name) => browser.set(name, (browser.get(name) ?? 0) + 1);
for (const file of [...walk("medris-frontend/src/legacy", [".js", ".html"]), ...walk("medris-frontend/src/bridge", [".ts"])]) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/\.rpc\(\s*['"`]([a-z_0-9]+)['"`]/g)) count1(m[1]);
}
for (const file of walk("api", [".js"])) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/rest\/v1\/rpc\/([a-z_0-9]+)/g)) count1(m[1]);
}
for (const file of walk("medris-backend/src", [".ts"])) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/callFunction\([^"]*"([a-z_0-9]+)"/g)) count1(m[1]);
}

/* ------------------------------------------- which functions call which others */

const calledBy = new Map();
for (const [name, { body }] of functions) {
  for (const other of functions.keys()) {
    if (other !== name && new RegExp(`\\b${other}\\s*\\(`).test(body)) {
      if (!calledBy.has(other)) calledBy.set(other, new Set());
      calledBy.get(other).add(name);
    }
  }
}

/* ------------------------------------------------- backend replacements, tests */

const replaced = new Map(); // name -> file
for (const file of walk("medris-backend/src", [".ts"])) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/Replaces:\s*((?:public\.[a-z_0-9]+\([^)]*\)[,\s]*)+)/g)) {
    for (const f of m[1].matchAll(/public\.([a-z_0-9]+)\(/g)) replaced.set(f[1], path.relative(root, file).split(path.sep).join("/"));
  }
}
const parity = new Set();
for (const file of walk("medris-backend/tests", [".ts"])) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/runOriginal(?:AsService)?\([^"]*"([a-z_0-9]+)"/g)) parity.add(m[1]);
  for (const m of text.matchAll(/\/\/ parity-tested: ([a-z_0-9, ]+)/g)) for (const name of m[1].split(",")) parity.add(name.trim());
}

/* ------------------------------------------------------------------- report */

// Functions used inside row-level-security policies (they stay while the policies do).
const policySql = [...schema.matchAll(/^CREATE POLICY [\s\S]*?;$/gm)].map((m) => m[0]).join("\n") + read("medris-backend/src/database/baseline/02-storage.sql");
const policyFns = new Set([...functions.keys()].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(policySql)));

function kind(name) {
  if (browser.has(name)) return "app";
  if (cronFns.has(name)) return "job";
  if (triggerFns.has(name) || functions.get(name)?.returnsTrigger) return "trigger";
  if (calledBy.has(name)) return "helper";
  if (policyFns.has(name)) return "policy";
  return "unused";
}

/**
 * Functions nothing calls that are deliberately not ported: they stay in the database until the
 * clean-up after the switch, when they can be dropped (each by a reviewed migration).
 */
/**
 * Triggers stay in PostgreSQL: they are rules on the data itself, so they run for the backend's writes exactly as
 * for the browser's (no parity gap to close), and they move with the database to any PostgreSQL host. The few that
 * depend on a Supabase service say so.
 */
const STAYS = {
  handle_new_user: "runs when Supabase Auth creates an account (Auth stays with Supabase; the backend signs up through it)",
  handle_new_levromart_user: "runs when Supabase Auth creates an account (Auth stays with Supabase)",
  trg_apply_signup_referral: "runs when Supabase Auth creates an account (Auth stays with Supabase)",
  log_auth_session_start: "runs when Supabase Auth starts a session (Auth stays with Supabase)",
  notify_email_on_notification: "sends email/push for each new notification through pg_net (Supabase's database); becomes an outbox only if the database leaves Supabase",
};

const NOT_PORTING = {
  accept_request_offer: "nothing calls it (the requests screens have no accept step)",
  admin_approve_vendor: "superseded by admin_set_vendor_status",
  admin_toggle_vendor_storefront_active: "superseded by admin_set_vendor_storefront_active",
  admin_trash_vendor: "superseded by admin_delete_vendor",
  admin_unlink_all_identities: "service role only; nothing calls it",
  am_i_blocked_with: "nothing calls it (its check is AccessRepository.isBlockedBetween)",
  chat_purge_candidates: "returns nothing (a stub)",
  compute_delivery_fee: "superseded by compute_product_delivery_fee",
  edit_buyer_order: "superseded by edit_pending_order",
  get_favorite_count: "superseded by get_favorite_counts",
  get_order_vendor_payment_details: "nothing calls it",
  get_vendor_payment_details: "nothing calls it; exposes bank details to visitors (BASELINE_FINDINGS S3) - drop",
  nearby_vendors: "nothing calls it",
  notify_product_variety_batch: "nothing calls it (varieties notify through their trigger)",
  notify_vendor_application_submitted: "superseded by submit_vendor_application (which notifies itself)",
  process_payment_unresolved_escalations: "superseded by the job escalate_unresolved_payment_orders; open to visitors (S3) - drop",
  record_social_click: "a stub since social points are awarded by hand",
  rls_auto_enable: "a database event trigger (enables RLS on new tables); it belongs in the database",
  search_products_full: "superseded by search_products_full_v2",
  set_order_buyer_note: "superseded by add_order_note",
  set_order_item_variant: "nothing calls it",
};

const rows = [...functions.keys()].sort().map((name) => {
  const k = kind(name);
  const status =
    replaced.has(name) && parity.has(name)
      ? "ported"
      : replaced.has(name)
        ? "ported, no parity test"
        : k === "unused" && NOT_PORTING[name]
          ? `not porting: ${NOT_PORTING[name]}`
          : k === "trigger"
            ? `not porting: stays in the database - ${STAYS[name] ?? "a database rule; it runs for every write, the backend's included"}`
            : "to do";
  return { name, kind: k, calls: browser.get(name) ?? 0, status, where: replaced.get(name) ?? "" };
});

const order = ["app", "job", "helper", "trigger", "policy", "unused"];
const titles = {
  app: "Called by the app (browser, data gateway, Vercel functions)",
  job: "Scheduled jobs (pg_cron)",
  helper: "Helpers (called only by other functions)",
  trigger: "Trigger functions (stay in the database)",
  policy: "Used only by row-level-security policies",
  unused: "Not called by the app, a job, a trigger or another function",
};
const count = (k, s) => rows.filter((r) => r.kind === k && (!s || r.status === s || (s === "not porting" && r.status.startsWith(s)))).length;

let md = `# Porting status\n\nGenerated by \`npm run porting:status\` - do not edit by hand. A database function counts as **ported** when a\nbackend method is marked \`Replaces: public.<name>(...)\` and a parity test (\`tests/parity/\`) compares the two on the real\nschema.\n\n| Group | Ported | Not porting | Total |\n|---|---:|---:|---:|\n`;
for (const k of order) md += `| ${titles[k]} | ${count(k, "ported")} | ${count(k, "not porting")} | ${count(k)} |\n`;
for (const k of order) {
  md += `\n## ${titles[k]}\n\n| Function | ${k === "app" ? "Calls in the app | " : ""}Status | Backend |\n|---|${k === "app" ? "---:|" : ""}---|---|\n`;
  for (const r of rows.filter((x) => x.kind === k)) md += `| \`${r.name}\` | ${k === "app" ? `${r.calls} | ` : ""}${r.status} | ${r.where ? `\`${r.where}\`` : ""} |\n`;
}

const out = path.join(root, "docs", "PORTING.md");
const previous = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
if (process.argv.includes("--check")) {
  if (previous !== md) {
    console.error("docs/PORTING.md is out of date: run `npm run porting:status` and commit the result.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(out, md);
}
for (const k of order) {
  const skipped = count(k, "not porting");
  console.log(`${titles[k].padEnd(70)} ${String(count(k, "ported")).padStart(4)} / ${count(k)}${skipped ? `  (${skipped} not porting)` : ""}`);
}
