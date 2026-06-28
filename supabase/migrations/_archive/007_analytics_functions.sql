-- Pre-aggregated analytics functions
-- Moves heavy computation from JS to PostgreSQL for better performance

-- Function to get lead KPIs for an organization
CREATE OR REPLACE FUNCTION get_lead_kpis(p_org_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'total_leads', count(*),
    'hot_leads', count(*) FILTER (WHERE ai_qualification = 'hot'),
    'warm_leads', count(*) FILTER (WHERE ai_qualification = 'warm'),
    'cold_leads', count(*) FILTER (WHERE ai_qualification = 'cold'),
    'qualified_leads', count(*) FILTER (WHERE status IN ('qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed')),
    'converted_leads', count(*) FILTER (WHERE status IN ('contract_signed', 'scheduled', 'in_treatment', 'completed')),
    'total_pipeline', coalesce(sum(treatment_value), 0),
    'total_revenue', coalesce(sum(actual_revenue), 0),
    'avg_score', coalesce(round(avg(ai_score)), 0),
    'new_last_7d', count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    'new_last_30d', count(*) FILTER (WHERE created_at >= now() - interval '30 days')
  )
  FROM leads
  WHERE organization_id = p_org_id;
$$;

-- Function to get lead trends by day (last 30 days)
CREATE OR REPLACE FUNCTION get_lead_trend(p_org_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date::date,
      '1 day'::interval
    )::date AS day
  ),
  daily_leads AS (
    SELECT date_trunc('day', created_at)::date AS day, count(*) AS cnt
    FROM leads
    WHERE organization_id = p_org_id
      AND created_at >= now() - interval '30 days'
    GROUP BY 1
  ),
  daily_conversions AS (
    SELECT date_trunc('day', converted_at)::date AS day, count(*) AS cnt
    FROM leads
    WHERE organization_id = p_org_id
      AND converted_at >= now() - interval '30 days'
      AND converted_at IS NOT NULL
    GROUP BY 1
  )
  SELECT json_agg(
    json_build_object(
      'date', d.day,
      'leads', coalesce(dl.cnt, 0),
      'conversions', coalesce(dc.cnt, 0)
    ) ORDER BY d.day
  )
  FROM days d
  LEFT JOIN daily_leads dl ON dl.day = d.day
  LEFT JOIN daily_conversions dc ON dc.day = d.day;
$$;

-- Function to get source breakdown
CREATE OR REPLACE FUNCTION get_source_breakdown(p_org_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT coalesce(json_agg(
    json_build_object('source', source_type, 'count', cnt)
    ORDER BY cnt DESC
  ), '[]'::json)
  FROM (
    SELECT coalesce(source_type, 'unknown') AS source_type, count(*) AS cnt
    FROM leads
    WHERE organization_id = p_org_id
    GROUP BY source_type
  ) sub;
$$;

-- Function to get qualification distribution
CREATE OR REPLACE FUNCTION get_qualification_distribution(p_org_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'hot', count(*) FILTER (WHERE ai_qualification = 'hot'),
    'warm', count(*) FILTER (WHERE ai_qualification = 'warm'),
    'cold', count(*) FILTER (WHERE ai_qualification = 'cold'),
    'unqualified', count(*) FILTER (WHERE ai_qualification = 'unqualified'),
    'unscored', count(*) FILTER (WHERE ai_qualification = 'unscored' OR ai_qualification IS NULL)
  )
  FROM leads
  WHERE organization_id = p_org_id;
$$;

-- Add indexes for analytics query performance
CREATE INDEX IF NOT EXISTS idx_leads_org_created ON leads(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_qualification ON leads(organization_id, ai_qualification);
CREATE INDEX IF NOT EXISTS idx_messages_org_created ON messages(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_appointments_org_status ON appointments(organization_id, status);
