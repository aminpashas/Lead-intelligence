# DGS-side endpoint for the ad-metrics bridge

The LI cron `/api/cron/sync-growth-studio-metrics` pulls per-campaign, per-day
paid metrics from **Dion Growth Studio** via `GET /api/v1/ad-metrics`. That
endpoint does not exist in DGS yet — this is the one piece that must be added in
the **dion-growth-studio** repo to complete the loop. Everything on the LI side
(`src/lib/bridges/growth-studio-metrics.ts`, the cron, the `vercel.json` entry)
is already built and degrades to a clean no-op until this endpoint responds.

Auth mirrors the existing `/api/v1/performance` endpoint: `Authorization: Bearer
<LEAD_INTELLIGENCE_SERVICE_KEY>` (the same shared secret LI stores as
`GROWTH_STUDIO_API_KEY`). Reuse DGS's existing service-key verifier.

## 1. SQL function (DGS migration)

```sql
-- supabase/migrations/<ts>_li_ad_metrics_export.sql  (in dion-growth-studio)
create or replace function public.li_ad_metrics(days int default 90)
returns table (
  customer_id uuid,
  channel text,
  account_id text,
  campaign_id text,
  campaign_name text,
  metric_date date,
  impressions bigint,
  clicks bigint,
  spend numeric,
  conversions numeric,
  conversion_value numeric,
  currency text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.lead_intel_customer_id                                as customer_id,
    case m.channel when 'ppc_google' then 'google_ads'
                   when 'ppc_meta'   then 'meta' end         as channel,
    'growth_studio:' || coalesce(m.brand_slug, w.slug)      as account_id,
    m.entity_id                                             as campaign_id,
    m.entity_name                                           as campaign_name,
    m.date                                                  as metric_date,
    coalesce((m.metrics->>'impressions')::bigint, 0)        as impressions,
    coalesce((m.metrics->>'clicks')::bigint, 0)             as clicks,
    round(coalesce((m.metrics->>'spend')::numeric, 0), 4)   as spend,
    round(coalesce((m.metrics->>'conversions')::numeric, 0), 4)       as conversions,
    round(coalesce((m.metrics->>'conversion_value')::numeric, 0), 4)  as conversion_value,
    'USD'                                                   as currency
  from public.metrics_daily m
  join public.workspaces w on w.id = m.workspace_id
  where w.lead_intel_customer_id is not null
    and m.channel in ('ppc_google', 'ppc_meta')
    and m.entity_type = 'campaign'          -- campaign grain only: avoids double-counting ad_group / leads_rollup
    and m.date >= (current_date - days);
$$;
```

Notes:
- Only `entity_type = 'campaign'` rows are exported. DGS also stores `ad_group`,
  `ad`, and `leads_rollup` levels for the same spend — including them would
  multiply spend/conversions. Campaign grain matches LI's `ad_metrics_daily`.
- `channel` is pre-mapped to LI's CHECK values (`google_ads` / `meta`). The LI
  bridge also maps defensively, so either form is safe.
- Add `ga4` later by unioning the GA4 conversion rows if you want organic traffic
  in the same table.

## 2. Route (DGS: `src/app/api/v1/ad-metrics/route.ts`)

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server' // DGS's service client
import { verifyLeadIntelligenceKey } from '@/lib/auth/service-key' // DGS's existing verifier

export async function GET(request: NextRequest) {
  if (!verifyLeadIntelligenceKey(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const daysParam = Number(new URL(request.url).searchParams.get('days') ?? '90')
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 400) : 90

  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('li_ad_metrics', { days })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // LI's bridge expects { rows: [...] }
  return NextResponse.json({ rows: data ?? [] })
}
```

Adapt the two imports to DGS's actual helpers (its service client + the
service-key verifier already used by `/api/v1/performance`).

## 3. Verify

```bash
curl -s -H "Authorization: Bearer $LEAD_INTELLIGENCE_SERVICE_KEY" \
  "https://dion-growth-studio.vercel.app/api/v1/ad-metrics?days=7" | jq '.rows | length'
```

Once it returns rows, the LI cron (hourly) fills `ad_metrics_daily` on its own —
no LI redeploy needed beyond shipping the cron.
