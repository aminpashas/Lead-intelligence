-- Migration: PII encryption support
-- Adds search hash columns for encrypted PII fields (email, phone)
-- These allow lookups without decrypting all rows

-- Email search hash (HMAC-SHA256, deterministic)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_hash text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_hash text;

-- Indexes for fast lookups by hash
CREATE INDEX IF NOT EXISTS idx_leads_email_hash ON leads(organization_id, email_hash);
CREATE INDEX IF NOT EXISTS idx_leads_phone_hash ON leads(organization_id, phone_hash);

-- Comment for documentation
COMMENT ON COLUMN leads.email_hash IS 'HMAC-SHA256 hash of lowercase email for encrypted lookup';
COMMENT ON COLUMN leads.phone_hash IS 'HMAC-SHA256 hash of E.164 phone for encrypted lookup';
