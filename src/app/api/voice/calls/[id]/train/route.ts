/**
 * Use a call for AI training — admin-only.
 *
 * POST   /api/voice/calls/[id]/train — distill the call's content into the
 *        org's AI knowledge base (ai_memories + ai_knowledge_articles, the
 *        tables buildLiveAgentKnowledgeBlock injects into live agents).
 * DELETE /api/voice/calls/[id]/train — undo: remove exactly the items this
 *        call created and clear the call's training state.
 *
 * Text source, in order: the stored transcript (Retell provides one for AI
 * calls) → speech-to-text over the Twilio recording (human calls; needs
 * TWILIO_INTELLIGENCE_SERVICE_SID, may return 202 while Twilio transcribes)
 * → the call summary + staff notes as a last resort.
 *
 * Gated on isAdminRole (practice admins + agency admins): extracted entries
 * steer the AI in every patient conversation for this org, so line staff
 * can't push them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg, getOwnProfile } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { toTranscriptLines } from '@/lib/voice/transcript'
import { isTwilioRecordingUrl } from '@/lib/voice/recording-playback'
import { transcribeTwilioRecording, isTranscriptionConfigured } from '@/lib/voice/transcribe'
import { extractCallTraining } from '@/lib/ai/call-training'
import { recordAudit } from '@/lib/audit/record'
import { logger } from '@/lib/logger'

type TrainingItemRef = { type: 'memory' | 'article'; id: string; title: string }

async function requireAdminAndCall(id: string) {
  const authClient = await createClient()
  const {
    data: { user },
  } = await authClient.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await getOwnProfile(authClient, 'id, role, full_name')
  if (!profile || !isAdminRole(profile.role)) {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  }

  const { orgId, role } = await resolveActiveOrg(authClient)
  if (!orgId) {
    return { error: NextResponse.json({ error: 'No organization found' }, { status: 403 }) }
  }

  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select(
      'id, organization_id, transcript, transcript_summary, outcome_notes, recording_url, ended_at, training_status, training_item_ids, metadata'
    )
    .eq('id', id)
    .maybeSingle()

  if (!call || (call.organization_id !== orgId && role !== 'agency_admin')) {
    return { error: NextResponse.json({ error: 'Call not found' }, { status: 404 }) }
  }

  return { supabase, profile, call }
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await requireAdminAndCall(id)
  if ('error' in gate) return gate.error
  const { supabase, profile, call } = gate

  if (!call.ended_at) {
    return NextResponse.json({ error: 'Call is still in progress' }, { status: 422 })
  }
  if (call.training_status === 'added') {
    return NextResponse.json({ status: 'added', items: call.training_item_ids ?? [] })
  }
  if (call.training_status === 'processing') {
    return NextResponse.json({ error: 'Already processing' }, { status: 409 })
  }

  // ── Assemble the call text ──────────────────────────────────────────────
  let lines = toTranscriptLines(call)

  // Human calls carry no transcript — run STT over the Twilio recording.
  if (lines.length === 0 && call.recording_url && isTwilioRecordingUrl(call.recording_url)) {
    if (isTranscriptionConfigured()) {
      const metadata = (call.metadata ?? {}) as Record<string, unknown>
      const result = await transcribeTwilioRecording({
        recordingUrl: call.recording_url,
        existingTranscriptSid: (metadata.intelligence_transcript_sid as string) || null,
      })
      if (result.status === 'processing') {
        // Remember the Twilio transcript so a retry resumes instead of re-paying.
        await supabase
          .from('voice_calls')
          .update({ metadata: { ...metadata, intelligence_transcript_sid: result.transcriptSid } })
          .eq('id', call.id)
        return NextResponse.json(
          { status: 'transcribing', message: 'Recording is being transcribed — try again in a minute.' },
          { status: 202 }
        )
      }
      if (result.status === 'completed' && result.lines.length > 0) {
        lines = result.lines
        // Persist so the call card shows the transcript from now on too.
        await supabase
          .from('voice_calls')
          .update({
            transcript: result.lines,
            metadata: { ...metadata, intelligence_transcript_sid: result.transcriptSid },
          })
          .eq('id', call.id)
      } else if (result.status === 'failed') {
        logger.warn('Call training STT failed, falling back to summary', {
          call_id: call.id,
          error: result.error,
        })
      }
    }
  }

  const callText =
    lines.length > 0
      ? lines.map((l) => `${l.role === 'agent' ? 'Staff' : 'Patient'}: ${l.content}`).join('\n')
      : [call.transcript_summary, call.outcome_notes].filter(Boolean).join('\n\n')

  if (!callText.trim()) {
    return NextResponse.json(
      { error: 'No transcript, summary, or notes available for this call yet.' },
      { status: 422 }
    )
  }

  await supabase.from('voice_calls').update({ training_status: 'processing', training_error: null }).eq('id', call.id)

  // ── Extract + persist ───────────────────────────────────────────────────
  const result = await extractCallTraining(callText)

  if (result.status === 'failed') {
    await supabase
      .from('voice_calls')
      .update({ training_status: 'failed', training_error: result.error })
      .eq('id', call.id)
    return NextResponse.json({ error: 'Extraction failed — try again.' }, { status: 502 })
  }
  if (result.status === 'empty') {
    await supabase
      .from('voice_calls')
      .update({ training_status: 'failed', training_error: 'nothing_extractable' })
      .eq('id', call.id)
    return NextResponse.json(
      { error: 'The call was too short or contained nothing reusable for training.' },
      { status: 422 }
    )
  }

  const items: TrainingItemRef[] = []

  for (const m of result.extraction.memories) {
    const { data, error } = await supabase
      .from('ai_memories')
      .insert({
        organization_id: call.organization_id,
        created_by: profile.id,
        title: m.title,
        category: m.category,
        content: m.content,
        is_enabled: true,
      })
      .select('id')
      .single()
    if (error) logger.error('Call training memory insert failed', { call_id: call.id, error: error.message })
    else items.push({ type: 'memory', id: data.id, title: m.title })
  }

  for (const a of result.extraction.articles) {
    const { data, error } = await supabase
      .from('ai_knowledge_articles')
      .insert({
        organization_id: call.organization_id,
        created_by: profile.id,
        title: a.title,
        category: a.category,
        content: a.content,
        tags: a.tags,
        is_enabled: true,
      })
      .select('id')
      .single()
    if (error) logger.error('Call training article insert failed', { call_id: call.id, error: error.message })
    else items.push({ type: 'article', id: data.id, title: a.title })
  }

  if (items.length === 0) {
    await supabase
      .from('voice_calls')
      .update({ training_status: 'failed', training_error: 'insert_failed' })
      .eq('id', call.id)
    return NextResponse.json({ error: 'Could not save training items.' }, { status: 500 })
  }

  await supabase
    .from('voice_calls')
    .update({
      training_status: 'added',
      training_added_by: profile.id,
      training_added_at: new Date().toISOString(),
      training_item_ids: items,
      training_error: null,
    })
    .eq('id', call.id)

  void recordAudit(supabase, {
    organizationId: call.organization_id,
    action: 'voice_call.used_for_training',
    actor: { actorType: 'user', actorId: profile.id, actorLabel: profile.full_name ?? null },
    source: 'api_route',
    resourceType: 'voice_call',
    resourceId: call.id,
    ai: { autonomous: false, approved_by: profile.id, model: 'claude-sonnet-4-6' },
    metadata: {
      memories: items.filter((i) => i.type === 'memory').length,
      articles: items.filter((i) => i.type === 'article').length,
      titles: items.map((i) => i.title),
    },
  })

  return NextResponse.json({ status: 'added', items })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await requireAdminAndCall(id)
  if ('error' in gate) return gate.error
  const { supabase, profile, call } = gate

  const items = (call.training_item_ids ?? []) as TrainingItemRef[]
  const memoryIds = items.filter((i) => i.type === 'memory').map((i) => i.id)
  const articleIds = items.filter((i) => i.type === 'article').map((i) => i.id)

  if (memoryIds.length > 0) {
    await supabase
      .from('ai_memories')
      .delete()
      .in('id', memoryIds)
      .eq('organization_id', call.organization_id)
  }
  if (articleIds.length > 0) {
    await supabase
      .from('ai_knowledge_articles')
      .delete()
      .in('id', articleIds)
      .eq('organization_id', call.organization_id)
  }

  await supabase
    .from('voice_calls')
    .update({
      training_status: null,
      training_added_by: null,
      training_added_at: null,
      training_item_ids: [],
      training_error: null,
    })
    .eq('id', call.id)

  void recordAudit(supabase, {
    organizationId: call.organization_id,
    action: 'voice_call.training_removed',
    actor: { actorType: 'user', actorId: profile.id, actorLabel: profile.full_name ?? null },
    source: 'api_route',
    resourceType: 'voice_call',
    resourceId: call.id,
    metadata: { removed_memories: memoryIds.length, removed_articles: articleIds.length },
  })

  return NextResponse.json({ status: 'removed' })
}
