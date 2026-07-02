import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { getTreatmentClosingByCase } from '@/lib/treatment/treatment-closing'
import {
  getSdlConfig,
  createSdlCase,
  prepareSdlFileUpload,
  toSdlFileKind,
  SdlApiError,
} from '@/lib/lab/sdl-client'

export const maxDuration = 120

/**
 * POST /api/cases/[id]/lab-order — submit the case's records to Smile Design
 * Lab: creates the SDL case (patient + lab slip), streams the case files
 * (STL / CBCT / photos) to SDL's signed upload URLs, records a lab_orders row,
 * and flips records_checklist.lab_work_ordered.
 */

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:create')) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const config = await getSdlConfig(supabase, orgId)
  if (!config) {
    return NextResponse.json(
      { error: 'Smile Design Lab is not connected for this practice (Settings → Connectors)' },
      { status: 412 }
    )
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select(`
      id, organization_id, lead_id, patient_name, patient_email, patient_phone,
      case_number, chief_complaint,
      case_files (id, file_name, file_url, file_size, mime_type, file_type),
      case_treatment_plans (id, plan_summary)
    `)
    .eq('id', caseId)
    .eq('organization_id', orgId)
    .single()
  if (!caseRow) return NextResponse.json({ error: 'Case not found' }, { status: 404 })

  // One active lab order per case
  const { data: existing } = await supabase
    .from('lab_orders')
    .select('id, status')
    .eq('clinical_case_id', caseId)
    .not('status', 'in', '("cancelled","error")')
    .limit(1)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'A lab order already exists for this case', lab_order_id: existing.id }, { status: 409 })
  }

  const closing = await getTreatmentClosingByCase(supabase, caseId)

  // Patient DOB: SDL requires it. Pull from the lead if available.
  let dob: string | null = null
  if (caseRow.lead_id) {
    const { data: lead } = await supabase
      .from('leads')
      .select('date_of_birth')
      .eq('id', caseRow.lead_id)
      .single()
    dob = (lead?.date_of_birth as string | null) ?? null
  }
  if (!dob) {
    return NextResponse.json(
      { error: 'Patient date of birth is required to open a lab case — add it to the lead first' },
      { status: 422 }
    )
  }

  const nameParts = caseRow.patient_name.trim().split(/\s+/)
  const firstName = nameParts[0] ?? 'Unknown'
  const lastName = nameParts.slice(1).join(' ') || '—'

  // Create the lab_orders row first (status draft) so a partial failure is visible
  const { data: order, error: orderError } = await supabase
    .from('lab_orders')
    .insert({
      organization_id: orgId,
      clinical_case_id: caseId,
      treatment_closing_id: closing?.id ?? null,
      lab_provider: 'smile_design_lab',
      status: 'draft',
      items: [{ kind: 'surgical_guide', description: closing?.surgery_type ?? caseRow.chief_complaint }],
      submitted_by: user.id,
    })
    .select()
    .single()
  if (orderError || !order) {
    return NextResponse.json({ error: orderError?.message ?? 'Could not create lab order' }, { status: 500 })
  }

  try {
    // 1. Create + submit the SDL case
    const sdlCase = await createSdlCase(config, {
      patient: {
        firstName,
        lastName,
        dateOfBirth: dob,
        email: caseRow.patient_email ?? undefined,
        phoneE164: caseRow.patient_phone ?? undefined,
        externalCode: caseRow.case_number,
        consentToShareWithLab: true,
      },
      case: {
        caseType: 'surgical_guide',
        urgency: 'standard',
        doctorNotes: [
          `LI case ${caseRow.case_number}: ${caseRow.chief_complaint}`,
          Array.isArray(caseRow.case_treatment_plans) && caseRow.case_treatment_plans[0]?.plan_summary
            ? `Plan: ${caseRow.case_treatment_plans[0].plan_summary}`
            : null,
          closing?.surgery_date ? `Surgery date: ${closing.surgery_date}` : null,
        ].filter(Boolean).join('\n'),
      },
      labSlip: {
        additionalInstructions: `Records for ${closing?.surgery_type ?? 'implant surgery'} — submitted from Lead Intelligence.`,
      },
    })

    // 2. Stream case files to SDL (best-effort per file; report what landed)
    const files = Array.isArray(caseRow.case_files) ? caseRow.case_files : []
    const filesSent: Array<{ case_file_id: string; file_name: string; file_type: string; sent_at: string }> = []
    const fileErrors: string[] = []

    for (const f of files) {
      try {
        // file_url points into the case-files bucket; download via storage API
        const pathMatch = String(f.file_url).match(/case-files\/(.+)$/)
        if (!pathMatch) throw new Error('unrecognized storage URL')
        const { data: blob, error: dlError } = await supabase.storage
          .from('case-files')
          .download(pathMatch[1])
        if (dlError || !blob) throw new Error(dlError?.message ?? 'download failed')

        const bytes = Buffer.from(await blob.arrayBuffer())
        const prep = await prepareSdlFileUpload(config, sdlCase.caseId, {
          kind: toSdlFileKind(f.file_type),
          fileName: f.file_name,
          sizeBytes: bytes.byteLength,
          mimeType: f.mime_type ?? undefined,
        })
        const put = await fetch(prep.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': f.mime_type ?? 'application/octet-stream',
            Authorization: `Bearer ${prep.uploadToken}`,
          },
          body: bytes,
          signal: AbortSignal.timeout(60_000),
        })
        if (!put.ok) throw new Error(`upload HTTP ${put.status}`)
        filesSent.push({
          case_file_id: f.id,
          file_name: f.file_name,
          file_type: f.file_type,
          sent_at: new Date().toISOString(),
        })
      } catch (err) {
        fileErrors.push(`${f.file_name}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }

    // 3. Record the submission
    await supabase
      .from('lab_orders')
      .update({
        status: 'submitted',
        external_case_id: sdlCase.caseId,
        external_case_number: sdlCase.caseNumber,
        files_sent: filesSent,
        error: fileErrors.length ? `Some files failed: ${fileErrors.join('; ')}` : null,
        submitted_at: new Date().toISOString(),
        status_history: [{ from: 'draft', to: 'submitted', at: new Date().toISOString() }],
      })
      .eq('id', order.id)

    // 4. Records checklist: lab work is ordered
    if (closing) {
      await supabase
        .from('treatment_closings')
        .update({ records_checklist: { ...closing.records_checklist, lab_work_ordered: true } })
        .eq('id', closing.id)
    }

    return NextResponse.json({
      lab_order_id: order.id,
      sdl_case_id: sdlCase.caseId,
      sdl_case_number: sdlCase.caseNumber,
      files_sent: filesSent.length,
      file_errors: fileErrors,
    }, { status: 201 })
  } catch (err) {
    const message = err instanceof SdlApiError ? err.message : err instanceof Error ? err.message : 'SDL submission failed'
    await supabase
      .from('lab_orders')
      .update({ status: 'error', error: message })
      .eq('id', order.id)
    return NextResponse.json({ error: message, lab_order_id: order.id }, { status: 502 })
  }
}
