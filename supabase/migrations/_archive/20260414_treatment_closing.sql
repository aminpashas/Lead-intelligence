-- Treatment Closing Workflow
-- Tracks the full closing process from contract signing to surgery day

CREATE TABLE IF NOT EXISTS treatment_closings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Step tracking
  current_step TEXT NOT NULL DEFAULT 'treatment_plan_presented' CHECK (current_step IN (
    'treatment_plan_presented',
    'contract_signed',
    'financing_funded',
    'consent_signed',
    'preop_instructions_sent',
    'surgery_scheduled',
    'records_confirmed'
  )),
  steps_completed TEXT[] NOT NULL DEFAULT '{}',

  -- Contract
  contract_signed_at TIMESTAMPTZ,
  contract_amount DECIMAL(10,2),
  deposit_amount DECIMAL(10,2),
  deposit_collected_at TIMESTAMPTZ,
  non_refundable_acknowledged BOOLEAN NOT NULL DEFAULT false,

  -- Financing
  financing_type TEXT CHECK (financing_type IN ('loan', 'in_house', 'cash', 'insurance')),
  financing_funded_at TIMESTAMPTZ,
  financing_monthly_payment DECIMAL(10,2),

  -- Consent
  consent_signed_at TIMESTAMPTZ,
  consent_forms TEXT[] NOT NULL DEFAULT '{}',

  -- Pre/Post-Op Instructions
  preop_instructions_sent_at TIMESTAMPTZ,
  preop_sent_via TEXT CHECK (preop_sent_via IN ('sms', 'email', 'both')),
  postop_instructions_sent_at TIMESTAMPTZ,

  -- Surgery
  surgery_date DATE,
  surgery_time TIME,
  surgery_type TEXT,
  estimated_duration_hours DECIMAL(4,1),

  -- Records & Office Confirmation
  records_confirmed_at TIMESTAMPTZ,
  records_checklist JSONB NOT NULL DEFAULT '{
    "medical_records": false,
    "dental_records": false,
    "ct_scan": false,
    "prescription_ready": false,
    "surgical_guide_ready": false,
    "lab_work_ordered": false,
    "anesthesia_confirmed": false,
    "surgeon_availability": false
  }',

  -- Metadata
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active closing per lead
  UNIQUE(lead_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_treatment_closings_org ON treatment_closings(organization_id);
CREATE INDEX IF NOT EXISTS idx_treatment_closings_step ON treatment_closings(organization_id, current_step);
CREATE INDEX IF NOT EXISTS idx_treatment_closings_surgery ON treatment_closings(surgery_date) WHERE surgery_date IS NOT NULL;

-- RLS
ALTER TABLE treatment_closings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_read_closings" ON treatment_closings
  FOR SELECT USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "org_admins_manage_closings" ON treatment_closings
  FOR ALL USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid() AND role IN ('owner', 'admin', 'manager')
  ));

CREATE POLICY "service_role_manage_closings" ON treatment_closings
  FOR ALL USING (true);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION update_treatment_closings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_treatment_closings_updated_at
  BEFORE UPDATE ON treatment_closings
  FOR EACH ROW
  EXECUTE FUNCTION update_treatment_closings_updated_at();
