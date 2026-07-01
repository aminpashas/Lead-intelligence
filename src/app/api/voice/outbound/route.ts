/**
 * Outbound Voice Call API
 *
 * POST /api/voice/outbound — Initiate a single outbound AI call to a lead
 *
 * Used by:
 * - Dashboard "Call" button on a lead profile
 * - Speed-to-lead trigger (auto-call new leads)
 * - Campaign dialer (automated batch calling)
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { preCallCheck, initiateOutboundCall } from '@/lib/voice/call-manager'
import { assertActiveSubscription } from '@/lib/auth/entitlement'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  // Auth check
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get user's org
  const { data: profile } = await authClient
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const entError = await assertActiveSubscription(authClient, orgId)
  if (entError) return entError

  const parsed = z.object({
    lead_id: z.string().uuid(),
    agent_type: z.enum(['setter', 'closer']).optional(),
  }).safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }
  const { lead_id, agent_type } = parsed.data

  const supabase = createServiceClient()

  // Pre-call compliance checks
  const check = await preCallCheck(supabase, lead_id, orgId)
  if (!check.allowed) {
    return NextResponse.json(
      { error: `Cannot call this lead: ${check.reason}` },
      { status: 422 }
    )
  }

  // Load lead for the call
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Initiate the call
  const result = await initiateOutboundCall(supabase, {
    organization_id: orgId,
    lead_id,
    lead,
    phone: check.phone!,
    agent_type: agent_type || 'setter',
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  logger.info('Manual outbound voice call initiated', {
    user_id: user.id,
    lead_id,
    call_id: result.call_id,
  })

  return NextResponse.json({
    call_id: result.call_id,
    retell_call_id: result.retell_call_id,
    status: 'initiated',
  })
}
