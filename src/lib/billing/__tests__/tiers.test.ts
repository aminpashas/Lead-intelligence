import { describe, it, expect } from 'vitest'
import {
  TIERS,
  TIER_ORDER,
  PER_SEAT_CENTS,
  isTierId,
  getTier,
  tierHasCapability,
  billableSeats,
  monthlyPlatformCents,
  METERED_SERVICES,
  METER_EVENT_NAME,
  buildSubscriptionItems,
  TIER_LIMITS,
  effectiveTierId,
  limitsForSubscriptionTier,
} from '@/lib/billing/tiers'

describe('tier ladder', () => {
  it('prices the three tiers at $199 / $399 / $699', () => {
    expect(TIERS.basic.baseFeeCents).toBe(19_900)
    expect(TIERS.growth.baseFeeCents).toBe(39_900)
    expect(TIERS.full.baseFeeCents).toBe(69_900)
  })

  it('includes 1 / 3 / 5 seats and $50 per extra everywhere', () => {
    expect(TIERS.basic.includedSeats).toBe(1)
    expect(TIERS.growth.includedSeats).toBe(3)
    expect(TIERS.full.includedSeats).toBe(5)
    for (const id of TIER_ORDER) expect(TIERS[id].perSeatCents).toBe(PER_SEAT_CENTS)
    expect(PER_SEAT_CENTS).toBe(5_000)
  })

  it('funnels to the middle: only Growth is Most Popular, and the Basic→Growth gap is smaller than Growth→Full', () => {
    expect(TIERS.growth.mostPopular).toBe(true)
    expect(TIERS.basic.mostPopular).toBeUndefined()
    expect(TIERS.full.mostPopular).toBeUndefined()
    const gapUp = TIERS.growth.baseFeeCents - TIERS.basic.baseFeeCents
    const gapOut = TIERS.full.baseFeeCents - TIERS.growth.baseFeeCents
    expect(gapUp).toBeLessThan(gapOut)
  })
})

describe('capability gates', () => {
  it('withholds autopilot from Basic (the middle-tier funnel lever) but grants it from Growth up', () => {
    expect(tierHasCapability('basic', 'ai_autopilot')).toBe(false)
    expect(tierHasCapability('growth', 'ai_autopilot')).toBe(true)
    expect(tierHasCapability('full', 'ai_autopilot')).toBe(true)
  })

  it('reserves AI voice, API access, and HIPAA BAA for Full', () => {
    for (const cap of ['ai_voice', 'api_access', 'hipaa_baa'] as const) {
      expect(tierHasCapability('basic', cap)).toBe(false)
      expect(tierHasCapability('growth', cap)).toBe(false)
      expect(tierHasCapability('full', cap)).toBe(true)
    }
  })

  it('grants AI drafts on every tier', () => {
    for (const id of TIER_ORDER) expect(tierHasCapability(id, 'ai_drafts')).toBe(true)
  })
})

describe('billableSeats', () => {
  it('is zero at or below the included allotment', () => {
    expect(billableSeats('growth', 1)).toBe(0)
    expect(billableSeats('growth', 3)).toBe(0)
  })

  it('charges only the seats beyond the allotment', () => {
    expect(billableSeats('growth', 5)).toBe(2)
    expect(billableSeats('basic', 4)).toBe(3)
    expect(billableSeats('full', 8)).toBe(3)
  })

  it('never goes negative for tiny practices', () => {
    expect(billableSeats('full', 0)).toBe(0)
  })
})

describe('monthlyPlatformCents', () => {
  it('is the flat base fee when seats fit', () => {
    expect(monthlyPlatformCents('growth', 3)).toBe(39_900)
  })

  it('adds $50 per extra seat on top of the base fee', () => {
    // Growth base $399 + 2 extra seats × $50 = $499
    expect(monthlyPlatformCents('growth', 5)).toBe(39_900 + 2 * 5_000)
  })
})

describe('metered services', () => {
  it('meters exactly ai / sms / voice / email with stable event names', () => {
    expect(METERED_SERVICES).toEqual(['ai', 'sms', 'voice', 'email'])
    expect(METER_EVENT_NAME).toEqual({
      ai: 'li_usage_ai',
      sms: 'li_usage_sms',
      voice: 'li_usage_voice',
      email: 'li_usage_email',
    })
  })
})

describe('isTierId / getTier', () => {
  it('recognizes sellable tier ids and rejects legacy/trial', () => {
    expect(isTierId('growth')).toBe(true)
    expect(isTierId('starter')).toBe(false)
    expect(isTierId('trial')).toBe(false)
  })
  it('returns the tier object', () => {
    expect(getTier('full').name).toBe('Full')
  })
})

describe('buildSubscriptionItems', () => {
  const fullEnv = {
    STRIPE_PRICE_BASIC: 'price_basic',
    STRIPE_PRICE_GROWTH: 'price_growth',
    STRIPE_PRICE_FULL: 'price_full',
    STRIPE_PRICE_SEAT: 'price_seat',
    STRIPE_PRICE_METER_AI: 'price_m_ai',
    STRIPE_PRICE_METER_SMS: 'price_m_sms',
    STRIPE_PRICE_METER_VOICE: 'price_m_voice',
    STRIPE_PRICE_METER_EMAIL: 'price_m_email',
  }

  it('emits base (qty 1) + 4 metered items (no quantity) when no extra seats', () => {
    const items = buildSubscriptionItems('growth', 0, fullEnv)
    expect(items[0]).toEqual({ price: 'price_growth', quantity: 1 })
    // no seat line
    expect(items.some((i) => i.price === 'price_seat')).toBe(false)
    const metered = items.filter((i) => i.price.startsWith('price_m_'))
    expect(metered).toHaveLength(4)
    expect(metered.every((i) => i.quantity === undefined)).toBe(true)
  })

  it('adds the seat line with quantity when there are extra seats', () => {
    const items = buildSubscriptionItems('growth', 2, fullEnv)
    expect(items).toContainEqual({ price: 'price_seat', quantity: 2 })
  })

  it('throws loudly when a metered price is unconfigured (never silently drops usage billing)', () => {
    const { STRIPE_PRICE_METER_VOICE: _omit, ...missingVoice } = fullEnv
    expect(() => buildSubscriptionItems('growth', 0, missingVoice)).toThrow(/STRIPE_PRICE_METER_VOICE/)
  })

  it('throws when the tier base price is unconfigured', () => {
    const { STRIPE_PRICE_FULL: _omit, ...missingFull } = fullEnv
    expect(() => buildSubscriptionItems('full', 0, missingFull)).toThrow(/STRIPE_PRICE_FULL/)
  })
})

describe('plan quotas', () => {
  it('caps Basic at one brand and one live campaign', () => {
    expect(TIER_LIMITS.basic).toEqual({ maxBrands: 1, maxCampaigns: 1 })
  })

  it('gives Growth three brands and three live campaigns, Full unlimited', () => {
    expect(TIER_LIMITS.growth).toEqual({ maxBrands: 3, maxCampaigns: 3 })
    expect(TIER_LIMITS.full).toEqual({ maxBrands: null, maxCampaigns: null })
  })

  it('maps legacy tiers onto the ladder and treats trial/unknown as Full', () => {
    expect(effectiveTierId('starter')).toBe('basic')
    expect(effectiveTierId('professional')).toBe('growth')
    expect(effectiveTierId('enterprise')).toBe('full')
    expect(effectiveTierId('trial')).toBe('full')
    expect(effectiveTierId(null)).toBe('full')
    expect(effectiveTierId('growth')).toBe('growth')
  })

  it('resolves limits straight from the subscription_tier string', () => {
    expect(limitsForSubscriptionTier('basic').maxBrands).toBe(1)
    expect(limitsForSubscriptionTier('trial').maxBrands).toBeNull()
  })
})
