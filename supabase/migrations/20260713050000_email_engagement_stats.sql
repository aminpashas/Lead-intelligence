-- Per-lead email engagement stats, used by the mass-send "sunset" filter to stop
-- re-mailing chronic non-openers (the #1 driver of Gmail spam-foldering).
--
-- For each requested lead, counts outbound marketing emails sent since p_since and
-- how many of those were engaged (opened or clicked). SECURITY INVOKER so it runs
-- under the caller's RLS — an agency_admin only ever sees their own org's rows.
create or replace function public.email_engagement_stats(
  p_org uuid,
  p_lead_ids uuid[],
  p_since timestamptz
)
returns table (lead_id uuid, sent_count bigint, engaged_count bigint)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select m.lead_id,
         count(*) as sent_count,
         count(*) filter (where m.opened_at is not null or m.clicked_at is not null) as engaged_count
  from public.messages m
  where m.organization_id = p_org
    and m.lead_id = any(p_lead_ids)
    and m.channel = 'email'
    and m.direction = 'outbound'
    and m.created_at >= p_since
  group by m.lead_id;
$$;
