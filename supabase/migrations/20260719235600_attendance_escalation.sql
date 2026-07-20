-- Attendance-escalation tracking for the no-show prevention ladder.
-- Tier 1 = AI morning-of check-in SMS; Tier 2 = staff escalation (queue + Slack).
alter table public.appointments
  add column if not exists escalation_tier smallint,
  add column if not exists escalated_at timestamptz,
  add column if not exists checkin_sent_at timestamptz,
  add column if not exists checkin_replied_at timestamptz;

comment on column public.appointments.escalation_tier is
  'Highest no-show escalation tier reached: 1 = AI check-in sent, 2 = staff escalation fired';
comment on column public.appointments.checkin_sent_at is
  'When the tier-1 morning-of check-in SMS was sent (reply expected within 2h)';
comment on column public.appointments.checkin_replied_at is
  'When the patient replied YES to the tier-1 check-in';
