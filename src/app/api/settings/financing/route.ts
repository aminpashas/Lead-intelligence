/**
 * POST /api/settings/financing — write the account-level financing flags.
 *
 * Two switches live on `organizations.feature_flags`:
 *   • financing_prequal_enabled     — the per-lead "Send Pre-Qual" button
 *   • financing_auto_send_enabled   — the AI readiness auto-trigger
 *
 * Both are financing autonomy / AI-config decisions, so writes require
 * `ai_control:write` — the same agency-side permission that guards autopilot
 * tuning. Practice admins can *see* the page (ai_control:read) but only the
 * agency can flip it, which keeps autonomous financing out of client staff's
 * reach (the practice/agency split).
 *
 * The update is read-modify-write: we merge onto the existing flags object so a
 * toggle here never clobbers unrelated flags (us_sms_enabled, etc.).
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/active-org'
import { getOrgFlags } from '@/lib/org/flags'

const bodySchema = z
  .object({
    financing_prequal_enabled: z.boolean().optional(),
    financing_auto_send_enabled: z.boolean().optional(),
  })
  .refine((b) => b.financing_prequal_enabled !== undefined || b.financing_auto_send_enabled !== undefined, {
    message: 'At least one flag must be provided',
  })

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const guard = await requirePermission(supabase, 'ai_control:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Merge onto current flags so we only touch the keys we were given.
  const current = await getOrgFlags(supabase, orgId)
  const next = { ...current }
  if (parsed.data.financing_prequal_enabled !== undefined) {
    next.financing_prequal_enabled = parsed.data.financing_prequal_enabled
  }
  if (parsed.data.financing_auto_send_enabled !== undefined) {
    next.financing_auto_send_enabled = parsed.data.financing_auto_send_enabled
  }

  // Guard-rail: auto-send is meaningless without the feature on. If prequal is
  // being turned off, force auto-send off too so the AI can't keep firing.
  if (next.financing_prequal_enabled === false) {
    next.financing_auto_send_enabled = false
  }

  const { error } = await supabase
    .from('organizations')
    .update({ feature_flags: next })
    .eq('id', orgId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    feature_flags: {
      financing_prequal_enabled: next.financing_prequal_enabled === true,
      financing_auto_send_enabled: next.financing_auto_send_enabled === true,
    },
  })
}
