-- Engagement temperature — behavioral hot/warm/cooling/cold/new meter.
--
-- `leads.engagement_score` has existed since 002 but nothing ever wrote it, and
-- the /leads "Engagement" column actually rendered ai_score (the AI *quality*
-- grade). This migration gives engagement its own real signal:
--
--   * engagement_temperature: recency band of patient-initiated activity
--   * engagement_score:       0-100 sort key within a band
--
-- Both are recomputed set-based by recompute_lead_engagement(), called from the
-- engagement-sweep cron every 15 minutes. Formula MUST mirror
-- src/lib/engagement/temperature.ts — tune thresholds in both places.

alter table leads add column if not exists engagement_temperature text;

-- Named constraint added idempotently (ADD COLUMN IF NOT EXISTS can't carry an
-- inline CHECK through a re-run).
do $$ begin
  alter table leads add constraint leads_engagement_temperature_check
    check (engagement_temperature in ('hot', 'warm', 'cooling', 'cold', 'new'));
exception when duplicate_object then null; end $$;

create index if not exists idx_leads_engagement_temperature
  on leads (organization_id, engagement_temperature);

-- Set-based recompute. p_org null ⇒ all orgs. Write hysteresis: a row is only
-- written when its temperature BAND changes or its score drifts ≥ 5 points —
-- leads carries a per-row audit trigger (trg_audit_leads), so rewriting the
-- whole book every 15 minutes would both time out and flood audit_events.
-- (The initial 55k backfill runs in a triggers-disabled transaction — see the
-- consent-backfill playbook.)
create or replace function recompute_lead_engagement(p_org uuid default null)
returns integer
language plpgsql
set statement_timeout to '120s'
as $$
declare
  v_updated integer;
begin
  with calc as (
    select
      l.id,
      -- Days since the patient last replied / since creation (floored at 0).
      -- NB: greatest() IGNORES nulls in Postgres — greatest(0, null) = 0, which
      -- would make every never-replied lead read as "replied just now" (hot).
      -- The CASE keeps null-propagation identical to the TS implementation.
      case when l.last_responded_at is null then null
           else greatest(0, extract(epoch from (now() - l.last_responded_at)) / 86400.0)
      end as reply_age,
      greatest(0, extract(epoch from (now() - l.created_at)) / 86400.0) as created_age,
      (l.consultation_date is not null
        and l.consultation_date >= date_trunc('day', now()))                   as upcoming_consult,
      l.total_messages_received,
      l.total_emails_opened,
      l.response_time_avg_minutes
    from leads l
    where (p_org is null or l.organization_id = p_org)
  ),
  scored as (
    select
      id,
      case
        when upcoming_consult or reply_age <= 3  then 'hot'
        when reply_age <= 14                     then 'warm'
        when reply_age <= 45                     then 'cooling'
        when reply_age is null and created_age <= 14 then 'new'
        else 'cold'
      end as temperature,
      least(100, round(
        coalesce(55 * exp(-reply_age / 14.0), 0)
        + least(coalesce(total_messages_received, 0), 10) * 2
        + case
            when response_time_avg_minutes is null  then 0
            when response_time_avg_minutes <= 60    then 10
            when response_time_avg_minutes <= 240   then 6
            when response_time_avg_minutes <= 1440  then 3
            else 0
          end
        + case when upcoming_consult then 15 else 0 end
        + least(coalesce(total_emails_opened, 0), 5)
      ))::integer as score
    from calc
  )
  update leads l
  set engagement_score = s.score,
      engagement_temperature = s.temperature
  from scored s
  where l.id = s.id
    and (l.engagement_temperature is distinct from s.temperature
      or abs(coalesce(l.engagement_score, 0) - s.score) >= 5);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;
