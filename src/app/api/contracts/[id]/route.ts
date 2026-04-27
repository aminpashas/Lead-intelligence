import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import type { RenderedContractSection } from '@/types/database'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export const runtime = 'nodejs'

async function requireOrgUser(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile) return { error: NextResponse.json({ error: 'Profile not found' }, { status: 404 }) }
  return { supabase, user, profile }
}

/** GET /api/contracts/[id] — full contract + event timeline + clinical context for staff review UI. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireOrgUser(request)
  if ('error' in ctx) return ctx.error
  if (!hasPermission(ctx.profile.role, 'contracts:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const { data: contract, error } = await ctx.supabase
    .from('patient_contracts')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.profile.organization_id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: caseRow } = await ctx.supabase
    .from('clinical_cases')
    .select('id, case_number, patient_name, patient_email, patient_phone, chief_complaint')
    .eq('id', contract.clinical_case_id)
    .single()

  const { data: events } = await ctx.supabase
    .from('contract_events')
    .select('id, event_type, actor_type, actor_id, payload, created_at')
    .eq('contract_id', id)
    .order('created_at', { ascending: false })

  return NextResponse.json({
    contract,
    case: caseRow,
    events: events ?? [],
  })
}

/**
 * PATCH /api/contracts/[id]
 * Body: either
 *   { section_edits: [{ section_id, rendered_text }] } to edit content, or
 *   { review_notes } / { status: 'changes_requested' } to update review state.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireOrgUser(request)
  if ('error' in ctx) return ctx.error
  if (!hasPermission(ctx.profile.role, 'contracts:generate')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const { data: contract } = await ctx.supabase
    .from('patient_contracts')
    .select('id, organization_id, status, generated_content')
    .eq('id', id)
    .eq('organization_id', ctx.profile.organization_id)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const terminal = ['sent', 'viewed', 'signed', 'executed', 'expired', 'voided']
  if (terminal.includes(contract.status)) {
    return NextResponse.json({ error: `Cannot edit contract in status ${contract.status}` }, { status: 409 })
  }

  const updates: Record<string, unknown> = {}
  const actions: string[] = []

  if (Array.isArray(body.section_edits)) {
    const current = (contract.generated_content ?? []) as RenderedContractSection[]
    const editsById = new Map<string, { rendered_text: string }>(
      body.section_edits.map((e: { section_id: string; rendered_text: string }) => [
        String(e.section_id),
        { rendered_text: String(e.rendered_text ?? '') },
      ])
    )
    const updated = current.map((s) => {
      const edit = editsById.get(s.section_id)
      if (!edit) return s
      const paragraphs = edit.rendered_text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
      const html = paragraphs
        .map(
          (p) =>
            '<p>' +
            p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br />') +
            '</p>'
        )
        .join('\n')
      return {
        ...s,
        rendered_text: edit.rendered_text,
        rendered_html: html,
        ai_generated: false,
      }
    })
    updates.generated_content = updated
    updates.needs_manual_draft = false
    actions.push('edited')
  }

  if (body.status === 'changes_requested') {
    if (!hasPermission(ctx.profile.role, 'contracts:approve')) {
      return NextResponse.json({ error: 'Forbidden: approvers only' }, { status: 403 })
    }
    updates.status = 'changes_requested'
    updates.review_notes = body.review_notes ?? null
    updates.reviewer_id = ctx.user.id
    updates.reviewed_at = new Date().toISOString()
    actions.push('changes_requested')
  } else if (body.review_notes !== undefined) {
    updates.review_notes = body.review_notes
  }

  const { error: updErr, data: updated } = await ctx.supabase
    .from('patient_contracts')
    .update(updates)
    .eq('id', id)
    .select('id, status')
    .single()
  if (updErr || !updated) {
    return NextResponse.json({ error: updErr?.message ?? 'update failed' }, { status: 500 })
  }

  for (const action of actions) {
    await logContractEvent(ctx.supabase, {
      organization_id: contract.organization_id,
      contract_id: contract.id,
      event_type: action,
      actor_type: 'user',
      actor_id: ctx.user.id,
      payload: body,
    })
  }

  return NextResponse.json({ contract: updated })
}

/** DELETE /api/contracts/[id] — void a contract that hasn't been signed. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireOrgUser(request)
  if ('error' in ctx) return ctx.error
  if (!hasPermission(ctx.profile.role, 'contracts:void')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const { data: contract } = await ctx.supabase
    .from('patient_contracts')
    .select('id, organization_id, status')
    .eq('id', id)
    .eq('organization_id', ctx.profile.organization_id)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (['signed', 'executed'].includes(contract.status)) {
    return NextResponse.json(
      { error: 'Signed contracts cannot be voided' },
      { status: 409 }
    )
  }

  const { error: updErr } = await ctx.supabase
    .from('patient_contracts')
    .update({ status: 'voided' })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  await logContractEvent(ctx.supabase, {
    organization_id: contract.organization_id,
    contract_id: contract.id,
    event_type: 'voided',
    actor_type: 'user',
    actor_id: ctx.user.id,
  })
  await logHIPAAEvent(ctx.supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_voided',
    severity: 'info',
    actor_type: 'user',
    actor_id: ctx.user.id,
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: 'Contract voided by staff',
  })

  return NextResponse.json({ ok: true })
}
