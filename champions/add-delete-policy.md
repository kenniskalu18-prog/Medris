# Add delete permission (Super Admin only)

Your database currently has no delete permission at all for applications
(by design, for safety). To allow you — and only you, as Super Admin — to
delete applications from the dashboard, paste this into your Supabase
project's **SQL Editor → New query** and click **Run**:

```sql
drop policy if exists champion_applications_delete on public.champion_applications;
create policy champion_applications_delete on public.champion_applications
  for delete to authenticated
  using (public.champion_is_super_admin());
```

This makes the database itself refuse any delete request that isn't from
your Super Admin account — even if someone tried to call the API directly,
not just through the dashboard buttons.
