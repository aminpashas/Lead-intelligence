-- voice_calls RLS predates the agency-active-org model: it matched
-- organization_id against the user's HOME org only, so an agency_admin who has
-- "entered" a practice saw no calls (every other timeline table already uses
-- get_user_org_id(), which resolves the entered practice). Align it.

drop policy if exists "voice_calls_org_isolation" on public.voice_calls;

create policy "voice_calls_org_isolation" on public.voice_calls
  for all
  using (organization_id = get_user_org_id())
  with check (organization_id = get_user_org_id());
