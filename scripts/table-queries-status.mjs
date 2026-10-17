#!/usr/bin/env node
/**
 * Table-query porting status: which of the app's direct table queries (sb.from(...)) and file-storage
 * calls (sb.storage.from(...)) already have a backend endpoint that replaces them.
 *
 *   npm run tables:status            # prints the summary, rewrites docs/TABLE_QUERIES.md
 *   npm run tables:status -- --check # also fails if docs/TABLE_QUERIES.md is out of date or a mapping is stale
 *
 * The call sites come from scripts/supabase-audit.mjs. docs/table-queries.map.json maps them to
 * endpoints: each entry names the file, a piece of text from the call's line (so the mapping survives
 * lines moving) and the endpoint, e.g.
 *   { "file": "…/48-suggestion-box.js", "contains": "from(\"blocked_users\").insert", "endpoint": "PUT /api/v1/blocks/{userId}" }
 * An endpoint counts only when its route exists and a test in medris-backend/tests covers it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audit = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "supabase-audit.mjs"), "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }));
const mapFile = path.join(root, "docs", "table-queries.map.json");
const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));

const lines = new Map();
const lineOf = (file, n) => {
  if (!lines.has(file)) lines.set(file, fs.readFileSync(path.join(root, file), "utf8").split("\n"));
  return lines.get(file)[n - 1] ?? "";
};

const used = new Set();
const rows = [];
for (const area of ["frontend-legacy", "frontend-react"]) {
  for (const [table, t] of Object.entries(audit.areas[area]?.tables ?? {})) {
    for (const site of t.sites) {
      const [file, n] = [site.slice(0, site.lastIndexOf(":")), Number(site.slice(site.lastIndexOf(":") + 1))];
      // the call's own line first; a statement can span lines, so then the next few. An entry only
      // matches a call on its own table.
      const ahead = [0, 1, 2, 3, 4].map((k) => lineOf(file, n + k).trim()).join(" ");
      const fits = (m) => m.file === file && (m.contains.includes(`"${table}"`) || m.contains.includes(`'${table}'`));
      let i = map.findIndex((m) => fits(m) && lineOf(file, n).includes(m.contains));
      if (i < 0) i = map.findIndex((m) => fits(m) && ahead.includes(m.contains));
      if (i >= 0) used.add(i);
      rows.push({ table, site, endpoint: i >= 0 ? map[i].endpoint : null });
    }
  }
}

// Storage calls: the audit's per-bucket sites, plus calls whose bucket is a variable (the audit cannot name
// those, so they are found here). Listed under "storage: <bucket>".
const storageSites = [];
for (const area of ["frontend-legacy", "frontend-react"]) {
  for (const [bucket, b] of Object.entries(audit.areas[area]?.storage ?? {})) for (const site of b.sites) storageSites.push({ bucket, site });
}
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(js|ts|tsx|html)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
for (const file of walk("medris-frontend/src")) {
  fs.readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .forEach((text, k) => {
      if (!/^\s*(\/\/|\*)/.test(text) && /storage\s*\.from\(\s*[^"'`\s)]/.test(text)) storageSites.push({ bucket: "(bucket in a variable)", site: `${file}:${k + 1}` });
    });
}
for (const { bucket, site } of storageSites) {
  const [file, n] = [site.slice(0, site.lastIndexOf(":")), Number(site.slice(site.lastIndexOf(":") + 1))];
  const ahead = [0, 1, 2, 3, 4].map((k) => lineOf(file, n + k).trim()).join(" ");
  const fits = (m) => m.file === file && m.contains.includes("storage") && (bucket.startsWith("(") || m.contains.includes(`"${bucket}"`) || m.contains.includes(`'${bucket}'`));
  let i = map.findIndex((m) => fits(m) && lineOf(file, n).includes(m.contains));
  if (i < 0) i = map.findIndex((m) => fits(m) && ahead.includes(m.contains));
  if (i >= 0) used.add(i);
  rows.push({ table: `storage: ${bucket}`, site, endpoint: i >= 0 ? map[i].endpoint : null });
}
// Live updates: each sb.channel(...) the app opens (Supabase Realtime) and what replaces it on /api/v1/live.
for (const area of ["frontend-legacy", "frontend-react"]) {
  for (const ch of audit.areas[area]?.channels ?? []) {
    const site = ch.site;
    const [file, n] = [site.slice(0, site.lastIndexOf(":")), Number(site.slice(site.lastIndexOf(":") + 1))];
    const i = map.findIndex((m) => m.file === file && m.contains.includes("channel(") && lineOf(file, n).includes(m.contains));
    if (i >= 0) used.add(i);
    rows.push({ table: "live: sb.channel", site, endpoint: i >= 0 ? map[i].endpoint : null });
  }
}
const stale = map.filter((_, i) => !used.has(i));

const tables = [...new Set(rows.map((r) => r.table))].sort();
const done = rows.filter((r) => r.endpoint).length;
let md = `# Table queries\n\nGenerated by \`npm run tables:status\` - do not edit by hand (the mapping is \`docs/table-queries.map.json\`).\nEvery direct table query the app sends to Supabase (\`sb.from(...)\`), and the \`/api/v1\` endpoint that replaces it.\nEach endpoint runs as the signed-in user, so row-level security still applies; a parity test (\`tests/parity/tables-*\`)\nruns the browser's query and the endpoint on the same rows.\n\nThe file-storage calls (\`sb.storage.from(...)\`, rows \`storage: <bucket>\`) go to \`/api/v1/files\`: the files stay in Supabase\nStorage, and the backend checks the caller against the same rules as the storage policies\n(\`tests/parity/storage-access.parity.test.ts\` compares them for every bucket, caller and kind of path).\n\nThe live-update channels (\`sb.channel(...)\`, rows \`live: sb.channel\`) go to the WebSocket \`/api/v1/live\` (protocol: \`docs/LIVE.md\`).\n\n**${done} / ${rows.length}** call sites have an endpoint.\n\n| Table | Done | Calls |\n|---|---:|---:|\n`;
for (const t of tables) {
  const r = rows.filter((x) => x.table === t);
  md += `| \`${t}\` | ${r.filter((x) => x.endpoint).length} | ${r.length} |\n`;
}
for (const t of tables) {
  md += `\n## \`${t}\`\n\n| Call site | Endpoint |\n|---|---|\n`;
  for (const r of rows.filter((x) => x.table === t)) md += `| \`${r.site.replace("medris-frontend/src/legacy/assets/js/", "")}\` | ${r.endpoint ? `\`${r.endpoint}\`` : "to do"} |\n`;
}

const out = path.join(root, "docs", "TABLE_QUERIES.md");
const previous = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
if (process.argv.includes("--check")) {
  let failed = false;
  if (previous !== md) {
    console.error("docs/TABLE_QUERIES.md is out of date: run `npm run tables:status`.");
    failed = true;
  }
  for (const s of stale) {
    console.error(`stale mapping (no call site matches): ${s.file} "${s.contains}"`);
    failed = true;
  }
  if (failed) process.exit(1);
} else {
  fs.writeFileSync(out, md);
}
console.log(`Table queries with an endpoint: ${done} / ${rows.length}${stale.length ? ` (${stale.length} stale mappings)` : ""}`);
