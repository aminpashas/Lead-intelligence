-- ════════════════════════════════════════════════════════════════
-- Migration 031: Agent Performance Daily Fact Table + KPI RPC
--
-- Adds a daily counter fact table (populated nightly by cron) plus
-- a single RPC, get_agent_kpi_summary, that returns per-agent KPIs
-- over a date range. Rate KPIs are computed live from source tables
-- (lead-level state cannot be correctly pre-aggregated as daily sums).
-- The fact table backs the counter-style totals (cost, revenue,
-- response time) and sparklines / future Phase B grading.
--
-- Phase A of the AI Agent KPI Dashboard system.
-- ════════════════════════════════════════════════════════════════

-- ── Daily counter fact table ────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_performance_daily (
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date date NOT NULL,
  outbound_ai_messages integer NOT NULL DEFAULT 0,
  inbound_messages integer NOT NULL DEFAULT 0,
  leads_first_touched integer NOT NULL DEFAULT 0,
  appts_booked integer NOT NULL DEFAULT 0,
  appts_completed integer NOT NULL DEFAULT 0,
  appts_no_show integer NOT NULL DEFAULT 0,
  appts_rescheduled integer NOT NULL DEFAULT 0,
  appts_canceled integer NOT NULL DEFAULT 0,
  leads_qualified integer NOT NULL DEFAULT 0,
  leads_disqualified integer NOT NULL DEFAULT 0,
  conversation_ratings_count integer NOT NULL DEFAULT 0,
  conversation_ratings_sum numeric NOT NULL DEFAULT 0,
  response_count integer NOT NULL DEFAULT 0,
  response_total_seconds bigint NOT NULL DEFAULT 0,
  ai_cost_cents bigint NOT NULL DEFAULT 0,
  closed_revenue_cents bigint NOT NULL DEFAULT 0,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, date)
);

CREATE INDEX IF NOT EXISTS idx_agent_perf_daily_org_date
  ON agent_performance_daily(organization_id, date DESC);

ALTER TABLE agent_performance_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_performance_daily_org_isolation" ON agent_performance_daily
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- refresh_agent_performance_daily(p_org_id, p_date)
--
-- Recomputes one day's row per agent for the given org. Idempotent
-- via ON CONFLICT. Called nightly from the campaigns cron.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.refresh_agent_performance_daily(
  p_org_id uuid,
  p_date date DEFAULT (current_date - 1)
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  agent_rec RECORD;
  day_start timestamptz := p_date::timestamptz;
  day_end timestamptz := (p_date + 1)::timestamptz;
  rows_written integer := 0;
  v_outbound int; v_inbound int; v_first_touched int;
  v_booked int; v_completed int; v_no_show int; v_resched int; v_canceled int;
  v_qualified int; v_disqualified int;
  v_ratings_count int; v_ratings_sum numeric;
  v_resp_count int; v_resp_total bigint;
  v_ai_cost bigint; v_revenue bigint;
BEGIN
  FOR agent_rec IN
    SELECT id, role FROM ai_agents
     WHERE organization_id = p_org_id AND is_active = true
  LOOP
    -- Outbound + inbound messages
    SELECT
      COUNT(*) FILTER (WHERE m.direction = 'outbound' AND m.sender_type = 'ai' AND m.agent_id = agent_rec.id),
      COUNT(*) FILTER (WHERE m.direction = 'inbound' AND c.active_agent = agent_rec.role)
    INTO v_outbound, v_inbound
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = p_org_id
      AND m.created_at >= day_start AND m.created_at < day_end;

    -- Leads first touched by this agent today
    SELECT COUNT(DISTINCT m.lead_id) INTO v_first_touched
    FROM messages m
    WHERE m.agent_id = agent_rec.id
      AND m.direction = 'outbound'
      AND m.sender_type = 'ai'
      AND m.created_at >= day_start AND m.created_at < day_end
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
         WHERE m2.lead_id = m.lead_id
           AND m2.agent_id = agent_rec.id
           AND m2.created_at < day_start
      );

    -- Appointments booked today where this agent touched the lead prior
    SELECT COUNT(*) INTO v_booked
    FROM appointments a
    WHERE a.organization_id = p_org_id
      AND a.created_at >= day_start AND a.created_at < day_end
      AND EXISTS (
        SELECT 1 FROM messages m
         WHERE m.lead_id = a.lead_id
           AND m.agent_id = agent_rec.id
           AND m.created_at <= a.created_at
      );

    -- Appointment outcomes
    SELECT
      COUNT(*) FILTER (WHERE a.status = 'completed' AND a.completed_at >= day_start AND a.completed_at < day_end),
      COUNT(*) FILTER (WHERE a.status = 'no_show' AND COALESCE(a.no_show_at, a.scheduled_at) >= day_start AND COALESCE(a.no_show_at, a.scheduled_at) < day_end),
      COUNT(*) FILTER (WHERE a.status = 'rescheduled' AND a.updated_at >= day_start AND a.updated_at < day_end),
      COUNT(*) FILTER (WHERE a.status = 'canceled' AND COALESCE(a.canceled_at, a.updated_at) >= day_start AND COALESCE(a.canceled_at, a.updated_at) < day_end)
    INTO v_completed, v_no_show, v_resched, v_canceled
    FROM appointments a
    WHERE a.organization_id = p_org_id
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = a.lead_id AND m.agent_id = agent_rec.id);

    -- Qualification activities
    SELECT
      COUNT(*) FILTER (WHERE la.activity_type = 'qualified'),
      COUNT(*) FILTER (WHERE la.activity_type = 'disqualified')
    INTO v_qualified, v_disqualified
    FROM lead_activities la
    WHERE la.organization_id = p_org_id
      AND la.created_at >= day_start AND la.created_at < day_end
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = la.lead_id AND m.agent_id = agent_rec.id);

    -- Conversation ratings (scoped by active_agent role)
    SELECT
      COUNT(*),
      COALESCE(SUM(r.rating), 0)::numeric
    INTO v_ratings_count, v_ratings_sum
    FROM ai_conversation_ratings r
    JOIN conversations c ON c.id = r.conversation_id
    WHERE r.organization_id = p_org_id
      AND c.active_agent = agent_rec.role
      AND r.created_at >= day_start AND r.created_at < day_end;

    -- Response time: agent's outbound messages responding to an immediately prior inbound
    WITH pairs AS (
      SELECT
        reply.created_at AS reply_at,
        (SELECT MAX(inb.created_at)
           FROM messages inb
          WHERE inb.conversation_id = reply.conversation_id
            AND inb.direction = 'inbound'
            AND inb.created_at < reply.created_at) AS inbound_at
      FROM messages reply
      WHERE reply.agent_id = agent_rec.id
        AND reply.direction = 'outbound'
        AND reply.created_at >= day_start AND reply.created_at < day_end
    )
    SELECT
      COUNT(*) FILTER (WHERE inbound_at IS NOT NULL),
      COALESCE(SUM(EXTRACT(EPOCH FROM (reply_at - inbound_at))) FILTER (WHERE inbound_at IS NOT NULL), 0)::bigint
    INTO v_resp_count, v_resp_total
    FROM pairs;

    -- AI cost (from ai_interactions metadata.cost_usd, scoped by agent role)
    SELECT COALESCE(ROUND(SUM(COALESCE((ai.metadata->>'cost_usd')::numeric, 0)) * 100)::bigint, 0)
    INTO v_ai_cost
    FROM ai_interactions ai
    WHERE ai.organization_id = p_org_id
      AND ai.metadata->>'agent' = agent_rec.role
      AND ai.created_at >= day_start AND ai.created_at < day_end;

    -- Closed revenue: invoices paid today + stripe payments today for agent's leads
    SELECT COALESCE(ROUND(SUM(amount) * 100)::bigint, 0) INTO v_revenue
    FROM (
      SELECT i.amount
        FROM invoices i
        JOIN patients p ON p.id = i.patient_id
       WHERE i.organization_id = p_org_id
         AND i.payment_date >= day_start AND i.payment_date < day_end
         AND p.lead_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = p.lead_id AND m.agent_id = agent_rec.id)
      UNION ALL
      SELECT sp.amount
        FROM stripe_payments sp
       WHERE sp.organization_id = p_org_id
         AND sp.occurred_at >= day_start AND sp.occurred_at < day_end
         AND sp.lead_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = sp.lead_id AND m.agent_id = agent_rec.id)
    ) t;

    INSERT INTO agent_performance_daily (
      agent_id, organization_id, date,
      outbound_ai_messages, inbound_messages, leads_first_touched,
      appts_booked, appts_completed, appts_no_show, appts_rescheduled, appts_canceled,
      leads_qualified, leads_disqualified,
      conversation_ratings_count, conversation_ratings_sum,
      response_count, response_total_seconds,
      ai_cost_cents, closed_revenue_cents, refreshed_at
    ) VALUES (
      agent_rec.id, p_org_id, p_date,
      v_outbound, v_inbound, v_first_touched,
      v_booked, v_completed, v_no_show, v_resched, v_canceled,
      v_qualified, v_disqualified,
      v_ratings_count, v_ratings_sum,
      v_resp_count, v_resp_total,
      v_ai_cost, v_revenue, now()
    )
    ON CONFLICT (agent_id, date) DO UPDATE SET
      outbound_ai_messages       = EXCLUDED.outbound_ai_messages,
      inbound_messages           = EXCLUDED.inbound_messages,
      leads_first_touched        = EXCLUDED.leads_first_touched,
      appts_booked               = EXCLUDED.appts_booked,
      appts_completed            = EXCLUDED.appts_completed,
      appts_no_show              = EXCLUDED.appts_no_show,
      appts_rescheduled          = EXCLUDED.appts_rescheduled,
      appts_canceled             = EXCLUDED.appts_canceled,
      leads_qualified            = EXCLUDED.leads_qualified,
      leads_disqualified         = EXCLUDED.leads_disqualified,
      conversation_ratings_count = EXCLUDED.conversation_ratings_count,
      conversation_ratings_sum   = EXCLUDED.conversation_ratings_sum,
      response_count             = EXCLUDED.response_count,
      response_total_seconds     = EXCLUDED.response_total_seconds,
      ai_cost_cents              = EXCLUDED.ai_cost_cents,
      closed_revenue_cents       = EXCLUDED.closed_revenue_cents,
      refreshed_at               = now();

    rows_written := rows_written + 1;
  END LOOP;

  RETURN rows_written;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- get_agent_kpi_summary(p_org_id, p_start, p_end, p_agent_id?)
--
-- Returns an array of agent KPI objects for the dashboard. Rate
-- KPIs compute live; counter totals pull from the fact table.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_agent_kpi_summary(
  p_org_id uuid,
  p_start timestamptz DEFAULT (now() - interval '30 days'),
  p_end timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  WITH agents AS (
    SELECT id, name, role, is_active
      FROM ai_agents
     WHERE organization_id = p_org_id
       AND is_active = true
       AND (p_agent_id IS NULL OR id = p_agent_id)
  ),
  stats AS (
    SELECT
      a.id AS agent_id,
      a.name,
      a.role,
      -- Attributed leads: distinct leads this agent messaged in the window
      (SELECT COUNT(DISTINCT m.lead_id) FROM messages m
        WHERE m.agent_id = a.id AND m.direction = 'outbound' AND m.sender_type = 'ai'
          AND m.created_at BETWEEN p_start AND p_end) AS attributed_leads,
      -- Leads that replied at least once in the window
      (SELECT COUNT(DISTINCT m.lead_id) FROM messages m
        WHERE m.agent_id = a.id AND m.direction = 'outbound' AND m.sender_type = 'ai'
          AND m.created_at BETWEEN p_start AND p_end
          AND EXISTS (
            SELECT 1 FROM messages r
             WHERE r.lead_id = m.lead_id
               AND r.direction = 'inbound'
               AND r.created_at BETWEEN p_start AND p_end
          )) AS replied_leads,
      -- Avg call rating (scoped by agent role)
      (SELECT AVG(r.rating)::numeric(4,2) FROM ai_conversation_ratings r
        JOIN conversations c ON c.id = r.conversation_id
        WHERE r.organization_id = p_org_id
          AND c.active_agent = a.role
          AND r.created_at BETWEEN p_start AND p_end) AS avg_call_rating,
      -- Booked leads (consultation appointments)
      (SELECT COUNT(DISTINCT ap.lead_id) FROM appointments ap
        WHERE ap.organization_id = p_org_id
          AND ap.type = 'consultation'
          AND ap.created_at BETWEEN p_start AND p_end
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.lead_id = ap.lead_id AND m.agent_id = a.id
               AND m.created_at <= ap.created_at
          )) AS booked_leads,
      -- Appointment outcomes in window for agent's leads
      (SELECT COUNT(*) FROM appointments ap
        WHERE ap.organization_id = p_org_id
          AND ap.status = 'no_show'
          AND COALESCE(ap.no_show_at, ap.scheduled_at) BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = ap.lead_id AND m.agent_id = a.id))
        AS appts_no_show,
      (SELECT COUNT(*) FROM appointments ap
        WHERE ap.organization_id = p_org_id
          AND ap.status = 'completed'
          AND ap.completed_at BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = ap.lead_id AND m.agent_id = a.id))
        AS appts_completed,
      (SELECT COUNT(*) FROM appointments ap
        WHERE ap.organization_id = p_org_id
          AND ap.status = 'rescheduled'
          AND ap.updated_at BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = ap.lead_id AND m.agent_id = a.id))
        AS appts_rescheduled,
      (SELECT COUNT(*) FROM appointments ap
        WHERE ap.organization_id = p_org_id
          AND ap.status = 'canceled'
          AND COALESCE(ap.canceled_at, ap.updated_at) BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = ap.lead_id AND m.agent_id = a.id))
        AS appts_canceled,
      -- Qualified leads
      (SELECT COUNT(DISTINCT la.lead_id) FROM lead_activities la
        WHERE la.organization_id = p_org_id
          AND la.activity_type = 'qualified'
          AND la.created_at BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = la.lead_id AND m.agent_id = a.id))
        AS qualified_leads,
      -- Follow-up numerator: leads with ≥2 outbound msgs ≥24h apart in window
      (SELECT COUNT(DISTINCT m1.lead_id)
         FROM messages m1
         JOIN messages m2 ON m2.lead_id = m1.lead_id
                         AND m2.agent_id = a.id
                         AND m2.direction = 'outbound'
                         AND m2.sender_type = 'ai'
                         AND m2.created_at >= m1.created_at + interval '24 hours'
                         AND m2.created_at BETWEEN p_start AND p_end
        WHERE m1.agent_id = a.id
          AND m1.direction = 'outbound'
          AND m1.sender_type = 'ai'
          AND m1.created_at BETWEEN p_start AND p_end)
        AS followup_leads,
      -- Follow-up denominator: leads with ≥1 outbound msg and no reply within 24h
      (SELECT COUNT(DISTINCT m.lead_id) FROM messages m
        WHERE m.agent_id = a.id AND m.direction = 'outbound' AND m.sender_type = 'ai'
          AND m.created_at BETWEEN p_start AND p_end
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.lead_id = m.lead_id AND r.direction = 'inbound'
               AND r.created_at BETWEEN m.created_at AND m.created_at + interval '24 hours'
          ))
        AS unresponded_leads,
      -- Cold leads: last agent message ≥14d before p_end AND status non-terminal
      (SELECT COUNT(DISTINCT lm.lead_id)
         FROM (
           SELECT m.lead_id, MAX(m.created_at) AS last_at
             FROM messages m
            WHERE m.agent_id = a.id AND m.direction = 'outbound' AND m.sender_type = 'ai'
              AND m.created_at BETWEEN p_start AND p_end
            GROUP BY m.lead_id
         ) lm
         JOIN leads l ON l.id = lm.lead_id
        WHERE lm.last_at < p_end - interval '14 days'
          AND l.status NOT IN ('completed','lost','disqualified','contract_signed','scheduled','in_treatment'))
        AS cold_leads,
      -- No-communication leads
      (SELECT COUNT(DISTINCT m.lead_id) FROM messages m
        WHERE m.agent_id = a.id AND m.direction = 'outbound' AND m.sender_type = 'ai'
          AND m.created_at BETWEEN p_start AND p_end
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.lead_id = m.lead_id AND r.direction = 'inbound'
          ))
        AS no_comm_leads,
      -- Counter-style totals from fact table
      (SELECT
         CASE WHEN SUM(response_count) > 0
              THEN ROUND((SUM(response_total_seconds)::numeric / SUM(response_count)) / 60, 1)
              ELSE NULL END
         FROM agent_performance_daily
        WHERE agent_id = a.id AND date BETWEEN p_start::date AND p_end::date)
        AS avg_response_minutes,
      COALESCE((SELECT ROUND(SUM(closed_revenue_cents)::numeric / 100, 2)
                  FROM agent_performance_daily
                 WHERE agent_id = a.id AND date BETWEEN p_start::date AND p_end::date), 0)
        AS closed_revenue,
      COALESCE((SELECT ROUND(SUM(ai_cost_cents)::numeric / 100, 2)
                  FROM agent_performance_daily
                 WHERE agent_id = a.id AND date BETWEEN p_start::date AND p_end::date), 0)
        AS total_ai_cost,
      (SELECT COUNT(DISTINCT l.id) FROM leads l
        WHERE l.organization_id = p_org_id
          AND l.status IN ('contract_signed','scheduled','in_treatment','completed')
          AND l.converted_at BETWEEN p_start AND p_end
          AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.agent_id = a.id))
        AS converted_leads
    FROM agents a
  )
  SELECT json_agg(
    json_build_object(
      'id', agent_id,
      'name', name,
      'role', role,
      'kpis', json_build_object(
        'contact_rate',          CASE WHEN attributed_leads > 0 THEN ROUND(replied_leads::numeric * 100 / attributed_leads, 1) END,
        'avg_call_rating',       avg_call_rating,
        'booking_rate',          CASE WHEN attributed_leads > 0 THEN ROUND(booked_leads::numeric * 100 / attributed_leads, 1) END,
        'no_show_rate',          CASE WHEN (appts_completed + appts_no_show) > 0
                                      THEN ROUND(appts_no_show::numeric * 100 / (appts_completed + appts_no_show), 1) END,
        'reschedule_rate',       CASE WHEN (appts_completed + appts_no_show + appts_rescheduled + appts_canceled) > 0
                                      THEN ROUND(appts_rescheduled::numeric * 100 /
                                           (appts_completed + appts_no_show + appts_rescheduled + appts_canceled), 1) END,
        'qualification_rate',    CASE WHEN attributed_leads > 0 THEN ROUND(qualified_leads::numeric * 100 / attributed_leads, 1) END,
        'follow_up_rate',        CASE WHEN unresponded_leads > 0 THEN ROUND(followup_leads::numeric * 100 / unresponded_leads, 1) END,
        'leads_went_cold_rate',  CASE WHEN attributed_leads > 0 THEN ROUND(cold_leads::numeric * 100 / attributed_leads, 1) END,
        'no_communication_rate', CASE WHEN attributed_leads > 0 THEN ROUND(no_comm_leads::numeric * 100 / attributed_leads, 1) END,
        'avg_response_minutes',  avg_response_minutes,
        'closed_revenue',        closed_revenue,
        'cac_per_converted',     CASE WHEN converted_leads > 0 THEN ROUND(total_ai_cost / converted_leads, 2) END
      ),
      'raw', json_build_object(
        'attributed_leads', attributed_leads,
        'replied_leads', replied_leads,
        'booked_leads', booked_leads,
        'qualified_leads', qualified_leads,
        'followup_leads', followup_leads,
        'unresponded_leads', unresponded_leads,
        'cold_leads', cold_leads,
        'no_comm_leads', no_comm_leads,
        'appts_completed', appts_completed,
        'appts_no_show', appts_no_show,
        'appts_rescheduled', appts_rescheduled,
        'appts_canceled', appts_canceled,
        'total_ai_cost', total_ai_cost,
        'converted_leads', converted_leads
      )
    )
    ORDER BY CASE role WHEN 'setter' THEN 1 WHEN 'closer' THEN 2 ELSE 3 END, name
  ) INTO result
  FROM stats;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
