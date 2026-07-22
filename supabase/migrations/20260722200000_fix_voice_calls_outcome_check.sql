-- Make voice_calls.outcome's CHECK actually enforce.
--
-- THE BUG
-- -------
-- The original constraint was written as:
--
--   CHECK (outcome = ANY (ARRAY['appointment_booked', ..., 'transferred', NULL::text]))
--
-- The NULL inside the array was presumably meant to "allow NULL". It does far
-- more than that. SQL three-valued logic says `'user_hangup' = NULL` is NULL, not
-- false, so `= ANY(...)` over an array containing NULL returns NULL for ANY value
-- not otherwise matched — and a CHECK constraint PASSES when its expression is
-- NULL. The constraint therefore accepted every string ever written to it.
--
-- Proof, on prod, before this migration:
--   select 'user_hangup' = ANY (ARRAY['appointment_booked', NULL::text]);  -- NULL
--
-- The column had accumulated raw Retell disconnect reasons (`user_hangup` ×4,
-- `telephony_provider_permission_denied` ×2, `agent_hangup` ×1) written by the
-- voice-reconcile cron's old fallback branch. None of them are members of the
-- VoiceCallOutcome TS union, so every consumer typed against it was mis-typed,
-- and outcome rollups silently under-counted.
--
-- THE FIX
-- -------
-- Hoist the nullability out of the array into an explicit `IS NULL` disjunct. NULL
-- stays legal (it means "connected but unclassified" — the UI renders it as "Needs
-- Review" and post-call review refines it), but every non-null value must now be a
-- real member of the vocabulary.

-- 1. Clean the existing violations first — ALTER TABLE ... ADD CONSTRAINT validates
--    existing rows, so a dirty table would reject the new constraint outright.
--    Platform-error disconnects map onto the vocabulary's own technical bucket.
update voice_calls
   set outcome = 'technical_failure'
 where outcome in (
   'telephony_provider_permission_denied',
   'dial_failed',
   'invalid_destination',
   'concurrency_limit_reached',
   'no_valid_payment',
   'telephony_provider_unavailable'
 );

-- Plain hangups carry no verdict about how the call went — that is exactly the
-- "unclassified" case NULL is for. Null them rather than guessing; post-call
-- review (and scripts/backfill-post-call-review.ts) will classify them properly.
update voice_calls
   set outcome = NULL
 where outcome is not null
   and outcome not in (
     'appointment_booked', 'callback_requested', 'interested', 'not_interested',
     'wrong_number', 'do_not_call', 'voicemail_left', 'voicemail_received',
     'no_answer', 'technical_failure', 'transferred'
   );

-- 2. Swap the constraint.
alter table voice_calls drop constraint if exists voice_calls_outcome_check;

alter table voice_calls add constraint voice_calls_outcome_check
  check (
    outcome is null
    or outcome = ANY (ARRAY[
      'appointment_booked', 'callback_requested', 'interested', 'not_interested',
      'wrong_number', 'do_not_call', 'voicemail_left', 'voicemail_received',
      'no_answer', 'technical_failure', 'transferred'
    ]::text[])
  );
