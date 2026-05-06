/**
 * Bulk lead import — POST /api/leads/import
 *
 * Accepts a JSON payload with parsed CSV rows + import-wide consent attestation
 * + defaults + post-actions. The client (lead-csv-import.tsx) parses the file
 * with papaparse, maps headers to canonical field names, then posts here.
 *
 * Consent fields are stamped from the wrapper attestation, with per-row override.
 * The consent_log trigger from migration 023 auto-appends SMS+email rows on INSERT;
 * voice consent is logged manually since the trigger predates the voice columns.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { bulkImportRequestSchema, bulkImportLeadSchema } from '@/lib/validators/lead'
import { encryptLeadPII } from '@/lib/encryption'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import { safeParseBody, BULK_IMPORT_MAX_BODY_SIZE } from '@/lib/body-size'
import { formatToE164 } from '@/lib/leads/phone'
import { findExistingLeads } from '@/lib/leads/dedupe'
import { scoreLead } from '@/lib/ai/scoring'
import { logger } from '@/lib/logger'

const CHUNK_SIZE = 100
const SCORING_CONCURRENCY = 8

type FailedRow = { row: number; error: string }

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: body, error: bodyError } = await safeParseBody(request, BULK_IMPORT_MAX_BODY_SIZE)
  if (bodyError) return bodyError

  const parsed = bulkImportRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { rows, consent, defaults, post_actions, dedupe } = parsed.data
  const orgId = profile.organization_id

  // Resolve default pipeline stage once
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_default', true)
    .single()

  // ---- Validate + normalize each row ---------------------------------
  type PreparedRow = {
    sourceIndex: number
    insert: Record<string, unknown>
    rawEmail: string | null
    rawPhoneFormatted: string | null
  }

  const prepared: PreparedRow[] = []
  const failed: FailedRow[] = []

  rows.forEach((raw, idx) => {
    const rowParsed = bulkImportLeadSchema.safeParse(raw)
    if (!rowParsed.success) {
      const issues = rowParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      failed.push({ row: idx + 1, error: issues || 'Validation failed' })
      return
    }
    const row = rowParsed.data

    // Require at least one contact channel (the importer can't message a
    // lead without phone or email, and we don't want orphan rows).
    if (!row.phone && !row.email) {
      failed.push({ row: idx + 1, error: 'Row has neither phone nor email' })
      return
    }

    const phoneFormatted = formatToE164(row.phone)
    if (row.phone && !phoneFormatted) {
      failed.push({ row: idx + 1, error: `Invalid phone format: ${row.phone}` })
      return
    }

    const email = row.email && row.email !== '' ? row.email : null

    // Stamp consent from attestation, with per-row override
    const smsConsent = row.sms_consent ?? consent.sms
    const emailConsent = row.email_consent ?? consent.email
    const voiceConsent = row.voice_consent ?? consent.voice

    const insert: Record<string, unknown> = {
      ...row,
      organization_id: orgId,
      stage_id: defaultStage?.id ?? null,
      email,
      phone_formatted: phoneFormatted,
      // Consent state
      sms_consent: smsConsent,
      email_consent: emailConsent,
      voice_consent: voiceConsent,
      sms_consent_at: smsConsent ? (row.sms_consent_at || consent.attested_at) : null,
      email_consent_at: emailConsent ? (row.email_consent_at || consent.attested_at) : null,
      voice_consent_at: voiceConsent ? (row.voice_consent_at || consent.attested_at) : null,
      sms_consent_source: smsConsent ? (row.sms_consent_source || consent.source) : null,
      email_consent_source: emailConsent ? (row.email_consent_source || consent.source) : null,
      voice_consent_source: voiceConsent ? (row.voice_consent_source || consent.source) : null,
      do_not_call: row.do_not_call ?? false,
      // Source / assignment / tags from import-wide defaults
      source_type: row.source_type || defaults.source_type || null,
      source_id: row.source_id || defaults.source_id || null,
      assigned_to: row.assigned_to || defaults.assigned_to || null,
      tags: defaults.tags && defaults.tags.length > 0
        ? Array.from(new Set([...(row.tags || []), ...defaults.tags]))
        : (row.tags || null),
    }

    prepared.push({
      sourceIndex: idx,
      insert,
      rawEmail: email,
      rawPhoneFormatted: phoneFormatted,
    })
  })

  if (prepared.length === 0) {
    return NextResponse.json({
      inserted: 0,
      skipped_duplicates: 0,
      failed,
      lead_ids: [],
    })
  }

  // ---- Dedupe against existing leads ---------------------------------
  const existingMatches = await findExistingLeads(
    supabase,
    orgId,
    prepared.map((p) => ({ email: p.rawEmail, phone_formatted: p.rawPhoneFormatted })),
  )

  // Map preparedIndex (0..N-1) → existing lead match
  const dupCounts = { skipped: 0, overwritten: 0 }
  const insertable: PreparedRow[] = []
  const overwriteUpdates: Array<{ existingId: string; row: PreparedRow }> = []

  prepared.forEach((row, pIdx) => {
    const match = existingMatches.get(pIdx)
    if (!match) {
      insertable.push(row)
      return
    }
    if (dedupe === 'skip') {
      dupCounts.skipped += 1
      return
    }
    if (dedupe === 'overwrite') {
      overwriteUpdates.push({ existingId: match.id, row })
      dupCounts.overwritten += 1
      return
    }
    // 'allow' — insert anyway
    insertable.push(row)
  })

  // ---- Bulk insert in chunks -----------------------------------------
  const insertedIds: string[] = []

  for (let i = 0; i < insertable.length; i += CHUNK_SIZE) {
    const chunk = insertable.slice(i, i + CHUNK_SIZE)
    const encrypted = chunk.map((p) => encryptLeadPII(p.insert))

    const { data: inserted, error } = await supabase
      .from('leads')
      .insert(encrypted)
      .select('id')

    if (error) {
      // Mark every row in the failed chunk
      chunk.forEach((p) => {
        failed.push({ row: p.sourceIndex + 1, error: error.message })
      })
      logger.error('Bulk import: chunk insert failed', { orgId, chunkStart: i, error: error.message })
      continue
    }

    if (inserted) {
      for (const r of inserted) insertedIds.push(r.id)
    }
  }

  // ---- Overwrite path (rare; only when dedupe='overwrite') -----------
  // Update the contact + consent fields in place. Audit log captures the change.
  for (const { existingId, row } of overwriteUpdates) {
    const encrypted = encryptLeadPII({ ...row.insert })
    // Keep the original organization_id and stage_id — don't relocate the lead.
    delete (encrypted as Record<string, unknown>).organization_id
    delete (encrypted as Record<string, unknown>).stage_id

    const { error } = await supabase
      .from('leads')
      .update(encrypted)
      .eq('id', existingId)
      .eq('organization_id', orgId)

    if (error) {
      failed.push({ row: row.sourceIndex + 1, error: `Overwrite failed: ${error.message}` })
    } else {
      insertedIds.push(existingId)
    }
  }

  // ---- Bulk activity rows --------------------------------------------
  if (insertedIds.length > 0) {
    const activityRows = insertedIds.map((leadId) => ({
      organization_id: orgId,
      lead_id: leadId,
      activity_type: 'created',
      title: 'Lead imported',
      description: `Bulk imported from ${defaults.file_name || consent.source}`,
      metadata: {
        import: true,
        source: consent.source,
        attested_by: profile.id,
      },
    }))
    await supabase.from('lead_activities').insert(activityRows)
  }

  // ---- Voice consent_log (trigger doesn't cover voice) ---------------
  // consent_log has no user INSERT policy — the SMS/email trigger fires under
  // SECURITY DEFINER, but voice rows are written directly here, so use the
  // service client to bypass RLS the same way the trigger does.
  if (consent.voice && insertedIds.length > 0) {
    const voiceLogRows = insertedIds.map((leadId) => ({
      organization_id: orgId,
      lead_id: leadId,
      channel: 'voice',
      consent_given: true,
      granted_at: consent.attested_at,
      source: consent.source,
      actor_user_id: profile.id,
    }))
    const service = createServiceClient()
    const { error: voiceLogError } = await service.from('consent_log').insert(voiceLogRows)
    if (voiceLogError) {
      logger.warn('Bulk import: voice consent_log insert failed', { orgId, error: voiceLogError.message })
    }
  }

  // ---- Import audit row in events -----------------------------------
  await supabase.from('events').insert({
    organization_id: orgId,
    event_type: 'leads_bulk_imported',
    payload: {
      file_name: defaults.file_name || null,
      total_rows: rows.length,
      inserted: insertedIds.length,
      skipped_duplicates: dupCounts.skipped,
      overwritten: dupCounts.overwritten,
      failed: failed.length,
      consent: {
        sms: consent.sms,
        email: consent.email,
        voice: consent.voice,
        source: consent.source,
        attested_at: consent.attested_at,
        attested_by_user_id: profile.id,
      },
      tags: defaults.tags || [],
      assigned_to: defaults.assigned_to || null,
    },
    capi_status: 'na',
    gads_status: 'na',
  })

  if (insertedIds.length > 0) {
    auditPHIWrite(
      { supabase, organizationId: orgId, actorId: profile.id },
      'lead',
      `bulk_import:${insertedIds.length}`,
      `Bulk imported ${insertedIds.length} leads from ${consent.source}`,
    )
  }

  // ---- Tag assignment (lead_tags many-to-many) ----------------------
  // The leads.tags array column above stores tag *names* for the legacy
  // smart-list path; here we ALSO ensure rows in lead_tags so the structured
  // tag UI surfaces the import.
  if (defaults.tags && defaults.tags.length > 0 && insertedIds.length > 0) {
    await ensureLeadTags(supabase, orgId, profile.id, insertedIds, defaults.tags)
  }

  // ---- Post-actions: scoring + campaign enrollment ------------------
  // Both run synchronously per spec but with bounded concurrency.
  // For 2,000 leads this can be slow; the UI shows a progress indicator
  // and the response only returns after they finish so the user has a
  // single source of truth for "import done."

  if (post_actions.score && insertedIds.length > 0) {
    await runWithConcurrency(insertedIds, SCORING_CONCURRENCY, async (leadId) => {
      try {
        const { data: lead } = await supabase
          .from('leads')
          .select('*')
          .eq('id', leadId)
          .eq('organization_id', orgId)
          .single()
        if (!lead) return
        const score = await scoreLead(lead)
        await supabase.from('leads').update({
          ai_score: score.total_score,
          ai_qualification: score.qualification,
          ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
          ai_score_updated_at: new Date().toISOString(),
          ai_summary: score.summary,
        }).eq('id', leadId)
      } catch (err) {
        logger.warn('Bulk import: scoring failed for lead', { leadId, err: err instanceof Error ? err.message : 'unknown' })
      }
    })
  }

  if (post_actions.enroll_campaign_id && insertedIds.length > 0) {
    const enrollRows = insertedIds.map((leadId) => ({
      organization_id: orgId,
      campaign_id: post_actions.enroll_campaign_id,
      lead_id: leadId,
      status: 'active',
      next_step_at: new Date().toISOString(),
    }))
    // upsert ignores duplicates if the lead is already enrolled
    await supabase.from('campaign_enrollments').upsert(enrollRows, {
      onConflict: 'campaign_id,lead_id',
      ignoreDuplicates: true,
    })
  }

  return NextResponse.json({
    inserted: insertedIds.length,
    skipped_duplicates: dupCounts.skipped,
    overwritten: dupCounts.overwritten,
    failed,
    lead_ids: insertedIds,
  })
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function ensureLeadTags(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  actorId: string,
  leadIds: string[],
  tagNames: string[],
) {
  // Resolve tags by slug; create any that don't exist yet
  const slugs = tagNames.map(slugify)

  const { data: existing } = await supabase
    .from('tags')
    .select('id, slug')
    .eq('organization_id', orgId)
    .in('slug', slugs)

  const bySlug = new Map<string, string>()
  for (const t of existing || []) bySlug.set(t.slug, t.id)

  const missing = tagNames.filter((name) => !bySlug.has(slugify(name)))
  if (missing.length > 0) {
    const newRows = missing.map((name) => ({
      organization_id: orgId,
      name,
      slug: slugify(name),
      created_by: actorId,
    }))
    const { data: created } = await supabase
      .from('tags')
      .insert(newRows)
      .select('id, slug')
    for (const t of created || []) bySlug.set(t.slug, t.id)
  }

  const tagIds = Array.from(bySlug.values())
  const junctionRows = leadIds.flatMap((leadId) =>
    tagIds.map((tagId) => ({
      organization_id: orgId,
      lead_id: leadId,
      tag_id: tagId,
      tagged_by: actorId,
    })),
  )

  if (junctionRows.length > 0) {
    // unique index on (lead_id, tag_id) — ignore conflicts
    await supabase.from('lead_tags').upsert(junctionRows, {
      onConflict: 'lead_id,tag_id',
      ignoreDuplicates: true,
    })
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}
