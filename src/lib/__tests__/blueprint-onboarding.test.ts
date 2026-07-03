import { describe, it, expect } from 'vitest'
import { getBlueprint, listBlueprints } from '@/lib/campaigns/blueprints'
import {
  getProfileGaps,
  renderBlueprintSteps,
  questionsFor,
  type ProfileShape,
} from '@/lib/campaigns/onboarding'

const ORG = { name: 'Dion Health SF', phone: '(415) 555-0100' }

/** A core profile with every launch-required core answer filled. */
function fullCore(): Record<string, unknown> {
  return {
    hours: { weekly_text: 'Mon–Fri 8am–5pm', consult_days: ['Tuesday', 'Thursday'] },
    appointments: { consult_duration_minutes: 90, types: ['in_person', 'virtual'] },
    consult_flow: { steps_text: '3D CBCT scan, exam with the doctor, same-day treatment plan and financial review' },
    technology: { financing_partners: ['Cherry', 'Proceed'] },
    pricing: {
      consult_fee_text: '$150, credited toward treatment',
      financing_posture: 'financing-first, never quote totals by text',
    },
    preferences: { never_say: ['cheap', 'discount'] },
  }
}

function fullProfileFor(slug: string): ProfileShape {
  const addons: Record<string, Record<string, unknown>> = {
    implants: {
      case_scope: 'single tooth through full-arch All-on-X, grafting in-house',
      same_day_teeth: true,
      price_band_text: 'Full-arch cases typically start in the low $20Ks per arch.',
    },
    veneers: {
      min_units_text: 'We design in sets of 6–10 uppers for a balanced result.',
      smile_design_text: 'Digital smile preview, trial smile you approve, final porcelain from our master lab — usually 3 visits.',
      price_band_text: 'Most cases run per-tooth in the four figures; exact number at your design consult.',
    },
    tmj: {
      treatments_text: 'custom orthotics/splints, Botox therapy, bite adjustment; surgical cases referred',
      referral_required: false,
      insurance_text: 'We bill medical insurance where possible and provide a superbill otherwise.',
    },
    sleep_apnea: {
      home_sleep_test: true,
      pathway_text: 'Home sleep test arranged through our physician partner, board-certified read, custom appliance, titration follow-ups.',
      insurance_text: 'Oral appliances are typically billed to MEDICAL insurance; we verify benefits before you commit.',
    },
  }
  return { core: fullCore(), addons: { [slug]: addons[slug] } }
}

describe('blueprint registry integrity', () => {
  it('has four v1 blueprints', () => {
    expect(listBlueprints().map((b) => b.slug).sort()).toEqual([
      'implants',
      'sleep_apnea',
      'tmj',
      'veneers',
    ])
  })

  it('every required field maps to a real interview question', () => {
    for (const bp of listBlueprints()) {
      const questions = questionsFor(bp)
      for (const path of bp.requiredProfileFields) {
        expect(questions.has(path), `${bp.slug}: no question fills ${path}`).toBe(true)
      }
    }
  })

  it('a fully-answered profile renders every blueprint with no unresolved vars', () => {
    for (const bp of listBlueprints()) {
      const steps = renderBlueprintSteps(bp, fullProfileFor(bp.slug), ORG)
      expect(steps.length).toBe(bp.steps.length)
      for (const step of steps) {
        expect(step.body_template).not.toMatch(/\[\[/)
        expect(step.subject ?? '').not.toMatch(/\[\[/)
      }
    }
  })
})

describe('getProfileGaps', () => {
  it('reports every required field for an empty profile', () => {
    const bp = getBlueprint('implants')
    const gaps = getProfileGaps(bp, { core: {}, addons: {} })
    expect(gaps.map((g) => g.path).sort()).toEqual([...bp.requiredProfileFields].sort())
    expect(gaps[0].question.length).toBeGreaterThan(0)
  })

  it('shrinks as answers land and hits zero when complete', () => {
    const bp = getBlueprint('implants')
    const partial: ProfileShape = { core: fullCore(), addons: {} }
    const partialGaps = getProfileGaps(bp, partial)
    expect(partialGaps.map((g) => g.path)).toEqual([
      'addon.case_scope',
      'addon.same_day_teeth',
      'addon.price_band_text',
    ])
    expect(getProfileGaps(bp, fullProfileFor('implants'))).toEqual([])
  })

  it('treats false booleans as answered', () => {
    const bp = getBlueprint('tmj')
    const profile = fullProfileFor('tmj')
    ;(profile.addons.tmj as Record<string, unknown>).referral_required = false
    expect(getProfileGaps(bp, profile).map((g) => g.path)).not.toContain('addon.referral_required')
  })

  it('treats empty strings and empty arrays as unanswered', () => {
    const bp = getBlueprint('implants')
    const profile = fullProfileFor('implants')
    ;(profile.core.hours as Record<string, unknown>).weekly_text = '  '
    ;(profile.core.technology as Record<string, unknown>).financing_partners = []
    const paths = getProfileGaps(bp, profile).map((g) => g.path)
    expect(paths).toContain('core.hours.weekly_text')
    expect(paths).toContain('core.technology.financing_partners')
  })
})

describe('renderBlueprintSteps', () => {
  it('fills profile vars and leaves lead vars for send time', () => {
    const bp = getBlueprint('implants')
    const steps = renderBlueprintSteps(bp, fullProfileFor('implants'), ORG)
    expect(steps[0].body_template).toContain('Dion Health SF')
    expect(steps[0].body_template).toContain('{{first_name}}')
    const moneyStep = steps.find((s) => s.name.startsWith('Money'))!
    expect(moneyStep.body_template).toContain('low $20Ks')
    expect(moneyStep.body_template).toContain('Cherry, Proceed')
  })

  it('throws on an unresolved var instead of sending copy with holes', () => {
    const bp = getBlueprint('implants')
    const profile = fullProfileFor('implants')
    delete (profile.addons.implants as Record<string, unknown>).price_band_text
    expect(() => renderBlueprintSteps(bp, profile, ORG)).toThrow(/price_band_text/)
  })

  it('renders sleep computed hint from the boolean answer', () => {
    const bp = getBlueprint('sleep_apnea')
    const steps = renderBlueprintSteps(bp, fullProfileFor('sleep_apnea'), ORG)
    const checkIn = steps.find((s) => s.name === 'Soft check-in')!
    expect(checkIn.body_template).toContain('home sleep test')
  })
})
