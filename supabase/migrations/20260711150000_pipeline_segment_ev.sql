-- Pipeline segment expected value (Workstream C1)
-- ================================================
-- The recommendations band ranks by lead COUNTS; this adds the dollar layer:
-- for one stage + signal segment, sum each lead's calibrated close probability
-- (leads.close_probability, stamped by the calibrate-scoring cron — see
-- 20260711130000_scoring_calibration.sql) times its treatment value.
--
-- Fallbacks are org-level aggregates computed once per call:
--   * close_probability NULL (not yet stamped)  → org avg of non-null stamps,
--     else 0.15 when the org has no stamps at all.
--   * treatment_value NULL (no CareStack link)  → org avg of positive
--     treatment values, else 20000 when the org has none.
--
-- The p_signal predicates MUST mirror src/lib/pipeline/pipeline-signals.ts
-- exactly (same reachability, same 7-day staleness window off p_now) so the
-- dollar figure describes the same segment as the displayed count.
--
-- NOTE ON SERVICE-LINE FILTERING: the board's treatment chips filter counts via
-- a PostgREST `.or()` string (serviceLineOrFilter — tags/UTM/treatment_interest
-- keyword soup) that does not translate cleanly to SQL. This RPC intentionally
-- has NO service filter; the TS caller skips EV enrichment whenever a service
-- chip is active so counts and dollars never describe different segments.

create or replace function public.pipeline_segment_ev(
  p_org_id uuid,
  p_stage_id uuid,
  p_signal text,
  p_now timestamptz default now()
)
returns table (
  lead_count bigint,
  expected_value numeric,
  avg_close_probability numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_fallback_p numeric;
  v_avg_tv numeric;
  -- Keep in lockstep with STALE_DAYS in src/lib/pipeline/pipeline-signals.ts.
  v_stale_cutoff timestamptz := p_now - interval '7 days';
begin
  -- SECURITY DEFINER bypasses RLS, so guard the org boundary explicitly:
  -- service-role (crons) may query any org; users only their own.
  if auth.role() is distinct from 'service_role'
     and p_org_id is distinct from get_user_org_id() then
    raise exception 'pipeline_segment_ev: organization mismatch';
  end if;

  if p_signal not in (
    'stale_reachable_sms', 'hot_warm_reachable_sms', 'never_contacted',
    'ready_to_book', 'deliberating_due'
  ) then
    raise exception 'pipeline_segment_ev: unknown signal %', p_signal;
  end if;

  -- Org-level fallback aggregates, computed once per call.
  select
    coalesce(avg(l.close_probability), 0.15),
    coalesce(avg(l.treatment_value) filter (where l.treatment_value > 0), 20000)
  into v_fallback_p, v_avg_tv
  from leads l
  where l.organization_id = p_org_id;

  return query
  select
    count(*)::bigint as lead_count,
    round(coalesce(sum(
      coalesce(l.close_probability, v_fallback_p)
      * coalesce(l.treatment_value, v_avg_tv)
    ), 0), 2) as expected_value,
    round(coalesce(avg(coalesce(l.close_probability, v_fallback_p)), 0), 4)
      as avg_close_probability
  from leads l
  where l.organization_id = p_org_id
    and l.stage_id = p_stage_id
    and case p_signal
      -- R5 segment: flagged by the conversation sweep. NO reachability gate —
      -- matches pipeline-signals.ts (`base().eq('conversation_intent', …)`).
      when 'ready_to_book' then l.conversation_intent = 'ready_to_book'
      else (
        -- Shared SMS-reachability (mirrors reachableSms in pipeline-signals.ts):
        l.phone_formatted is not null
        and l.sms_consent = true
        and l.sms_opt_out = false
        and case p_signal
          -- Never contacted OR contacted before the staleness cutoff.
          when 'stale_reachable_sms' then
            (l.last_contacted_at is null or l.last_contacted_at < v_stale_cutoff)
          when 'hot_warm_reachable_sms' then
            l.ai_qualification in ('hot', 'warm')
          when 'never_contacted' then
            l.last_contacted_at is null
          -- Deliberating deals whose agreed follow-up date has arrived.
          when 'deliberating_due' then (
            l.closing_temperature = 'deliberating'
            and l.closing_follow_up_at is not null
            and l.closing_follow_up_at <= p_now
          )
        end
      )
    end;
end;
$$;

comment on function public.pipeline_segment_ev(uuid, uuid, text, timestamptz) is
  'Expected dollar value of one pipeline stage+signal segment: Σ coalesce(close_probability, org avg, 0.15) × coalesce(treatment_value, org avg, 20000). Predicates mirror src/lib/pipeline/pipeline-signals.ts. No service-line filter (callers skip EV when a treatment chip is active).';

grant execute on function public.pipeline_segment_ev(uuid, uuid, text, timestamptz)
  to authenticated, service_role;
