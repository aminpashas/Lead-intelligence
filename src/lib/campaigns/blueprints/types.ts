/**
 * Campaign blueprint types — the "foundational core" of a service-line campaign.
 *
 * A blueprint is the versioned, code-owned definition of everything a campaign
 * type needs: the step sequence, the audience criteria, the interview questions
 * that must be answered about the practice before launch, and the guardrails
 * injected into AI personalization. Blueprints live in git (one file per
 * service line) so campaign changes are reviewed like code — the same reasoning
 * as templates.ts and post-consult-nurture.ts.
 *
 * Two merge-var vocabularies appear in step copy, resolved at different times:
 *   {{first_name}}  — per-LEAD vars, resolved at send time by personalize()
 *   [[consult_fee_text]] — per-PRACTICE vars, resolved at LAUNCH from the
 *                          practice profile (square brackets so the two phases
 *                          can never collide).
 */

import type { z } from 'zod'
import type { ServiceLineSlug } from '@/lib/validators/practice-profile'

export type InterviewQuestionKind = 'text' | 'choice' | 'boolean' | 'hours' | 'money'

export interface InterviewQuestion {
  /** Stable id, unique within its pack. */
  id: string
  /**
   * Dot-path the answer lands at: `core.<section>.<field>` for the shared pack,
   * `addon.<field>` for a blueprint's own questions.
   */
  profilePath: string
  /** The question as the AI should raise it (guidance, not a rigid script). */
  prompt: string
  kind: InterviewQuestionKind
  choices?: string[]
  /** Required questions gate launch via requiredProfileFields. */
  required: boolean
}

export interface BlueprintStep {
  step_number: number
  name: string
  channel: 'sms' | 'email'
  /** Delay from the previous step (or from enrollment for step 1), in minutes. */
  delay_minutes: number
  subject?: string
  /**
   * Copy skeleton. May contain {{lead_vars}} (send-time) and [[profile_vars]]
   * (launch-time). When ai_personalize is true this is the fallback copy and
   * the per-lead AI pass composes the real message with the blueprint
   * guardrails + practice profile in context.
   */
  body_template: string
  ai_personalize: boolean
  send_condition?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface CampaignBlueprint {
  slug: ServiceLineSlug
  name: string
  description: string
  /** Bump when steps change; recorded in campaign metadata at launch. */
  version: number
  steps: BlueprintStep[]
  /** Default audience criteria (same vocabulary as campaigns.target_criteria). */
  targetCriteria: Record<string, unknown>
  /** Service-line questions layered on top of the shared core pack. */
  addOnQuestions: InterviewQuestion[]
  /** Validates addon patches for this line (answers live at addons[slug]). */
  addonSchema: z.ZodTypeAny
  /**
   * Dot-paths (core.* / addon.*) that must be answered before launch.
   * This list — checked by code, never the model — is the launch gate.
   */
  requiredProfileFields: string[]
  /** Injected into AI personalization + the live setter for this line's leads. */
  guardrails: string[]
  /**
   * Optional derived launch-time vars (e.g. a phrase that only appears when a
   * boolean addon answer is true). Merged over the standard var map; values
   * may be '' (renders as nothing).
   */
  computeVars?: (args: {
    core: Record<string, unknown>
    addon: Record<string, unknown>
  }) => Record<string, string>
  /** Labels surfaced on the campaign analytics card (existing stats columns). */
  kpis: string[]
}
