import { describe, it, expect } from 'vitest'
import {
  routedIntakeStageSlug,
  isPaidOnlyIntakeOrg,
  paidOnlyIntakeOrgIds,
} from '@/lib/leads/intake-routing'

const SF = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const OTHER = '11111111-1111-1111-1111-111111111111'
const on = { NEW_LEAD_PAID_ONLY_ORG_IDS: SF } as unknown as NodeJS.ProcessEnv
const off = {} as NodeJS.ProcessEnv

describe('paidOnlyIntakeOrgIds', () => {
  it('parses, trims, lower-cases, and drops blanks', () => {
    const env = { NEW_LEAD_PAID_ONLY_ORG_IDS: ` ${SF.toUpperCase()} , , ${OTHER} ` } as unknown as NodeJS.ProcessEnv
    expect(paidOnlyIntakeOrgIds(env)).toEqual(new Set([SF, OTHER]))
  })
  it('is empty when unset', () => {
    expect(paidOnlyIntakeOrgIds(off).size).toBe(0)
  })
})

describe('isPaidOnlyIntakeOrg', () => {
  it('matches case-insensitively', () => {
    expect(isPaidOnlyIntakeOrg(SF.toUpperCase(), on)).toBe(true)
  })
  it('rejects orgs not on the list', () => {
    expect(isPaidOnlyIntakeOrg(OTHER, on)).toBe(false)
  })
})

describe('routedIntakeStageSlug', () => {
  it('keeps default stage for every org when the allowlist is unset', () => {
    expect(routedIntakeStageSlug(SF, 'seo_organic', off)).toBeNull()
    expect(routedIntakeStageSlug(SF, null, off)).toBeNull()
  })

  it('never reroutes a non-allowlisted org', () => {
    expect(routedIntakeStageSlug(OTHER, 'seo_organic', on)).toBeNull()
    expect(routedIntakeStageSlug(OTHER, null, on)).toBeNull()
  })

  it('keeps paid Google/Meta leads on New Lead', () => {
    expect(routedIntakeStageSlug(SF, 'ppc_google', on)).toBeNull()
    expect(routedIntakeStageSlug(SF, 'ppc_meta', on)).toBeNull()
  })

  it('routes non-paid channels to nurturing', () => {
    for (const ch of ['seo_organic', 'seo_gmb', 'social_fb', 'referral', 'direct']) {
      expect(routedIntakeStageSlug(SF, ch, on)).toBe('nurturing')
    }
  })

  it('routes unresolved/null channels to nurturing (the imported-DB case)', () => {
    expect(routedIntakeStageSlug(SF, null, on)).toBe('nurturing')
    expect(routedIntakeStageSlug(SF, undefined, on)).toBe('nurturing')
    expect(routedIntakeStageSlug(SF, '', on)).toBe('nurturing')
  })
})
