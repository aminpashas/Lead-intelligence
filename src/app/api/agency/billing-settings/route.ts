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
import { getOwnProfile } from '@/lib/auth/active-org'

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  /** Single markup percent applied to every service (200 = 3× cost). */
  markupPct: z.number().min(0).max(100000),
  /** Monthly platform fee in cents (0 = explicitly no fee). */
  platformFeeCents: z.number().int().min(0).max(100_000_000),
  /** Optional: enable/disable monthly auto-charge for this practice (needs a card on file). */
  autocharge: z.boolean().optional(),
  /** Optional: 'invoice' (postpaid monthly) or 'prepaid' (wallet + auto-reload) usage billing. */
  billingMode: z.enum(['invoice', 'prepaid']).optional(),
  /** Optional: enable prepaid auto-reload (needs a card on file). */
  autoReload: z.boolean().optional(),
  /** Optional: prepaid top-up amount per reload, in cents. */
  reloadAmountCents: z.number().int().min(0).max(100_000_000).optional(),
})

export async function PATCH(request: NextRequest) {
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

  const { organizationId, markupPct, platformFeeCents, autocharge, billingMode, autoReload, reloadAmountCents } = parsed
  const markups = { ai: markupPct, sms: markupPct, voice: markupPct, email: markupPct }

  const row: Record<string, unknown> = {
    organization_id: organizationId,
    markups,
    platform_fee_cents: platformFeeCents,
    updated_at: new Date().toISOString(),
  }
  if (typeof autocharge === 'boolean') row.autocharge = autocharge
  if (billingMode) row.billing_mode = billingMode
  if (typeof autoReload === 'boolean') row.auto_reload = autoReload
  if (typeof reloadAmountCents === 'number') row.reload_amount_cents = reloadAmountCents

  const { error } = await supabase.from('billing_settings').upsert(row, { onConflict: 'organization_id' })

  if (error) {
    return NextResponse.json({ error: 'Failed to save pricing' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, organizationId, markupPct, platformFeeCents, autocharge, billingMode })
}
