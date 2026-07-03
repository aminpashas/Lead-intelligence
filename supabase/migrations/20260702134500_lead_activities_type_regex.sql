-- Codify the lead_activities.activity_type constraint that PROD actually has.
--
-- Migration 002 shipped a 30-value whitelist, but prod was later relaxed
-- (outside tracked migrations) to a snake_case pattern check — verified live
-- 2026-07-02: CHECK ((activity_type ~ '^[a-z][a-z0-9_]*$')). Code now writes
-- ~60 distinct types (voice_*, financing_*, cross_channel_*, consent_*, and
-- dynamic `${channel}_encounter` values); prod accepts them all, but any
-- environment rebuilt from migrations (staging/DR/branch replay) still gets
-- the strict whitelist and silently drops those inserts.
--
-- This migration is a semantic no-op on prod (identical definition) and fixes
-- fresh replays. Idempotent.
alter table public.lead_activities
  drop constraint if exists lead_activities_activity_type_check;

alter table public.lead_activities
  add constraint lead_activities_activity_type_check
  check (activity_type ~ '^[a-z][a-z0-9_]*$');
