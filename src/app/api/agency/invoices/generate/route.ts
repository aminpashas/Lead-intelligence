/**
 * POST /api/agency/invoices/generate — agency super-admin issues a usage invoice for one practice.
 *
 * Composes the invoice from live usage + platform fee over a period (defaults to the current month
 * to date) and upserts it into `usage_invoices`. Agency-admin only. Idempotent by (org, period):
 * re-issuing the same period overwrites in place, so it's safe to click twice or re-run a cron.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { generateUsageInvoice, currentMonthPeriod } from '@/lib/billing/invoicing'

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['draft', 'issued']).optional(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  let parsed
  try {
    parsed = bodySchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const fallback = currentMonthPeriod(new Date())
  const periodStart = parsed.periodStart ?? fallback.periodStart
  const periodEnd = parsed.periodEnd ?? fallback.periodEnd

  const { invoice, error } = await generateUsageInvoice(supabase, {
    organizationId: parsed.organizationId,
    periodStart,
    periodEnd,
    status: parsed.status ?? 'issued',
  })

  if (error) {
    return NextResponse.json({ error: 'Failed to generate invoice' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, invoice })
}
