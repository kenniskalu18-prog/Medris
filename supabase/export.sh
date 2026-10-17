#!/usr/bin/env bash
# =============================================================================
# LEVROMART · export the live database's structure into readable SQL files.
#
# Usage (from the repository root, Git Bash on Windows works):
#   ./supabase/export.sh                 # live project; asks for the database password (not shown)
#   DB_URL="postgresql://<user>@<host>:5432/postgres" ./supabase/export.sh   # another database
#
# - Structure only: no table rows, no user data, no passwords. Every query runs in a
#   read-only transaction, so the script cannot change the database.
# - Use the session pooler (port 5432) or the direct connection, not the transaction
#   pooler (port 6543), which pg_dump does not support.
# - Needs the PostgreSQL 17 client tools (pg_dump, psql): pg_dump refuses a server newer
#   than itself.
# - Output goes to supabase/export/ (git-ignored). Three functions embed the webhook
#   secret used to call /api/notify (notify_email_on_notification, ring_callee_again,
#   send_background_reminders). The script finds it in the export and replaces it with
#   <WEBHOOK_SECRET>, so it does not need to be known (EMAIL_WEBHOOK_SECRET, if set, is
#   removed as well). Common key formats (JWTs, Paystack, Google, Resend) are removed too.
#   Still read the files before committing any of them: the repository is public.
#
# Files:
#   00_full_schema.sql               public schema: tables, types, functions, triggers, policies,
#                                    indexes and GRANT/REVOKE (which role may use what)
#   30_functions.sql                 every public function, one definition each
#   40_cron_jobs.sql                 pg_cron jobs
#   50_storage.sql                   Storage buckets and their access policies
#   60_auth_triggers.sql             triggers on auth.* tables (e.g. profile creation on sign-up)
#   70_realtime.sql                  tables streamed by Realtime, and Realtime access policies
#   80_extensions.sql                installed extensions and versions
# =============================================================================
set -Eeuo pipefail

# Default: the live project (ovklnoroyxobijgvsyfp) through Supabase's session pooler.
DB_URL="${DB_URL:-postgresql://postgres.ovklnoroyxobijgvsyfp@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require}"
case "$DB_URL" in
  *:6543/*) echo "Port 6543 is the transaction pooler, which pg_dump cannot use. Use port 5432." >&2; exit 1 ;;
esac

# PostgreSQL client tools installed on Windows are not on Git Bash's PATH by default.
if ! command -v pg_dump > /dev/null 2>&1; then
  for bin in "/c/Program Files/PostgreSQL"/*/bin; do [ -x "$bin/pg_dump.exe" ] && PATH="$bin:$PATH"; done
  command -v pg_dump > /dev/null 2>&1 || { echo "pg_dump not found: install the PostgreSQL 17 command-line tools." >&2; exit 1; }
fi

# No password in the URL: ask for it once, without echoing it (it never reaches the
# shell history or the output files).
if [ -z "${PGPASSWORD:-}" ] && printf '%s' "$DB_URL" | grep -qE '^postgres(ql)?://[^:/@]+@'; then
  read -rsp "Database password: " PGPASSWORD; echo
  export PGPASSWORD
fi

OUT="${EXPORT_DIR:-$(dirname "$0")/export}"
mkdir -p "$OUT"
# Stays in the folder unless the export and the secret removal below both finish.
MARKER="$OUT/CHECK_BEFORE_SHARING.txt"
echo "This export did not finish cleanly or may contain secrets. Do not share or commit it." > "$MARKER"

# Every message (errors included) also goes to export.log, and a failure names its step.
# Nothing secret is logged: the password is only ever in PGPASSWORD.
LOG="$OUT/export.log"
: > "$LOG"
exec 2> >(tee -a "$LOG" >&2)
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# Read-only for every connection this script opens (psql and pg_dump); a search path
# without public makes the generated definitions name their schema (public.handle_new_user()).
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=300000 -c search_path=pg_catalog"

# tr: native Windows psql ends lines with CR LF, which would break the comparisons below.
q() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -At -c "$1" | tr -d '\r'; }
exists() { [ "$(q "select to_regclass('$1') is not null")" = "t" ]; }

server_version=$(q "show server_version_num")   # stops here if the database cannot be reached
server_major=$(( server_version / 10000 ))
client_major=$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
echo "Connected. Server: PostgreSQL $server_version; client: $(pg_dump --version | tr -d '\r')" >&2
if [ "$client_major" -lt "$server_major" ]; then
  echo "pg_dump $client_major is older than the server (PostgreSQL $server_major). Install the PostgreSQL $server_major client tools." >&2
  exit 1
fi

# One dump of the whole public schema (it takes a few minutes through the pooler).
echo "Exporting the schema (this can take several minutes)..." >&2
pg_dump "$DB_URL" --schema-only --schema=public --no-owner > "$OUT/00_full_schema.sql"
echo "Exporting functions, jobs, storage, auth triggers, realtime and extensions..." >&2

q "select pg_get_functiondef(p.oid)||';'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by p.proname, pg_get_function_identity_arguments(p.oid)" > "$OUT/30_functions.sql"

if exists cron.job; then
  q "select 'select cron.schedule('||quote_literal(jobname)||', '||quote_literal(schedule)||', '||quote_literal(command)||');'
       from cron.job order by jobname" > "$OUT/40_cron_jobs.sql"
else
  echo "-- pg_cron is not installed on this database" > "$OUT/40_cron_jobs.sql"
fi

# Policies are rendered as CREATE POLICY statements from pg_policies.
policies_in() {
  q "select format('create policy %I on %I.%I as %s for %s to %s%s%s;',
                   policyname, schemaname, tablename, permissive, cmd,
                   (select string_agg(quote_ident(r), ', ') from unnest(roles) r),
                   case when qual is not null then ' using ('||qual||')' else '' end,
                   case when with_check is not null then ' with check ('||with_check||')' else '' end)
       from pg_policies where schemaname = '$1' order by tablename, policyname"
}

{
  echo "-- Storage buckets (settings only; no files) and the policies that decide who may read/write them."
  if exists storage.buckets; then
    q "select format('insert into storage.buckets select * from jsonb_populate_record(null::storage.buckets, %L) on conflict (id) do nothing;',
                     to_jsonb(b) - 'owner' - 'owner_id')
         from storage.buckets b order by b.id"
    policies_in storage
  else
    echo "-- no storage schema on this database"
  fi
} > "$OUT/50_storage.sql"

{
  echo "-- Triggers on Supabase Auth tables. The functions they call are in 30_functions.sql."
  q "select pg_get_triggerdef(t.oid)||';'
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'auth' and not t.tgisinternal
      order by c.relname, t.tgname"
} > "$OUT/60_auth_triggers.sql"

{
  echo "-- Tables whose changes Realtime streams to the browser (postgres_changes)."
  q "select format('alter publication %I add table %I.%I;', pubname, schemaname, tablename)
       from pg_publication_tables where pubname = 'supabase_realtime' order by schemaname, tablename"
  echo "-- Realtime access policies (broadcast / presence channels)."
  policies_in realtime
} > "$OUT/70_realtime.sql"

q "select format('create extension if not exists %I with schema %I; -- version %s', e.extname, n.nspname, e.extversion)
     from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by e.extname" > "$OUT/80_extensions.sql"

# ---- Remove secrets ------------------------------------------------------------------
# The functions that call /api/notify carry the webhook secret as text, in the header
# x-webhook-secret. Find every such value (no need to know it in advance), plus the value
# of EMAIL_WEBHOOK_SECRET if given, and replace it everywhere. Values are never printed.
secrets=$(perl -0777 -ne '
  my $v = q{([^\x27"\s(),]{6,})};
  print "$1\n" while /\x27{1,2}x-webhook-secret\x27{1,2}\s*,\s*\x27{1,2}$v\x27/gi;   # jsonb_build_object(... x-webhook-secret, <value>)
  print "$1\n" while /"x-webhook-secret"\s*:\s*"$v"/gi;                       # JSON text {"x-webhook-secret": "<value>"}
  print "$1\n" while /x-webhook-secret:\s*$v/gi;                               # header text x-webhook-secret: <value>
  print "$1\n" while /\b[a-z_]*secret\s+(?:text|varchar|character varying)\s*:=\s*\x27$v\x27/gi;   # declare v_secret text := <value>
' "$OUT"/*.sql | sort -u)
if [ -n "${EMAIL_WEBHOOK_SECRET:-}" ]; then
  secrets=$(printf '%s\n%s\n' "$secrets" "$EMAIL_WEBHOOK_SECRET" | sed '/^$/d' | sort -u)
fi
found=0
while IFS= read -r secret; do
  [ -z "$secret" ] && continue
  found=$((found + 1))
  for f in "$OUT"/*.sql; do
    SECRET="$secret" perl -pi -e 's/\Q$ENV{SECRET}\E/<WEBHOOK_SECRET>/g' "$f"
  done
  if grep -rqF -- "$secret" "$OUT"; then
    echo "A secret could not be removed from $OUT - do not share these files." >&2
    exit 1
  fi
done <<< "$secrets"

# Well-known key formats, in case any other key was pasted into a function or job.
keys=$(perl -0777 -ne '
  $n += () = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|\bsk_(?:live|test)_\w{10,}|\bAIza[\w-]{30,}|\bre_\w{20,}/g;
  END { print $n + 0 }' "$OUT"/*.sql)
for f in "$OUT"/*.sql; do
  perl -pi -e 's/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/<JWT>/g; s/\bsk_(?:live|test)_\w{10,}/<PAYSTACK_KEY>/g;
                s/\bAIza[\w-]{30,}/<GOOGLE_KEY>/g; s/\bre_\w{20,}/<RESEND_KEY>/g' "$f"
done

echo "Secrets removed: $found webhook secret value(s), $keys other key occurrence(s)."
if [ "$found" -eq 0 ] && grep -qiE 'x-webhook-secret|net\.http_post' "$OUT/30_functions.sql"; then
  echo "WARNING: functions call webhooks but no secret value was recognised. Open 30_functions.sql and" >&2
  echo "         check notify_email_on_notification before sharing or committing anything from $OUT." >&2
else
  rm -f "$MARKER"
fi

echo "Done -> $OUT"
ls -l "$OUT"
