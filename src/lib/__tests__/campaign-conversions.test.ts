import { describe, it, expect } from 'vitest'
import {
  isConvertedLeadStatus,
  countConvertedByCampaign,
  CONVERTED_LEAD_STATUSES,
} from '@/lib/campaigns/reconcile-conversions'

describe('isConvertedLeadStatus', () => {
  it('treats the closed-won lifecycle statuses as conversions', () => {
    for (const s of CONVERTED_LEAD_STATUSES) expect(isConvertedLeadStatus(s)).toBe(true)
  })

  it('does not treat mid-funnel or negative statuses as conversions', () => {
    for (const s of ['new', 'contacted', 'qualified', 'consultation_scheduled', 'treatment_presented', 'financing', 'contract_sent', 'lost', 'disqualified']) {
      expect(isConvertedLeadStatus(s)).toBe(false)
    }
    expect(isConvertedLeadStatus(null)).toBe(false)
    expect(isConvertedLeadStatus(undefined)).toBe(false)
  })
})

describe('countConvertedByCampaign', () => {
  it('counts converted leads per campaign', () => {
    const counts = countConvertedByCampaign([
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'contract_signed' },
      { campaign_id: 'c1', lead_id: 'l2', lead_status: 'completed' },
      { campaign_id: 'c1', lead_id: 'l3', lead_status: 'qualified' }, // not converted
      { campaign_id: 'c2', lead_id: 'l4', lead_status: 'in_treatment' },
    ])
    expect(counts.get('c1')).toBe(2)
    expect(counts.get('c2')).toBe(1)
  })

  it('counts each lead at most once per campaign (re-enrollment safe)', () => {
    const counts = countConvertedByCampaign([
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'contract_signed' },
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'contract_signed' }, // duplicate enrollment
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'scheduled' },
    ])
    expect(counts.get('c1')).toBe(1)
  })

  it('but counts the same converted lead once in each distinct campaign', () => {
    const counts = countConvertedByCampaign([
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'completed' },
      { campaign_id: 'c2', lead_id: 'l1', lead_status: 'completed' },
    ])
    expect(counts.get('c1')).toBe(1)
    expect(counts.get('c2')).toBe(1)
  })

  it('ignores rows with a null campaign or lead id', () => {
    const counts = countConvertedByCampaign([
      { campaign_id: null, lead_id: 'l1', lead_status: 'completed' },
      { campaign_id: 'c1', lead_id: null, lead_status: 'completed' },
    ])
    expect(counts.size).toBe(0)
  })

  it('returns an empty map when nothing converted', () => {
    const counts = countConvertedByCampaign([
      { campaign_id: 'c1', lead_id: 'l1', lead_status: 'new' },
    ])
    expect(counts.size).toBe(0)
  })
})
