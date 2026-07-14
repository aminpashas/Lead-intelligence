/**
 * Per-campaign read / update / archive.
 *
 *   GET    — fetch one campaign *with its steps* (used to pre-fill the builder
 *            in edit mode and to render the activation preview).
 *   PATCH  — update a campaign. Accepts either the lightweight
 *            `{ prequal_mode }` control (unchanged from before) OR a full
 *            campaign edit (name / description / type / channel / audience /
 *            steps). Steps use replace-all semantics. The playbook is jsonb, so
 *            `prequal_mode` is read-merge-written to avoid clobbering the
 *            campaign's goal/tone/hooks/guardrails.
 *   DELETE — archive a campaign (soft delete: status → 'archived'). An *active*
 *            campaign must be paused first (409) so we never yank the audience
 *            out from under an in-flight send.
 *
 * All handlers are org-scoped. Mutations mirror the create route's guard
 * (`campaigns:write` via requirePermission), honoring an agency admin's entered
 * client account (matches RLS get_user_org_id()).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg, requirePermission } from '@/lib/auth/active-org'
import type { CampaignPlaybook } from '@/types/database'
import { z } from 'zod'

const PREQUAL_MODES = ['inherit', 'enabled', 'disabled'] as const

// Mirrors the step shape accepted by the create route (POST /api/campaigns).
const stepSchema = z.object({
  step_number: z.number(),
  name: z.string().optional(),
  channel: z.enum(['sms', 'email']),
  delay_minutes: z.number().min(0),
  delay_type: z.enum(['after_previous', 'after_enrollment', 'specific_time']).optional(),
  subject: z.string().optional(),
  body_template: z.string().min(1),
  ai_personalize: z.boolean().optional(),
  send_condition: z.record(z.string(), z.unknown()).optional(),
  exit_condition: z.record(z.string(), z.unknown()).optional(),
})

// A superset schema: the lightweight prequal control and the full edit share one
// endpoint. Every field is optional; we branch on what's present. Mirrors the
// create schema (createCampaignSchema) so edit and create can't drift.
const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  type: z.enum(['drip', 'broadcast', 'trigger']).optional(),
  channel: z.enum(['sms', 'email', 'multi']).optional(),
  smart_list_id: z.string().uuid().nullable().optional(),
  target_criteria: z.record(z.string(), z.unknown()).nullable().optional(),
  send_window: z
    .object({
      start_hour: z.number().min(0).max(23).optional(),
      end_hour: z.number().min(0).max(23).optional(),
      timezone: z.string().optional(),
      days: z.array(z.number()).optional(),
    })
    .nullable()
    .optional(),
  prequal_mode: z.enum(PREQUAL_MODES).optional(),
  steps: z.array(stepSchema).optional(),
})

// GET /api/campaigns/[id] — one campaign with its steps (org-scoped read).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(*)')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  return NextResponse.json({ campaign })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Editing a campaign is agency-side; mirror the create route's guard.
  const guard = await requirePermission(supabase, 'campaigns:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = updateCampaignSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { steps, prequal_mode, ...fields } = parsed.data

  // Nothing to do — reject rather than silently no-op.
  if (steps === undefined && prequal_mode === undefined && Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  // Read the existing row (org-scoped) so we can 404 cleanly and merge the
  // jsonb playbook rather than overwrite it.
  const { data: existing } = await supabase
    .from('campaigns')
    .select('playbook')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single<{ playbook: CampaignPlaybook | null }>()

  if (!existing) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  // Build the column updates. Only set what the caller sent.
  const updates: Record<string, unknown> = { ...fields }
  if (prequal_mode !== undefined) {
    updates.playbook = { ...(existing.playbook ?? {}), prequal_mode }
  }

  if (Object.keys(updates).length > 0) {
    const { error: updateError } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', orgId)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update campaign' }, { status: 500 })
    }
  }

  // Steps: replace-all. Delete the campaign's steps (org-scoped), then re-insert.
  if (steps !== undefined) {
    const { error: deleteError } = await supabase
      .from('campaign_steps')
      .delete()
      .eq('campaign_id', id)
      .eq('organization_id', orgId)

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to replace campaign steps' }, { status: 500 })
    }

    if (steps.length > 0) {
      const { error: insertError } = await supabase
        .from('campaign_steps')
        .insert(steps.map((step) => ({ ...step, campaign_id: id, organization_id: orgId })))

      if (insertError) {
        return NextResponse.json({ error: 'Failed to replace campaign steps' }, { status: 500 })
      }
    }
  }

  // Return the updated campaign with steps so the client can refresh in place.
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(*)')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  return NextResponse.json({ success: true, campaign })
}

// DELETE /api/campaigns/[id] — archive (soft delete). Requires the campaign to
// be paused/draft; an active campaign returns 409 so a live send is never
// silently torn down.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const guard = await requirePermission(supabase, 'campaigns:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const { data: existing } = await supabase
    .from('campaigns')
    .select('status')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single<{ status: string }>()

  if (!existing) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (existing.status === 'active') {
    return NextResponse.json(
      { error: 'Pause the campaign before deleting it.', code: 'campaign_active' },
      { status: 409 }
    )
  }

  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'archived' })
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return NextResponse.json({ error: 'Failed to delete campaign' }, { status: 500 })

  return NextResponse.json({ success: true })
}
