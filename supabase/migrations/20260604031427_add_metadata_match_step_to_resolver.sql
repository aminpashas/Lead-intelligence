-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260604031427, which was applied
-- directly to production and had no local file. See docs/MIGRATION_DRIFT.md.
--
-- Supersedes 20260604031317: adds step 3, a per-org override matching
-- source_type against lead_sources.metadata->>'source_type_match', BEFORE the
-- 'Unknown' fallback (now step 4). This is the live definition of
-- resolve_lead_source_id() — verify with:
--   select pg_get_functiondef(oid) from pg_proc where proname='resolve_lead_source_id';
--
-- NOTE for anyone widening source resolution: the escape hatch for a source the
-- enum doesn't cover is a lead_sources row carrying
-- metadata.source_type_match = '<source_type>' — no code change needed. A lead
-- landing in 'Unknown' means no row matched at any of the three steps.

CREATE OR REPLACE FUNCTION resolve_lead_source_id() RETURNS trigger AS $$
DECLARE
  resolved uuid;
BEGIN
  IF NEW.source_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1) Exact UTM match (most specific)
  IF NEW.utm_source IS NOT NULL AND NEW.utm_medium IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(utm_source) = lower(NEW.utm_source)
        AND lower(utm_medium) = lower(NEW.utm_medium)
      LIMIT 1;
  END IF;

  -- 2) source_type matches the lead_sources.type enum
  IF resolved IS NULL AND NEW.source_type IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(type) = lower(NEW.source_type)
      LIMIT 1;
  END IF;

  -- 3) source_type matches a per-org override in metadata.source_type_match
  IF resolved IS NULL AND NEW.source_type IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(metadata->>'source_type_match') = lower(NEW.source_type)
      LIMIT 1;
  END IF;

  -- 4) Fallback: 'Unknown' bucket
  IF resolved IS NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND name = 'Unknown' AND is_active = true
      LIMIT 1;
  END IF;

  NEW.source_id := resolved;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
