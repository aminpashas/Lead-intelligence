import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { executeSignedContract } from '@/lib/contracts/pdf-execute'
import { logHIPAAEvent } from '@/lib/ai/hipaa'
import type { ContractTemplateSection } from '@/types/database'

export const runtime = 'nodejs'
export const maxDuration = 60

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

const MAX_SIGNATURE_BYTES = 64 * 1024

function isValidSignatureDataUrl(s: string | null | undefined): boolean {
  if (!s) return false
  if (!s.startsWith('data:image/png;base64,')) return false
  // Rough byte-length estimate from base64 length
  const b64 = s.slice('data:image/png;base64,'.length)
  const bytes = Math.ceil((b64.length * 3) / 4)
  return bytes <= MAX_SIGNATURE_BYTES
}

/**
 * POST /api/contracts/patient/[shareToken]/sign
 * Public. Records the signature + consents and kicks off the async PDF execute worker.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const supabase = getServiceSupabase()
  const body = await request.json().catch(() => ({}))

  const signerName = String(body.signer_name ?? '').trim()
  const signatureType = body.signature_type === 'typed' ? 'typed' : 'drawn'
  const signatureDataUrl = typeof body.signature_data_url === 'string' ? body.signature_data_url : null
  const consentsFromClient = Array.isArray(body.consents_agreed) ? body.consents_agreed : []

  if (!signerName) {
    return NextResponse.json({ error: 'signer_name is required' }, { status: 400 })
  }
  if (signatureType === 'drawn' && !isValidSignatureDataUrl(signatureDataUrl)) {
    return NextResponse.json({ error: 'Invalid or oversized signature image' }, { status: 400 })
  }

  const { data: contract } = await supabase
    .from('patient_contracts')
    .select(`
      id, organization_id, status, template_snapshot, share_token_expires_at
    `)
    .eq('share_token', shareToken)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!['sent', 'viewed'].includes(contract.status)) {
    return NextResponse.json({ error: `Cannot sign contract in status ${contract.status}` }, { status: 409 })
  }
  if (
    contract.share_token_expires_at &&
    new Date(contract.share_token_expires_at).getTime() < Date.now()
  ) {
    return NextResponse.json({ error: 'Link expired' }, { status: 410 })
  }

  // Validate all required consents are present
  const snapshotSections = (contract.template_snapshot?.sections ?? []) as ContractTemplateSection[]
  const requiredConsentKeys = snapshotSections
    .filter((s) => s.kind === 'consent' && s.required !== false && s.consent_key)
    .map((s) => s.consent_key!)
  const gotKeys = new Set(
    consentsFromClient
      .map((c: { consent_key?: string }) => String(c?.consent_key ?? ''))
      .filter(Boolean)
  )
  const missing = requiredConsentKeys.filter((k) => !gotKeys.has(k))
  if (missing.length > 0) {
    return NextResponse.json({ error: 'Missing required consents', missing_consents: missing }, { status: 400 })
  }

  const now = new Date().toISOString()
  const signerIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  const userAgent = request.headers.get('user-agent') ?? null

  const consentsAgreed = consentsFromClient.map((c: { section_id?: string; consent_key?: string }) => ({
    section_id: String(c?.section_id ?? ''),
    consent_key: String(c?.consent_key ?? ''),
    agreed_at: now,
  }))

  const { error: updErr } = await supabase
    .from('patient_contracts')
    .update({
      status: 'signed',
      signed_at: now,
      signer_name: signerName,
      signer_ip: signerIp,
      signer_user_agent: userAgent,
      signature_data_url: signatureDataUrl,
      signature_type: signatureType,
      consents_agreed: consentsAgreed,
    })
    .eq('id', contract.id)

  if (updErr) {
    console.error('[contracts/sign] update failed', updErr)
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  await logContractEvent(supabase, {
    organization_id: contract.organization_id,
    contract_id: contract.id,
    event_type: 'signed',
    actor_type: 'patient',
    payload: { signer_name: signerName, ip: signerIp, user_agent: userAgent },
  })
  await logHIPAAEvent(supabase, {
    organization_id: contract.organization_id,
    event_type: 'contract_signed',
    severity: 'info',
    actor_type: 'system',
    resource_type: 'patient_contract',
    resource_id: contract.id,
    description: 'Patient signed contract via portal',
    metadata: { ip: signerIp, user_agent: userAgent, consent_count: consentsAgreed.length },
  })

  // Kick off PDF execution asynchronously — patient gets a "thanks" screen immediately
  void Promise.resolve().then(async () => {
    try {
      const res = await executeSignedContract({ supabase, contractId: contract.id })
      if (!res.ok) console.error('[contracts/sign] pdf execute failed', res.error)
    } catch (err) {
      console.error('[contracts/sign] pdf execute crashed', err)
    }
  })

  return NextResponse.json({ status: 'signed' })
}
