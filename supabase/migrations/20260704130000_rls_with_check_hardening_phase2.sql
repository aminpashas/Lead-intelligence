-- ════════════════════════════════════════════════════════════════════════
-- RLS WITH CHECK / service_role hardening — Phase 2
-- ════════════════════════════════════════════════════════════════════════
-- Series A audit follow-up. Two defect classes are closed here:
--
--   (A) A `FOR INSERT WITH CHECK (true)` policy with NO `TO service_role` clause
--       applies to `public` (i.e. every authenticated user), letting anyone
--       INSERT rows into ANY org. This is the same bug 20260603_fix_service_
--       role_rls_scope.sql fixed on six tables — it missed cross_channel_
--       deliveries. Re-scope it to service_role.
--
--   (B) An org-scoped policy with `USING (...)` but NO `WITH CHECK` constrains
--       which rows a user can READ/target, but leaves INSERT/UPDATE row VALUES
--       unconstrained — so a user can INSERT a row into, or UPDATE a row's
--       organization_id to, another tenant. 20260604_rls_with_check_hardening.sql
--       fixed one set of tables; these were missed. `ALTER POLICY ... WITH CHECK`
--       adds the constraint without dropping the existing USING clause.
--
-- Idempotent: DROP IF EXISTS + CREATE for (A); ALTER POLICY for (B).

-- ── (A) cross_channel_deliveries: INSERT was open to all authenticated users ──
drop policy if exists "service_role_insert_deliveries" on public.cross_channel_deliveries;
create policy "service_role_insert_deliveries" on public.cross_channel_deliveries
  for insert
  to service_role
  with check (true);

-- ── (B) PHI tables: FOR ALL policies missing WITH CHECK ──
-- patient_profiles / conversation_analyses: `for all using (org = ...)` — INSERT
-- was unconstrained, allowing cross-tenant PHI plant.
alter policy "patient_profiles_org_access" on public.patient_profiles
  with check (organization_id = public.get_user_org_id());

alter policy "conv_analyses_org_access" on public.conversation_analyses
  with check (organization_id = public.get_user_org_id());

-- ── (B) patient_contracts UPDATE: could relocate a non-executed contract cross-org ──
-- Mirror the USING predicate (org membership + approver role) as WITH CHECK so a
-- permitted approver cannot rewrite organization_id to another tenant.
alter policy "approvers_manage_contracts" on public.patient_contracts
  with check (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
    and exists (
      select 1 from public.user_profiles
      where id = auth.uid()
        and role in ('doctor_admin', 'office_manager', 'treatment_coordinator', 'owner', 'admin')
    )
  );

-- ── (B) Non-PHI org-scoped UPDATE policies missing WITH CHECK (row relocation) ──
alter policy "competitors_update" on public.competitors
  with check (organization_id = public.get_user_org_id());

alter policy "Users can update org goals in their org" on public.org_goals
  with check (organization_id = public.get_user_org_id());

alter policy "financing_lender_configs_update" on public.financing_lender_configs
  with check (organization_id = public.get_user_org_id());

-- Financial-PII tables with the same FOR UPDATE / USING-only shape:
alter policy "financing_applications_update" on public.financing_applications
  with check (organization_id = public.get_user_org_id());

alter policy "financing_submissions_update" on public.financing_submissions
  with check (organization_id = public.get_user_org_id());

-- expense_line_items: the UPDATE policy name drifted between the repo migration
-- ("… (for category override)") and prod ("Users update expense_line_items in
-- their org"). Target whichever UPDATE policy actually exists so this applies
-- cleanly to prod AND to a fresh replay, and no-ops if the table isn't present.
do $$
declare pol text;
begin
  if to_regclass('public.expense_line_items') is not null then
    select policyname into pol
      from pg_policies
     where schemaname = 'public' and tablename = 'expense_line_items' and cmd = 'UPDATE'
     limit 1;
    if pol is not null then
      execute format(
        'alter policy %I on public.expense_line_items with check (organization_id = public.get_user_org_id())',
        pol
      );
    end if;
  end if;
end $$;
