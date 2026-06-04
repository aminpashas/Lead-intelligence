-- ============================================================================
-- Fix: cross-tenant RLS bypass via unscoped "service role" policies
-- ============================================================================
-- Several tables declared a "service role full access" policy as
--   FOR ALL USING (true)
-- but omitted `TO service_role`. With no TO clause, a policy applies to the
-- `public` role (which includes every `authenticated` user). Because permissive
-- RLS policies are OR'd together, each `USING (true)` policy NULLIFIED the
-- org-scoped policies on the same table — letting any logged-in user of org A
-- read/write every other org's rows.
--
-- The service-role key bypasses RLS entirely, so these policies only ever
-- needed to exist for `service_role`. This migration re-scopes all six to
-- `TO service_role`, matching the correct pattern already used in migrations
-- 022, 035, 036, and 038.
-- ============================================================================

-- 1. patient_contracts (signed contracts, costs, signatures, executed PDFs)
drop policy if exists "service_role_manage_contracts" on public.patient_contracts;
create policy "service_role_manage_contracts"
  on public.patient_contracts for all
  to service_role
  using (true) with check (true);

-- 2. contract_events (contract audit timeline)
drop policy if exists "service_role_write_contract_events" on public.contract_events;
create policy "service_role_write_contract_events"
  on public.contract_events for all
  to service_role
  using (true) with check (true);

-- 3. contract_templates (read AND overwrite of any org's templates)
drop policy if exists "service_role_manage_contract_templates" on public.contract_templates;
create policy "service_role_manage_contract_templates"
  on public.contract_templates for all
  to service_role
  using (true) with check (true);

-- 4. treatment_closings (financial / closing records)
drop policy if exists "service_role_manage_closings" on public.treatment_closings;
create policy "service_role_manage_closings"
  on public.treatment_closings for all
  to service_role
  using (true) with check (true);

-- 5. lead_enrichment (enrichment PII, financial signals)
drop policy if exists "Service role full access" on public.lead_enrichment;
create policy "Service role full access"
  on public.lead_enrichment for all
  to service_role
  using (true) with check (true);

-- 6. appointment_reminders (patient names / phones / appointment times)
drop policy if exists "Service role full access to reminders" on public.appointment_reminders;
create policy "Service role full access to reminders"
  on public.appointment_reminders for all
  to service_role
  using (true) with check (true);
