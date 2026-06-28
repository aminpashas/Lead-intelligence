-- Add TCPA/CAN-SPAM consent tracking fields to leads
-- Required for legal compliance before sending automated SMS/email campaigns

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_source text; -- 'form', 'qualify_form', 'manual', 'import'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_consent boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_consent_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_consent_source text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_opt_out_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_opt_out_at timestamptz;

-- Index for quick consent checks during campaign enrollment
CREATE INDEX IF NOT EXISTS idx_leads_sms_consent ON leads(organization_id, sms_consent) WHERE sms_consent = true AND sms_opt_out = false;
CREATE INDEX IF NOT EXISTS idx_leads_email_consent ON leads(organization_id, email_consent) WHERE email_consent = true AND email_opt_out = false;

COMMENT ON COLUMN leads.sms_consent IS 'TCPA: explicit opt-in consent for automated SMS messages';
COMMENT ON COLUMN leads.email_consent IS 'CAN-SPAM: opt-in consent for marketing emails';
COMMENT ON COLUMN leads.sms_opt_out IS 'Lead has opted out of SMS communications';
COMMENT ON COLUMN leads.email_opt_out IS 'Lead has unsubscribed from email communications';
