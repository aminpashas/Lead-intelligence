/**
 * PATCH /api/agency/billing-settings — agency super-admin sets a practice's pricing.
 *
 * Writes `billing_settings` for one org: a single re-bill markup (applied uniformly to
 * ai/sms/voice/email) and the monthly platform fee. Agency-admin only. The base-table RLS
 * ("Agency admins manage billing settings") is the real boundary; the role check here is the
 * courtesy 403. Empty/absent values fall back to platform defaults at read time, so clearing a
 * field is done by deleting the row, not writing zeros.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAgencyCapability } from '@/lib/auth/active-org'

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  /** Single markup percent applied to every service (200 = 3× cost). */
  markupPct: z.number().min(0).max(100000),
  /** Monthly platform fee in cents (0 = explicitly no fee). */
  platformFeeCents: z.number().int().min(0).max(100_000_000),
})

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()

  // Setting practice pricing is an owner-only agency-billing action.
  const guard = await requireAgencyCapability(supabase, 'agency:billing_manage')
  if ('error' in guard) return guard.error

  let parsed
  try {
    parsed = bodySchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { organizationId, markupPct, platformFeeCents } = parsed
  const markups = { ai: markupPct, sms: markupPct, voice: markupPct, email: markupPct }

  const { error } = await supabase.from('billing_settings').upsert(
    {
      organization_id: organizationId,
      markups,
      platform_fee_cents: platformFeeCents,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  )

  if (error) {
    return NextResponse.json({ error: 'Failed to save pricing' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, organizationId, markupPct, platformFeeCents })
}
