-- Distinct filter facets (source types + campaign names) for the Leads view
-- dropdowns. SECURITY INVOKER (default): runs under the caller's RLS, so it
-- only aggregates rows the session could already read; p_org scopes the query.
create or replace function public.leads_filter_facets(p_org uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'source_types', coalesce((
      select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc)
      from (
        select source_type as v, count(*) as n
        from leads
        where organization_id = p_org
          and source_type is not null and source_type <> ''
        group by 1
        order by count(*) desc
        limit 30
      ) s
    ), '[]'::jsonb),
    'campaigns', coalesce((
      -- Exact DGS-resolved campaign name when present, else raw utm_campaign.
      select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc)
      from (
        select coalesce(campaign_attribution->>'campaign_name', nullif(utm_campaign, '')) as v,
               count(*) as n
        from leads
        where organization_id = p_org
          and coalesce(campaign_attribution->>'campaign_name', nullif(utm_campaign, '')) is not null
        group by 1
        order by count(*) desc
        limit 50
      ) c
    ), '[]'::jsonb)
  );
$$;
