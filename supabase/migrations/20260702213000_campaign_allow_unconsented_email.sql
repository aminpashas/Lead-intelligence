-- Per-campaign re-permission override (EMAIL ONLY).
-- A campaign explicitly flagged allow_unconsented_email may email leads whose
-- email consent was never captured (email_consent_status = 'unknown').
-- Hard blocks are NOT overridable: email_opt_out and status 'declined' always
-- refuse the send (enforced in src/lib/consent/gate.ts emailCampaignGate).
-- SMS/voice consent gates are unaffected.
alter table campaigns
  add column if not exists allow_unconsented_email boolean not null default false;

comment on column campaigns.allow_unconsented_email is
  'Re-permission override: campaign may email consent-unknown leads. Never overrides email_opt_out or declined. Email only.';
