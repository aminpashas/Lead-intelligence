-- Fix: patient_profiles upsert(onConflict:'lead_id') had NO backing unique
-- constraint, so every write errored at the DB and was silently swallowed
-- (console.error only) — zero psychology profiles ever persisted. Identical to
-- the conversation_analyses bug fixed in 20260705210000.
--
-- Safe to apply: because the upsert has always failed, there are no rows (and
-- therefore no duplicate lead_id values) to block the unique index. If a future
-- replay finds duplicates, keep only the most-recently-analyzed row per lead
-- before creating the constraint (dedupe block below, commented out).

-- -- Dedupe guard (only needed if rows already exist with duplicate lead_id):
-- DELETE FROM public.patient_profiles p
-- USING public.patient_profiles q
-- WHERE p.lead_id = q.lead_id
--   AND p.ctid < q.ctid;

ALTER TABLE public.patient_profiles
  ADD CONSTRAINT patient_profiles_lead_id_key UNIQUE (lead_id);
