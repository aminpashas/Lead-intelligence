-- ============================================================
-- Seed Default Financing Lender Configs
--
-- Seeds link-based lenders (Sunbit, Cherry, Proceed Finance)
-- for every organization that has no lender configs yet.
--
-- These require ZERO API credentials — they generate prefilled
-- application URLs and send them to patients via SMS/email.
-- The waterfall will immediately produce results with these.
--
-- Run once in Supabase SQL Editor for the Lead Intelligence project.
-- Safe to re-run (uses ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO financing_lender_configs (
  organization_id,
  lender_slug,
  display_name,
  integration_type,
  is_active,
  priority_order,
  config,
  credentials_encrypted
)
SELECT
  o.id AS organization_id,
  l.lender_slug,
  l.display_name,
  l.integration_type,
  TRUE AS is_active,
  l.priority_order,
  l.config,
  NULL AS credentials_encrypted   -- link-based lenders need no credentials
FROM organizations o
CROSS JOIN (
  VALUES
    -- Sunbit: highest approval rate (~90%), dental specialty, link-based
    (
      'sunbit'::text,
      'Sunbit'::text,
      'link'::text,
      1,
      '{"application_url": "https://sunbit.com/apply", "promo_months": 6}'::jsonb
    ),
    -- Cherry: dental specialty, accepts fair/poor credit, link-based
    (
      'cherry'::text,
      'Cherry'::text,
      'link'::text,
      2,
      '{"application_url": "https://withcherry.com/apply", "promo_months": 12}'::jsonb
    ),
    -- Proceed Finance: multi-lender network, largest amounts, link-based
    (
      'proceed'::text,
      'Proceed Finance'::text,
      'link'::text,
      3,
      '{"application_url": "https://www.proceedfinance.com/apply", "max_amount": 200000}'::jsonb
    )
) AS l(lender_slug, display_name, integration_type, priority_order, config)
-- Only seed orgs that have NO lender configs at all
WHERE NOT EXISTS (
  SELECT 1
  FROM financing_lender_configs flc
  WHERE flc.organization_id = o.id
)
ON CONFLICT (organization_id, lender_slug) DO NOTHING;

-- ── Verification ──────────────────────────────────────────────
-- Run this to confirm seeding worked:
SELECT
  o.name AS organization,
  flc.lender_slug,
  flc.display_name,
  flc.integration_type,
  flc.priority_order,
  flc.is_active
FROM financing_lender_configs flc
JOIN organizations o ON o.id = flc.organization_id
ORDER BY o.name, flc.priority_order;
