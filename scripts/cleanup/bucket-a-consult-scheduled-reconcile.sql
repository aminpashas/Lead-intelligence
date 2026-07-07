-- One-time cleanup: Bucket A of the SF "Consultation Scheduled" column.
--
-- Context: 411 leads sit in stage "Consultation Scheduled" (178b8538-…) but NONE
-- have a real/future appointment. 21 of them already ATTENDED a consult years ago
-- (2021–2023): their `status` is already terminal (consultation_completed /
-- disqualified) and only the pipeline `stage_id` is stale. This aligns stage->status.
--
-- ⚠️ SEQUENCING: the GHL reconcile cron (last ran 2026-07-07 08:03 UTC) is
-- GHL-authoritative and will move these leads BACK to consultation-scheduled on its
-- next pass, because their GHL opp maps to "appointment scheduled". Do NOT run this
-- until the reconcile reality-guard (plan: docs/.../2026-07-07-consult-scheduled-*.md)
-- has shipped, or the cleanup reverts within hours.
--
-- Run inside a transaction; inspect the SELECT counts before COMMIT.

BEGIN;

WITH src AS (
  SELECT id, status
  FROM leads
  WHERE organization_id = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
    AND stage_id = '178b8538-2674-4dbe-b9e1-3a3aee857a63'   -- Consultation Scheduled
    AND consult_completed_at IS NOT NULL                    -- Bucket A: actually attended
)
UPDATE leads l
SET stage_id = CASE src.status
      WHEN 'consultation_completed' THEN 'c0afeed5-5481-422c-8a76-6011d1622eb5' -- Consultation Completed
      WHEN 'disqualified'          THEN 'da3b0517-3e77-421f-908d-c0a8b8c8916f' -- Lost
    END,
    updated_at = now()
FROM src
WHERE l.id = src.id
  AND src.status IN ('consultation_completed', 'disqualified'); -- only the mappable ones

-- Audit trail so this shows as a deliberate cleanup, not a GHL reconcile.
INSERT INTO lead_activities (organization_id, lead_id, activity_type, title, description)
SELECT 'fa64e53c-3d9b-493e-b904-59580cb3f29c', id, 'stage_changed',
       'Stage corrected (attended-but-mislabeled cleanup)',
       'Bucket A: consult_completed_at set; stage aligned to status'
FROM leads
WHERE organization_id = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
  AND consult_completed_at IS NOT NULL
  AND stage_id IN ('c0afeed5-5481-422c-8a76-6011d1622eb5','da3b0517-3e77-421f-908d-c0a8b8c8916f')
  AND updated_at > now() - interval '1 minute';

-- Verify BEFORE commit: expect 0 remaining Bucket A in Consultation Scheduled.
SELECT count(*) AS bucket_a_still_in_consult_scheduled
FROM leads
WHERE organization_id = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
  AND stage_id = '178b8538-2674-4dbe-b9e1-3a3aee857a63'
  AND consult_completed_at IS NOT NULL;

-- COMMIT;   -- uncomment to apply
ROLLBACK;    -- default: no-op safety
