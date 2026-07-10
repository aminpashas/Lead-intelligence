-- Manual dial (dial-any-number from the softphone)
--
-- The browser softphone could previously only dial a LEAD (every dial path keyed
-- off lead_id). Staff now need to dial an arbitrary number they type into a
-- keypad. Such a call has no lead record, so voice_calls.lead_id must be nullable.
--
-- RLS and every downstream path already key on organization_id (not lead_id), so
-- a lead-less row is org-scoped and dispositionable exactly like any other call.
-- The manual-dial intent still runs a reduced gate server-side (org voice_enabled,
-- caller ID, hourly rate limit) and a DNC safety lookup: if the typed number
-- matches a lead who is do_not_call / voice_opt_out, the dial is refused.

ALTER TABLE voice_calls
  ALTER COLUMN lead_id DROP NOT NULL;

COMMENT ON COLUMN voice_calls.lead_id IS
  'The lead this call belongs to. NULL for a manual (dial-any-number) call whose typed number did not match an existing lead.';
