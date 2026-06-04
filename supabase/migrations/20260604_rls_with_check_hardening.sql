-- ============================================================================
-- Add WITH CHECK to org-scoped RLS policies that only had USING
-- ============================================================================
-- A permissive RLS policy with USING but no WITH CHECK governs which rows are
-- VISIBLE (read/delete) but does NOT constrain the values of INSERTed/UPDATEd
-- rows. So an authenticated user could write a row with organization_id set to a
-- DIFFERENT org (cross-tenant plant), and on the analytics tables could insert
-- fabricated technique/rating rows to game the agent-performance KPIs that feed
-- pay-relevant reviews. The app writes most of these via the service role today,
-- but the policy itself must be the backstop.
--
-- ALTER POLICY ... WITH CHECK adds the row-value constraint without dropping.
-- ============================================================================

-- Connector config / events (022)
alter policy connector_configs_org_policy on public.connector_configs
  with check (organization_id = public.get_user_org_id());
alter policy connector_events_org_policy on public.connector_events
  with check (organization_id = public.get_user_org_id());

-- OAuth states (035)
alter policy oauth_states_org_policy on public.oauth_states
  with check (organization_id = public.get_user_org_id());

-- AI conversation ratings (010) — gaming vector for avg_call_rating
alter policy "ai_ratings_org_isolation" on public.ai_conversation_ratings
  with check (organization_id = public.get_user_org_id());

-- Sales technique tracking + assessments + summaries (011) — KPI source tables
alter policy "mtt_org_access" on public.message_technique_tracking
  with check (organization_id = public.get_user_org_id());
alter policy "lea_org_access" on public.lead_engagement_assessments
  with check (organization_id = public.get_user_org_id());
alter policy "cts_org_access" on public.conversation_technique_summaries
  with check (organization_id = public.get_user_org_id());
