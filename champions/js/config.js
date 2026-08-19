// Mobihealth Campus Champions — Supabase client configuration.
//
// The URL and anon/publishable key below are PUBLIC by design (this is how every
// Supabase client-side app is configured) — real protection comes from the Row
// Level Security policies in /supabase/champions_schema.sql, not from hiding
// these values. Never put the service_role key here or anywhere in this folder.
window.MOBIHEALTH_SUPABASE_URL = "https://ovklnoroyxobijgvsyfp.supabase.co";
window.MOBIHEALTH_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92a2xub3JveXhvYmlqZ3ZzeWZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MzgzNDcsImV4cCI6MjEwMTExNDM0N30.rosKY0iNbOnAHHXF-vVSxjIs82wNQzrQcMyAUfGgIrM";

window.mobihealthSupabase = window.supabase.createClient(
  window.MOBIHEALTH_SUPABASE_URL,
  window.MOBIHEALTH_SUPABASE_ANON_KEY
);
