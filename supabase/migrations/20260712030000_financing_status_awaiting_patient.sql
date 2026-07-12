-- Add 'awaiting_patient' terminal state to financing_applications.status.
--
-- A link-based lender (Cherry/Proceed/LendingClub/Alpheon) never returns an
-- approve/deny decision — it emits an application URL the patient completes on
-- the lender's own site. The waterfall previously fell through to 'denied' when
-- no API lender approved, which wrongly flagged the lead un-financeable and
-- fired the "sorry, we couldn't approve you" follow-up. `awaiting_patient` is a
-- truthful, non-denial terminal state for that case.
--
-- Applied to prod via MCP on 2026-07-12 (migration financing_status_awaiting_patient).
-- Recorded here for version-control parity. Idempotent.
ALTER TABLE financing_applications
  DROP CONSTRAINT IF EXISTS financing_applications_status_check;

ALTER TABLE financing_applications
  ADD CONSTRAINT financing_applications_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'in_progress'::text,
    'approved'::text,
    'denied'::text,
    'error'::text,
    'expired'::text,
    'awaiting_patient'::text
  ]));
