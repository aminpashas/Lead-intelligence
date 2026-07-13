import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignPlaybook } from '@/types/database'
import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'

/**
 * Per-campaign playbook → system-prompt block.
 *
 * A campaign's `playbook` (goal/tone/hooks/offer/guardrails/donts) is the
 * "this specific outreach's intent" layer. It sits BELOW agency rules (which are
 * hard, cross-practice constraints) but steers voice and objective for the
 * conversation the lead is actually in. Different campaigns = different
 * strategies, which is the whole point of scoping behavior per campaign.
 *
 * Mirrors buildAgencyRulesBlock: a pure formatter + an async resolver. Empty-safe
 * — returns '' when the lead is in no active campaign or the playbook is blank,
 * so the live prompt is byte-identical to today until a campaign sets one.
 */

/** Pure formatter: renders a playbook into a prompt block. Empty-safe. */
export function formatCampaignPlaybookBlock(playbook: CampaignPlaybook | null | undefined): string {
  if (!playbook) return ''

  const lines: string[] = []
  if (playbook.goal) lines.push(`**Goal:** ${playbook.goal}`)
  if (playbook.tone) lines.push(`**Tone:** ${playbook.tone}`)
  if (playbook.offer) lines.push(`**Offer:** ${playbook.offer}`)
  if (playbook.hooks?.length) {
    lines.push(`**Hooks you can lean on:**\n${playbook.hooks.map((h) => `- ${h}`).join('\n')}`)
  }
  if (playbook.guardrails?.length) {
    lines.push(`**Guardrails (stay within these):**\n${playbook.guardrails.map((g) => `- ${g}`).join('\n')}`)
  }
  if (playbook.donts?.length) {
    lines.push(`**Do NOT:**\n${playbook.donts.map((d) => `- ${d}`).join('\n')}`)
  }
  if (playbook.objection_notes) lines.push(`**Objection notes:** ${playbook.objection_notes}`)

  if (lines.length === 0) return ''

  return (
    `## Campaign Playbook\n` +
    `This lead is in an active campaign with the following intent. Follow it for goal and voice, ` +
    `but agency rules and safety/consent guidance above always win when they conflict:\n\n` +
    lines.join('\n\n')
  )
}

/**
 * Resolve the lead's active-campaign playbook and render it for the LIVE
 * setter/closer agents. Returns '' when there's no active campaign or no
 * meaningful playbook. Uses whatever client is passed (service role in the
 * webhook path, so RLS is bypassed) — same convention as buildAgencyRulesBlock.
 */
export async function buildCampaignPlaybookBlock(
  supabase: SupabaseClient,
  leadId: string | undefined,
  organizationId: string
): Promise<string> {
  if (!leadId) return ''
  const policy = await resolveActiveCampaignPolicy(supabase, leadId, organizationId)
  return formatCampaignPlaybookBlock(policy?.playbook ?? null)
}
