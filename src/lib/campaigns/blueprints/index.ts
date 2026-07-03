/**
 * Blueprint registry — the single place service-line campaign blueprints are
 * looked up. Adding a new service line = add its file + one entry here.
 */

import type { ServiceLineSlug } from '@/lib/validators/practice-profile'
import type { CampaignBlueprint } from './types'
import { implantsBlueprint } from './implants'
import { veneersBlueprint } from './veneers'
import { tmjBlueprint } from './tmj'
import { sleepApneaBlueprint } from './sleep-apnea'

const REGISTRY: Record<ServiceLineSlug, CampaignBlueprint> = {
  implants: implantsBlueprint,
  veneers: veneersBlueprint,
  tmj: tmjBlueprint,
  sleep_apnea: sleepApneaBlueprint,
}

export function getBlueprint(slug: ServiceLineSlug): CampaignBlueprint {
  return REGISTRY[slug]
}

export function listBlueprints(): CampaignBlueprint[] {
  return Object.values(REGISTRY)
}

/** Stable idempotency key for the campaign a blueprint launches (per org). */
export function blueprintSystemKey(slug: ServiceLineSlug): string {
  return `blueprint:${slug}`
}

export type { CampaignBlueprint, BlueprintStep, InterviewQuestion } from './types'
