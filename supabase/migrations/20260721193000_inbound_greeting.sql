-- Answered-greeting for inbound ring-agents mode. When set, the call is
-- answered immediately and this message plays before the team rings —
-- which also prevents the forwarding carrier (e.g. GHL) from pulling the
-- call back to its own voicemail on a no-answer timeout.
alter table organizations
  add column if not exists inbound_greeting text;
