/**
 * Practice profile — zod schemas + merge semantics.
 *
 * The profile is the durable artifact of the campaign-onboarding interview
 * (practice_profiles table): `core` = facts shared by every campaign type,
 * `addons` = per-service-line answers keyed by blueprint slug. Writes are
 * always PARTIAL patches validated here and applied with
 * `deepMergeProfileSection` (intake-bag pattern), so recording one answer can
 * never clobber another. Arrays and scalars replace wholesale; `null` deletes.
 */

import { z } from 'zod'

export const SERVICE_LINE_SLUGS = ['implants', 'veneers', 'tmj', 'sleep_apnea'] as const
export type ServiceLineSlug = (typeof SERVICE_LINE_SLUGS)[number]
export const serviceLineSlugSchema = z.enum(SERVICE_LINE_SLUGS)

// Every field optional + nullable: patches are partial, and null means "delete
// this answer" (handled by deepMergeProfileSection).
const text = z.string().max(2000).nullish()
const shortText = z.string().max(400).nullish()
const bool = z.boolean().nullish()
const textArray = z.array(z.string().max(400)).max(50).nullish()

export const profileCorePatchSchema = z
  .object({
    hours: z
      .object({
        timezone: shortText,
        weekly_text: text, // humanized, e.g. "Mon–Thu 8–5, Fri 8–1"
        consult_days: textArray, // days doctors actually do consults
      })
      .strict()
      .partial(),
    operations: z
      .object({
        phone_coverage: text, // who answers, when
        same_day_policy: text,
        walk_ins: bool,
        notes: text,
      })
      .strict()
      .partial(),
    appointments: z
      .object({
        consult_duration_minutes: z.number().int().min(5).max(480).nullish(),
        types: z.array(z.enum(['in_person', 'virtual', 'phone'])).max(3).nullish(),
        lead_time_days: z.number().int().min(0).max(90).nullish(),
      })
      .strict()
      .partial(),
    consult_flow: z
      .object({
        steps_text: text, // what actually happens, in order
        run_by: shortText, // doctor / TC / hygienist…
        imaging: shortText, // e.g. CBCT same-visit
        sedation_offered: bool,
      })
      .strict()
      .partial(),
    technology: z
      .object({
        ehr: shortText,
        imaging: shortText,
        financing_partners: textArray,
        booking_system: shortText,
      })
      .strict()
      .partial(),
    pricing: z
      .object({
        consult_fee_text: shortText, // "$150, credited toward treatment"
        price_range_text: z.record(z.string(), z.string().max(400)).nullish(), // by service slug
        financing_posture: text,
        insurance_stance: text,
      })
      .strict()
      .partial(),
    preferences: z
      .object({
        must_mention: textArray,
        never_say: textArray,
        tone_notes: text,
        testimonial_url: z.string().url().max(500).nullish(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial()

export type ProfileCorePatch = z.infer<typeof profileCorePatchSchema>

/** A profile section tree: plain JSON objects at every level. */
export type ProfileSection = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge `patch` onto `existing` without mutating either.
 * Plain objects merge recursively; arrays and scalars replace wholesale;
 * an explicit `null` in the patch deletes the key.
 */
export function deepMergeProfileSection(
  existing: ProfileSection,
  patch: ProfileSection
): ProfileSection {
  const result: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMergeProfileSection(result[key] as ProfileSection, value)
    } else if (isPlainObject(value)) {
      // New subtree — still strip null "deletes" inside it.
      result[key] = deepMergeProfileSection({}, value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}
