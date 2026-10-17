-- =============================================================================
-- 0003  medris_api may read auth.users.last_sign_in_at                NOT YET APPLIED
-- =============================================================================
-- Status: written for review. Do not run against production without approval.
-- Effect: one column-level read grant. Changes no table, row, policy or function.
--
-- The chat header shows when the other person was last active
-- (get_conversation_presence(): latest of last seen, last message, last sign-in).
-- The backend's port (GET /api/v1/conversations/{id}/presence) reads the
-- sign-in time with the same restricted auth reader as 0001, which only has the
-- columns granted there.
--
-- Skipped when the role from 0001 does not exist yet.
-- Roll back: revoke select (last_sign_in_at) on auth.users from medris_api;
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'medris_api') then
    grant select (last_sign_in_at) on auth.users to medris_api;
  end if;
end $$;
