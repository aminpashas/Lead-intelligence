-- ═══════════════════════════════════════════════════════════════════════════
-- STAGED / DORMANT — DO NOT RUN WITHOUT LEGAL SIGN-OFF.
--
-- WhatConverts inbound → voice_consent backfill (SF Dentistry).
--
-- Purpose: grant voice_consent to the ~10,480 leads that came in through
-- WhatConverts (source_type = 'whatconverts') — inbound conversions where the
-- prospect contacted the practice first. Once granted, these leads become
-- callable in the Power Dialer (which requires voice_consent = true).
--
-- ─────────────────────────────────────────────────────────────────────────
-- ⚠️  LEGAL GATE — this file must NOT be executed until BOTH are true:
--   1. Counsel / owner confirms the WhatConverts capture-time disclosure
--      established prior express consent covering RETURN and AUTOMATED / AI
--      voice calls (TCPA). Inbound contact alone is a defensible basis for a
--      return call, but automated/AI dialing needs the disclosure to have
--      said so. This is a factual/legal determination, not a code decision.
--   2. A second explicit go-ahead in the session to execute.
--
-- Setting voice_consent = true is the switch that lets the AI dialer place
-- ~10,480 real calls. Treat running this file as authorizing those calls.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Provenance is automatic — DO NOT hand-insert consent_log rows:
--   • trigger sync_consent_status  → sets voice_consent_status = 'granted'
--   • trigger log_consent_change   → inserts consent_log (channel='voice',
--       consent_given=true, granted_at=voice_consent_at, source=voice_consent_source)
-- So this UPDATE only sets the three voice_consent_* columns; the timestamped,
-- source-attributed audit record is written by the trigger.
--
-- Cohort is pinned by the tag 'wc-inbound-consent-candidate' (applied
-- 2026-07-03). Scope below re-checks the compliance predicate so a lead that
-- opted out AFTER tagging is still excluded at write time.
-- ═══════════════════════════════════════════════════════════════════════════

\set ORG_ID 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
\set CONSENT_SOURCE 'whatconverts_inbound'

-- ── 1. PREVIEW: exactly who would be granted (run this first, verify count ≈ 10480) ──
select count(*) as would_grant
from leads
where organization_id = :'ORG_ID'
  and tags @> array['wc-inbound-consent-candidate']
  and voice_consent is not true          -- idempotent: skip anyone already granted
  and do_not_call = false                -- re-check compliance at write time
  and voice_opt_out = false
  and coalesce(voice_consent_status,'unknown') <> 'declined'
  and status not in ('lost','disqualified','completed');

-- ── 2. GRANT (the sensitive write — leave commented until legal go + 2nd confirm) ──
-- update leads
-- set voice_consent        = true,
--     voice_consent_at     = now(),
--     voice_consent_source = :'CONSENT_SOURCE'
-- where organization_id = :'ORG_ID'
--   and tags @> array['wc-inbound-consent-candidate']
--   and voice_consent is not true
--   and do_not_call = false
--   and voice_opt_out = false
--   and coalesce(voice_consent_status,'unknown') <> 'declined'
--   and status not in ('lost','disqualified','completed');

-- ── 3. VERIFY (run after the grant) ──
-- select count(*) filter (where voice_consent is true)              as granted,
--        count(*) filter (where voice_consent_status = 'granted')   as status_granted
-- from leads
-- where organization_id = :'ORG_ID'
--   and tags @> array['wc-inbound-consent-candidate'];
-- select count(*) as consent_log_voice_grants
-- from consent_log
-- where organization_id = :'ORG_ID' and channel = 'voice'
--   and consent_given = true and source = :'CONSENT_SOURCE';

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (reverses the grant; consent_log rows are an immutable audit trail
-- and are intentionally left in place — they record that a grant was made and
-- then withdrawn).
-- ═══════════════════════════════════════════════════════════════════════════
-- update leads
-- set voice_consent = false,
--     voice_consent_at = null,
--     voice_consent_source = null,
--     voice_consent_status = 'unknown'
-- where organization_id = :'ORG_ID'
--   and tags @> array['wc-inbound-consent-candidate']
--   and voice_consent_source = :'CONSENT_SOURCE';
