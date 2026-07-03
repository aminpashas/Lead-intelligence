/**
 * Practice profile data access.
 *
 * The profile row (practice_profiles) is the durable artifact of the campaign
 * onboarding interview. Reads pre-seed from what the system already knows
 * (booking_settings hours/timezone) so the AI never asks a question the CRM
 * can already answer; writes are schema-validated partial merges so recording
 * one answer can never clobber another.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deepMergeProfileSection,
  profileCorePatchSchema,
  type ProfileSection,
  type ServiceLineSlug,
} from '@/lib/validators/practice-profile'
import { getBlueprint } from '@/lib/campaigns/blueprints'
import type { ProfileShape } from '@/lib/campaigns/onboarding'

export interface PracticeProfileRow {
  id: string
  organization_id: string
  core: ProfileSection
  addons: Record<string, ProfileSection>
  self_serve_enabled: boolean
  last_interview_at: string | null
}

const PROFILE_SELECT = 'id, organization_id, core, addons, self_serve_enabled, last_interview_at'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "09:00" → "9am", "13:30" → "1:30pm" */
function humanTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isFinite(h)) return hhmm
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour = h % 12 === 0 ? 12 : h % 12
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`
}

/** booking_settings.weekly_schedule ({"1":{start,end},...}, 0=Sun) → "Mon 9am–5pm, ..." */
export function humanizeWeeklySchedule(schedule: Record<string, unknown> | null): string | null {
  if (!schedule) return null
  const parts: string[] = []
  for (let day = 0; day < 7; day++) {
    const slot = schedule[String(day)]
    if (
      typeof slot === 'object' &&
      slot !== null &&
      typeof (slot as Record<string, unknown>).start === 'string' &&
      typeof (slot as Record<string, unknown>).end === 'string'
    ) {
      const { start, end } = slot as { start: string; end: string }
      parts.push(`${WEEKDAYS[day]} ${humanTime(start)}–${humanTime(end)}`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * Fetch the org's profile, creating it on first touch. The initial row is
 * pre-seeded from booking_settings (hours + timezone) when that exists.
 * Tolerates a concurrent create by re-selecting on insert conflict.
 */
export async function getOrCreatePracticeProfile(
  supabase: SupabaseClient,
  orgId: string
): Promise<PracticeProfileRow | null> {
  const { data: existing } = await supabase
    .from('practice_profiles')
    .select(PROFILE_SELECT)
    .eq('organization_id', orgId)
    .maybeSingle<PracticeProfileRow>()
  if (existing) return existing

  const { data: booking } = await supabase
    .from('booking_settings')
    .select('weekly_schedule, timezone')
    .eq('organization_id', orgId)
    .maybeSingle<{ weekly_schedule: Record<string, unknown> | null; timezone: string | null }>()

  const hours: ProfileSection = {}
  const weeklyText = humanizeWeeklySchedule(booking?.weekly_schedule ?? null)
  if (weeklyText) hours.weekly_text = weeklyText
  if (booking?.timezone) hours.timezone = booking.timezone

  const { data: created } = await supabase
    .from('practice_profiles')
    .insert({
      organization_id: orgId,
      core: Object.keys(hours).length > 0 ? { hours } : {},
    })
    .select(PROFILE_SELECT)
    .maybeSingle<PracticeProfileRow>()
  if (created) return created

  // Unique(organization_id) race — someone else created it; re-read.
  const { data: raced } = await supabase
    .from('practice_profiles')
    .select(PROFILE_SELECT)
    .eq('organization_id', orgId)
    .maybeSingle<PracticeProfileRow>()
  return raced
}

export interface ProfileAnswerPatch {
  core?: ProfileSection
  addon?: ProfileSection
  slug?: ServiceLineSlug
}

/**
 * Validate and deep-merge interview answers onto the profile.
 * Returns the updated row, or an error string suitable to hand back to the
 * interview agent as a tool result (so it can re-ask correctly).
 */
export async function mergeProfileAnswers(
  supabase: SupabaseClient,
  orgId: string,
  patch: ProfileAnswerPatch
): Promise<{ profile: PracticeProfileRow } | { error: string }> {
  const current = await getOrCreatePracticeProfile(supabase, orgId)
  if (!current) return { error: 'Could not load the practice profile.' }

  let core = current.core ?? {}
  if (patch.core && Object.keys(patch.core).length > 0) {
    const parsed = profileCorePatchSchema.safeParse(patch.core)
    if (!parsed.success) {
      return { error: `Invalid core answers: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }
    }
    core = deepMergeProfileSection(core, parsed.data as ProfileSection)
  }

  let addons = current.addons ?? {}
  if (patch.addon && Object.keys(patch.addon).length > 0) {
    if (!patch.slug) return { error: 'Addon answers need a service line.' }
    const blueprint = getBlueprint(patch.slug)
    const parsed = blueprint.addonSchema.safeParse(patch.addon)
    if (!parsed.success) {
      return { error: `Invalid ${patch.slug} answers: ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }
    }
    addons = {
      ...addons,
      [patch.slug]: deepMergeProfileSection(
        (addons[patch.slug] as ProfileSection) ?? {},
        parsed.data as ProfileSection
      ),
    }
  }

  const { data: updated, error } = await supabase
    .from('practice_profiles')
    .update({ core, addons, last_interview_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .select(PROFILE_SELECT)
    .maybeSingle<PracticeProfileRow>()

  if (error || !updated) return { error: 'Failed to save answers — try again.' }
  return { profile: updated }
}

export function toProfileShape(row: PracticeProfileRow | null): ProfileShape {
  return { core: row?.core ?? {}, addons: row?.addons ?? {} }
}

const SECTION_LABELS: Record<string, string> = {
  hours: 'Hours',
  operations: 'Operations',
  appointments: 'Appointments',
  consult_flow: 'Consult flow',
  technology: 'Technology',
  pricing: 'Pricing',
  preferences: 'Messaging preferences',
}

function lines(section: ProfileSection): string[] {
  return Object.entries(section)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `  - ${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
}

/**
 * Compact plain-text block of everything the practice told us, for injection
 * into AI system prompts (setter/closer/interview). Empty string when the
 * profile has no content yet.
 */
export function practiceProfileSummary(row: PracticeProfileRow | null): string {
  if (!row) return ''
  const blocks: string[] = []

  for (const [name, label] of Object.entries(SECTION_LABELS)) {
    const section = row.core?.[name]
    if (typeof section === 'object' && section !== null) {
      const body = lines(section as ProfileSection)
      if (body.length > 0) blocks.push(`${label}:\n${body.join('\n')}`)
    }
  }
  for (const [slug, addon] of Object.entries(row.addons ?? {})) {
    if (typeof addon === 'object' && addon !== null) {
      const body = lines(addon as ProfileSection)
      if (body.length > 0) blocks.push(`${slug.replace(/_/g, ' ')} specifics:\n${body.join('\n')}`)
    }
  }

  if (blocks.length === 0) return ''
  return `PRACTICE FACTS (from the practice's own onboarding answers — treat as ground truth, never contradict or improvise beyond them):\n\n${blocks.join('\n\n')}`
}

/**
 * Read-only prompt block for the LIVE agents (setter/closer): the practice's
 * own onboarding answers, so the AI stops improvising hours, technology, and
 * cost framing. '' when the org has no profile yet — never creates a row.
 */
export async function buildPracticeProfileBlock(
  supabase: SupabaseClient,
  orgId: string
): Promise<string> {
  const { data } = await supabase
    .from('practice_profiles')
    .select(PROFILE_SELECT)
    .eq('organization_id', orgId)
    .maybeSingle<PracticeProfileRow>()
  return practiceProfileSummary(data)
}
