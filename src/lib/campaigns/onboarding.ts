/**
 * Onboarding engine — the CODE side of "LLM writes prose, code decides".
 *
 * `getProfileGaps` computes which required interview answers are still missing
 * for a blueprint; it is the launch gate (the model never decides readiness).
 * `renderBlueprintSteps` fills the launch-time [[profile_vars]] in blueprint
 * copy from the practice profile + org, leaving per-lead {{vars}} for the
 * send-time personalize() pass.
 */

import type { ServiceLineSlug } from '@/lib/validators/practice-profile'
import { CORE_QUESTIONS } from './blueprints/core-pack'
import type { BlueprintStep, CampaignBlueprint, InterviewQuestion } from './blueprints/types'

export interface ProfileGap {
  /** Dot-path of the missing answer (core.* / addon.*). */
  path: string
  /** The interview question that fills it. */
  question: string
}

export interface ProfileShape {
  core: Record<string, unknown>
  addons: Record<string, unknown>
}

function resolvePath(root: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((node, key) => {
    if (typeof node !== 'object' || node === null) return undefined
    return (node as Record<string, unknown>)[key]
  }, root)
}

function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true // numbers and booleans (including false) are answers
}

function addonOf(profile: ProfileShape, slug: ServiceLineSlug): Record<string, unknown> {
  const addon = profile.addons?.[slug]
  return typeof addon === 'object' && addon !== null ? (addon as Record<string, unknown>) : {}
}

/** All interview questions relevant to a blueprint, keyed by profilePath. */
export function questionsFor(blueprint: CampaignBlueprint): Map<string, InterviewQuestion> {
  const map = new Map<string, InterviewQuestion>()
  for (const q of [...CORE_QUESTIONS, ...blueprint.addOnQuestions]) {
    map.set(q.profilePath, q)
  }
  return map
}

/**
 * Which required answers are still missing before this blueprint can launch.
 * Empty array = launch-eligible.
 */
export function getProfileGaps(
  blueprint: CampaignBlueprint,
  profile: ProfileShape
): ProfileGap[] {
  const questions = questionsFor(blueprint)
  const addon = addonOf(profile, blueprint.slug)
  const gaps: ProfileGap[] = []

  for (const path of blueprint.requiredProfileFields) {
    const value = path.startsWith('addon.')
      ? resolvePath(addon, path.slice('addon.'.length))
      : resolvePath(profile.core ?? {}, path.slice('core.'.length))
    if (!isAnswered(value)) {
      gaps.push({ path, question: questions.get(path)?.prompt ?? path })
    }
  }
  return gaps
}

export interface RenderOrgFacts {
  name: string
  phone: string | null
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

function joined(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0) {
    return value.filter((v) => typeof v === 'string').join(', ') || undefined
  }
  return str(value)
}

/**
 * Build the launch-time var map for [[...]] substitution.
 * Standard vars come from org + core; every scalar/array addon answer is also
 * exposed under its own key; blueprint.computeVars can add derived phrases.
 */
export function buildProfileVars(
  blueprint: CampaignBlueprint,
  profile: ProfileShape,
  org: RenderOrgFacts
): Record<string, string> {
  const core = profile.core ?? {}
  const addon = addonOf(profile, blueprint.slug)
  const section = (name: string): Record<string, unknown> => {
    const s = core[name]
    return typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {}
  }

  const vars: Record<string, string | undefined> = {
    practice_name: org.name,
    practice_phone: str(org.phone),
    hours_text: str(section('hours').weekly_text),
    consult_days_text: joined(section('hours').consult_days),
    consult_fee_text: str(section('pricing').consult_fee_text),
    financing_partners: joined(section('technology').financing_partners),
    consult_flow_text: str(section('consult_flow').steps_text),
  }

  for (const [key, value] of Object.entries(addon)) {
    const rendered = joined(value)
    if (rendered !== undefined && typeof value !== 'boolean') vars[key] = rendered
  }

  const computed = blueprint.computeVars?.({ core, addon }) ?? {}

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...vars, ...computed })) {
    if (value !== undefined) result[key] = value
  }
  return result
}

const PROFILE_VAR_RE = /\[\[([a-z0-9_]+)\]\]/g

/**
 * Fill launch-time [[vars]] in every step of a blueprint. Per-lead {{vars}}
 * pass through untouched for send-time personalization. Throws on an
 * unresolved var — launching with holes in the copy is a bug, and the gap
 * gate should have prevented it.
 */
export function renderBlueprintSteps(
  blueprint: CampaignBlueprint,
  profile: ProfileShape,
  org: RenderOrgFacts
): BlueprintStep[] {
  const vars = buildProfileVars(blueprint, profile, org)

  const fill = (text: string, where: string): string =>
    text.replace(PROFILE_VAR_RE, (_, name: string) => {
      const value = vars[name]
      if (value === undefined) {
        throw new Error(`Unresolved blueprint var [[${name}]] in ${where}`)
      }
      return value
    })

  return blueprint.steps.map((step) => ({
    ...step,
    subject: step.subject ? fill(step.subject, `${blueprint.slug} step ${step.step_number} subject`) : undefined,
    body_template: fill(step.body_template, `${blueprint.slug} step ${step.step_number} body`),
  }))
}
