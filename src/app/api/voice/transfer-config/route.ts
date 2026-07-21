/**
 * Live-Transfer configuration API (settings UI backend).
 *
 * GET   — load org toggle + hold cap, transfer targets, routes, and live presence.
 * POST  — action-dispatched mutations:
 *           set_org      { enabled?, max_hold_seconds? }   (owner/admin only)
 *           save_target  { id?, name, kind, destination?, user_id?, active?, on_duty?, max_concurrent? }
 *           delete_target{ id }
 *           save_route   { id?, name, priority, active_days, start_hour, end_hour, timezone, target_ids, is_overflow, active? }
 *           delete_route { id }
 *           set_duty     { target_id, on_duty }
 *
 * Target/route CRUD runs on the RLS-scoped auth client (naturally org-isolated).
 * The org toggle is a sensitive gate, so it uses a role check + service client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { logger } from '@/lib/logger'

const ADMIN_ROLES = ['owner', 'admin', 'doctor_admin', 'office_manager', 'agency_admin']

/**
 * Designate (or clear) a target as the office-manager route that active-treatment
 * patients ring — the `metadata.purpose = 'existing_patient'` tag that
 * resolveOfficeManagerTarget() looks for. Enforces one-per-org: turning it on
 * first clears the tag from any sibling so the inbound path never has to guess
 * between two. (Target metadata isn't used for anything else, so clearing it to
 * {} is safe.)
 */
async function applyExistingPatientRoute(
  client: SupabaseClient,
  orgId: string,
  targetId: string,
  on: boolean
): Promise<void> {
  if (on) {
    await client
      .from('voice_transfer_targets')
      .update({ metadata: {} })
      .eq('organization_id', orgId)
      .neq('id', targetId)
      .contains('metadata', { purpose: 'existing_patient' })
    await client
      .from('voice_transfer_targets')
      .update({ metadata: { purpose: 'existing_patient' } })
      .eq('id', targetId)
      .eq('organization_id', orgId)
  } else {
    await client
      .from('voice_transfer_targets')
      .update({ metadata: {} })
      .eq('id', targetId)
      .eq('organization_id', orgId)
  }
}

export async function GET() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  const [{ data: org }, { data: targets }, { data: routes }, { data: presence }] = await Promise.all([
    authClient
      .from('organizations')
      .select('voice_live_transfer_enabled, voice_live_transfer_max_hold_seconds, inbound_call_mode, inbound_ai_on_no_answer, inbound_ai_after_hours, inbound_ring_seconds, inbound_voicemail_greeting')
      .eq('id', orgId)
      .maybeSingle(),
    authClient.from('voice_transfer_targets').select('*').eq('organization_id', orgId).order('created_at'),
    authClient.from('voice_transfer_routes').select('*').eq('organization_id', orgId).order('priority'),
    authClient.from('voice_agent_presence').select('target_id, status, active_calls, updated_at').eq('organization_id', orgId),
  ])

  return NextResponse.json({
    org: org || {
      voice_live_transfer_enabled: false,
      voice_live_transfer_max_hold_seconds: 120,
      inbound_call_mode: 'ai',
      inbound_ai_on_no_answer: false,
      inbound_ai_after_hours: false,
      inbound_ring_seconds: 20,
      inbound_voicemail_greeting: null,
    },
    targets: targets || [],
    routes: routes || [],
    presence: presence || [],
  })
}

export async function POST(request: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  let body: { action?: string; [k: string]: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const action = body.action

  try {
    switch (action) {
      case 'set_org': {
        // Sensitive: arming the whole feature. Owners/admins only, via service client.
        const { data: profile } = await getOwnProfile(authClient, 'role')
        if (!profile || !ADMIN_ROLES.includes(profile.role as string)) {
          return NextResponse.json({ error: 'Only an admin can change this setting' }, { status: 403 })
        }
        const update: Record<string, unknown> = {}
        if (typeof body.enabled === 'boolean') update.voice_live_transfer_enabled = body.enabled
        if (typeof body.max_hold_seconds === 'number') {
          update.voice_live_transfer_max_hold_seconds = Math.max(30, Math.min(600, body.max_hold_seconds))
        }
        // Inbound routing policy (who answers an inbound call — see
        // /api/voice/inbound). Same admin gate: this re-routes live patient calls.
        if (body.inbound_call_mode === 'ai' || body.inbound_call_mode === 'ring_agents') {
          update.inbound_call_mode = body.inbound_call_mode
        }
        if (typeof body.inbound_ai_on_no_answer === 'boolean') update.inbound_ai_on_no_answer = body.inbound_ai_on_no_answer
        if (typeof body.inbound_ai_after_hours === 'boolean') update.inbound_ai_after_hours = body.inbound_ai_after_hours
        if (typeof body.inbound_ring_seconds === 'number') {
          update.inbound_ring_seconds = Math.max(5, Math.min(60, Math.round(body.inbound_ring_seconds)))
        }
        if (typeof body.inbound_voicemail_greeting === 'string') {
          update.inbound_voicemail_greeting = body.inbound_voicemail_greeting.trim().slice(0, 600) || null
        }
        if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
        const svc = createServiceClient()
        const { error } = await svc.from('organizations').update(update).eq('id', orgId)
        if (error) throw error
        logger.info('Live-transfer org setting changed', { orgId, by: user.id, ...update })
        return NextResponse.json({ ok: true })
      }

      case 'save_target': {
        const kind = String(body.kind || 'phone')
        if (!['phone', 'sip', 'softphone_user'].includes(kind)) {
          return NextResponse.json({ error: 'Invalid target kind' }, { status: 400 })
        }
        const row: Record<string, unknown> = {
          organization_id: orgId,
          name: String(body.name || '').trim(),
          kind,
          destination: kind === 'softphone_user' ? null : (body.destination ? String(body.destination).replace(/[\s\-()]/g, '') : null),
          user_id: kind === 'softphone_user' ? (body.user_id || null) : null,
          active: body.active !== false,
          on_duty: body.on_duty !== false,
          max_concurrent: Math.max(1, Number(body.max_concurrent) || 1),
        }
        if (!row.name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
        if ((kind === 'phone' || kind === 'sip') && !row.destination) {
          return NextResponse.json({ error: 'A phone/SIP target needs a destination number' }, { status: 400 })
        }

        if (body.id) {
          const { error } = await authClient.from('voice_transfer_targets').update(row).eq('id', body.id).eq('organization_id', orgId)
          if (error) throw error
          if (typeof body.existing_patient_route === 'boolean') {
            await applyExistingPatientRoute(authClient, orgId, String(body.id), body.existing_patient_route)
          }
          return NextResponse.json({ ok: true, id: body.id })
        }
        const { data: created, error } = await authClient.from('voice_transfer_targets').insert(row).select('id').single()
        if (error) throw error
        // Seed a presence row so the new target is immediately dial-eligible.
        await authClient.from('voice_agent_presence').upsert(
          { organization_id: orgId, target_id: created.id, status: 'available' },
          { onConflict: 'target_id', ignoreDuplicates: true }
        )
        if (body.existing_patient_route === true) {
          await applyExistingPatientRoute(authClient, orgId, String(created.id), true)
        }
        return NextResponse.json({ ok: true, id: created.id })
      }

      case 'set_patient_route': {
        // Toggle an existing target as the office-manager route for active-treatment
        // patients (no need to re-supply name/kind/destination).
        if (!body.target_id) return NextResponse.json({ error: 'target_id required' }, { status: 400 })
        await applyExistingPatientRoute(authClient, orgId, String(body.target_id), !!body.existing_patient_route)
        return NextResponse.json({ ok: true })
      }

      case 'delete_target': {
        if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
        const { error } = await authClient.from('voice_transfer_targets').delete().eq('id', body.id).eq('organization_id', orgId)
        if (error) throw error
        return NextResponse.json({ ok: true })
      }

      case 'set_duty': {
        if (!body.target_id) return NextResponse.json({ error: 'target_id required' }, { status: 400 })
        const { error } = await authClient
          .from('voice_transfer_targets')
          .update({ on_duty: !!body.on_duty })
          .eq('id', body.target_id)
          .eq('organization_id', orgId)
        if (error) throw error
        return NextResponse.json({ ok: true })
      }

      case 'save_route': {
        const row: Record<string, unknown> = {
          organization_id: orgId,
          name: String(body.name || '').trim(),
          priority: Number(body.priority) || 100,
          active_days: Array.isArray(body.active_days) ? body.active_days : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          start_hour: Math.max(0, Math.min(23, Number(body.start_hour) ?? 9)),
          end_hour: Math.max(1, Math.min(24, Number(body.end_hour) ?? 18)),
          timezone: String(body.timezone || 'America/New_York'),
          target_ids: Array.isArray(body.target_ids) ? body.target_ids : [],
          is_overflow: !!body.is_overflow,
          active: body.active !== false,
        }
        if (!row.name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

        if (body.id) {
          const { error } = await authClient.from('voice_transfer_routes').update(row).eq('id', body.id).eq('organization_id', orgId)
          if (error) throw error
          return NextResponse.json({ ok: true, id: body.id })
        }
        const { data: created, error } = await authClient.from('voice_transfer_routes').insert(row).select('id').single()
        if (error) throw error
        return NextResponse.json({ ok: true, id: created.id })
      }

      case 'delete_route': {
        if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
        const { error } = await authClient.from('voice_transfer_routes').delete().eq('id', body.id).eq('organization_id', orgId)
        if (error) throw error
        return NextResponse.json({ ok: true })
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (error) {
    logger.error('transfer-config mutation failed', { action, orgId }, error instanceof Error ? error : undefined)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
