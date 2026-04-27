/**
 * Contracts cron:
 *   1. Expire stale tokens — mark contracts as 'expired' when share_token_expires_at has passed.
 *   2. Integrity check — re-hash a sample of executed PDFs and compare to stored SHA-256.
 *
 * Runs nightly (see vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { createHash } from 'node:crypto'
import { logContractEvent } from '@/lib/contracts/orchestrator'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export const runtime = 'nodejs'

const INTEGRITY_SAMPLE_SIZE = 10

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // 1) Expire stale tokens
  const { data: expiring } = await supabase
    .from('patient_contracts')
    .select('id, organization_id, share_token_expires_at')
    .in('status', ['sent', 'viewed'])
    .lt('share_token_expires_at', now)
    .limit(500)

  let expired = 0
  for (const row of expiring ?? []) {
    const { error } = await supabase
      .from('patient_contracts')
      .update({ status: 'expired' })
      .eq('id', row.id)
    if (!error) {
      expired++
      await logContractEvent(supabase, {
        organization_id: row.organization_id,
        contract_id: row.id,
        event_type: 'expired',
        actor_type: 'system',
        payload: { expired_at: row.share_token_expires_at },
      })
      await logHIPAAEvent(supabase, {
        organization_id: row.organization_id,
        event_type: 'contract_expired',
        severity: 'info',
        actor_type: 'cron',
        resource_type: 'patient_contract',
        resource_id: row.id,
        description: 'Share token expired without signing',
      })
    }
  }

  // 2) Integrity check a random sample of executed contracts
  const { data: executed } = await supabase
    .from('patient_contracts')
    .select('id, organization_id, executed_pdf_storage_path, executed_pdf_sha256')
    .eq('status', 'executed')
    .not('executed_pdf_storage_path', 'is', null)
    .not('executed_pdf_sha256', 'is', null)
    .limit(INTEGRITY_SAMPLE_SIZE * 3)

  const sample = (executed ?? [])
    .sort(() => Math.random() - 0.5)
    .slice(0, INTEGRITY_SAMPLE_SIZE)

  let checked = 0
  let mismatches = 0
  for (const row of sample) {
    try {
      const { data, error } = await supabase.storage
        .from('case-files')
        .download(row.executed_pdf_storage_path!)
      if (error || !data) continue
      const ab = await data.arrayBuffer()
      const sha = createHash('sha256').update(Buffer.from(ab)).digest('hex')
      checked++
      if (sha !== row.executed_pdf_sha256) {
        mismatches++
        await logHIPAAEvent(supabase, {
          organization_id: row.organization_id,
          event_type: 'contract_integrity_mismatch',
          severity: 'critical',
          actor_type: 'cron',
          resource_type: 'patient_contract',
          resource_id: row.id,
          description: 'Executed contract PDF SHA-256 does not match stored hash',
          metadata: { expected: row.executed_pdf_sha256, got: sha },
        })
      }
    } catch (err) {
      console.error('[cron/contracts] integrity check error', err)
    }
  }

  return NextResponse.json({ expired, checked, mismatches })
}

export const GET = POST
