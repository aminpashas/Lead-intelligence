-- HIPAA identity verification gate (45 CFR §164.514(h)).
-- Tracks whether the person on a conversation has proven they are the patient
-- before the AI agent may disclose case-specific PHI. Session-scoped and
-- time-boxed in application code (see src/lib/ai/identity-verification.ts).

alter table conversations
  add column if not exists identity_verified_at timestamptz,
  add column if not exists identity_verified_via text;

comment on column conversations.identity_verified_at is
  'When the caller last proved their identity on this conversation. Null = unverified. TTL enforced in app (voice 15m, text 30m).';
comment on column conversations.identity_verified_via is
  'How identity was verified (e.g. "dob"). Null when unverified.';
