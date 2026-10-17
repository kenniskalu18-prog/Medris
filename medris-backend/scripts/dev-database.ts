/**
 * Prepares a LOCAL PostgreSQL database for development:
 *
 *   npm run db:dev -w medris-backend                 # schema only
 *   npm run db:dev -w medris-backend -- --seed       # plus a few demo rows
 *
 * Uses DATABASE_URL from medris-backend/.env. Refuses to run unless the
 * database host is local (localhost, 127.0.0.1, ::1 or the docker-compose
 * service "db"), so it can never touch Supabase or any other remote database.
 *
 * The schema is the one the tests use: the exported production structure
 * (src/database/baseline - every table, function, trigger, grant and policy, on a
 * local stand-in for the Supabase platform), followed by every migration through
 * the migration runner (recorded in medris_migrations.applied; `npm run db:status`
 * shows them). No production data is ever copied.
 */
import pg from "pg";
import { baselineSql } from "./baseline.js";
import { applyMigrations, readMigrations } from "./migrations.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* rely on the shell environment */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see medris-backend/.env.example and docker-compose.yml).");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]", "db"].includes(host)) {
  console.error(`Refusing to load the development schema into a non-local database (${host}).`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const existing = await client.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
if (existing.rows[0].n > 0) {
  console.error("This database already has tables in public; drop and re-create it first (docker compose down -v).");
  await client.end();
  process.exit(1);
}
// The platform stand-in creates the (server-wide) roles only if they do not exist yet.
for (const chunk of baselineSql()) await client.query(chunk);
// Migrations go through the runner, so this database records them like production does.
const { applied } = await applyMigrations(
  { query: async (text, params) => ({ rows: (await client.query(text, params)).rows }), exec: (text) => client.query(text) },
  readMigrations().files,
);
console.log(`Applied ${applied.length} migrations.`);

if (process.argv.includes("--seed")) {
  const buyer = "00000000-0000-4000-8000-00000000b001";
  const owner = "00000000-0000-4000-8000-00000000a001";
  const sector = "00000000-0000-4000-8000-00000000e001";
  const vendor = "00000000-0000-4000-8000-00000000c001";
  // As in production: the sign-up triggers create each profile from the auth user.
  const people: [string, string, string][] = [
    [buyer, "buyer@dev.local", "08030000001"],
    [owner, "vendor@dev.local", "08030000002"],
  ];
  for (const [id, email, phone] of people) {
    await client.query("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3)", [
      id,
      email,
      JSON.stringify({ name: email.split("@")[0], phone }),
    ]);
  }
  await client.query("insert into public.sectors (id, slug, name, sort_order) values ($1, 'electronics', 'Electronics', 1)", [sector]);
  // A verified vendor needs WhatsApp and payout details (trg_enforce_vendor_onboarding_requirements);
  // verifying it makes its owner a vendor (trg_sync_user_role_from_vendor).
  await client.query(
    `insert into public.vendors (id, user_id, business_name, sector_id, verification_status, is_active, whatsapp_number, bank_name, bank_code, account_number)
     values ($1, $2, 'Dev Shop', $3, 'verified', true, '08030000002', 'Test Bank', '058', '0123456789')`,
    [vendor, owner, sector],
  );
  await client.query("insert into public.products (vendor_id, name, listing_type, sale_price, status) values ($1, 'Rechargeable lamp', 'sale', 8000, 'active')", [vendor]);
  console.log(`Seeded demo rows (buyer ${buyer}, vendor owner ${owner}).`);
}
await client.end();
console.log("Local development schema ready.");
