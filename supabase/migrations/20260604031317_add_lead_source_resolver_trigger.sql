-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260604031317, which was applied
-- directly to production and had no local file. See docs/MIGRATION_DRIFT.md.
--
-- This is the trigger that populates leads.source_id, and its step-3 'Unknown'
-- fallback is why a lead with no matching lead_sources row shows the "Unknown"
-- bucket rather than NULL (traced 2026-07-21 on a doctor-referral lead whose real
-- origin survived only in the free-text utm_source). Superseded on the same day by
-- 20260604031427, which inserts a metadata.source_type_match step before the
-- fallback — keep both so a replay reproduces the live definition.

-- Resolves lead_sources.id from utm_source/utm_medium/source_type on INSERT.
-- Idempotent: respects an explicitly-set source_id.
CREATE OR REPLACE FUNCTION resolve_lead_source_id() RETURNS trigger AS $$
DECLARE
  resolved uuid;
BEGIN
  IF NEW.source_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1) Most specific: both UTM source AND medium match a configured row
  IF NEW.utm_source IS NOT NULL AND NEW.utm_medium IS NOT NULL THEN
    SELECT id INTO resolved
      FROM lead_sources
      WHERE organization_id = NEW.organization_id
        AND is_active = true
        AND lower(utm_source) = lower(NEW.utm_source)
        AND lower(utm_medium) = lower(NEW.utm_medium)
      LIMIT 1;
  END IF;

  -- 2) source_type matches a row's type enum (e.g. source_type='website_form' → Website Form)
  IF resolved IS NULL AND NEW.source_type IS NOT NULL THEN
    SELECT id INTO resolved
      FROM lead_sources
      WHERE organization_id = NEW.organization_id
        AND is_active = true
        AND lower(type) = lower(NEW.source_type)
      LIMIT 1;
  END IF;

  -- 3) Fallback: the org's 'Unknown' bucket
  IF resolved IS NULL THEN
    SELECT id INTO resolved
      FROM lead_sources
      WHERE organization_id = NEW.organization_id
        AND name = 'Unknown'
        AND is_active = true
      LIMIT 1;
  END IF;

  NEW.source_id := resolved;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resolve_lead_source ON leads;
CREATE TRIGGER trg_resolve_lead_source
  BEFORE INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION resolve_lead_source_id();

-- One-time backfill of existing leads
UPDATE leads l
SET source_id = COALESCE(
  -- exact UTM match
  (SELECT id FROM lead_sources s
    WHERE s.organization_id = l.organization_id
      AND s.is_active = true
      AND l.utm_source IS NOT NULL
      AND l.utm_medium IS NOT NULL
      AND lower(s.utm_source) = lower(l.utm_source)
      AND lower(s.utm_medium) = lower(l.utm_medium)
    LIMIT 1),
  -- source_type match
  (SELECT id FROM lead_sources s
    WHERE s.organization_id = l.organization_id
      AND s.is_active = true
      AND l.source_type IS NOT NULL
      AND lower(s.type) = lower(l.source_type)
    LIMIT 1),
  -- Unknown fallback
  (SELECT id FROM lead_sources s
    WHERE s.organization_id = l.organization_id
      AND s.name = 'Unknown'
      AND s.is_active = true
    LIMIT 1)
)
WHERE source_id IS NULL;
