/**
 * Shared plumbing for Retell custom-function endpoints (/api/voice/tools/*).
 *
 * Every mid-call tool the hosted voice agent invokes arrives as:
 *   POST { call: { metadata: { lead_id, organization_id, conversation_id } },
 *          args: { ...function arguments } }
 * signed with the same x-retell-signature scheme as the main webhook.
 *
 * This module verifies the signature, extracts the call identity, and loads the
 * lead row so each tool route stays a thin adapter over the SAME
 * executeAgentTool() implementations the SMS/email agents use — one booking
 * gate, one availability engine, zero drift between channels.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyRetellWebhook } from './retell-client'

export type RetellToolRequest = {
  supabase: SupabaseClient
  leadId: string
  organizationId: string
  conversationId: string
  lead: Record<string, unknown>
  args: Record<string, unknown>
}

export type RetellToolParseResult =
  | { ok: true; req: RetellToolRequest }
  | { ok: false; response: NextResponse }

/**
 * The LLM reads `message` — phrase failures as instructions for what the agent
 * should do next, never as raw errors.
 */
export function toolReply(success: boolean, message: string, data?: Record<string, unknown>) {
  return NextResponse.json({ success, message, ...(data || {}) })
}

/**
 * Constant-time compare so a matching-prefix secret can't be timed out.
 */
function secretMatches(provided: string): boolean {
  const expected = process.env.VOICE_TOOL_SECRET || ''
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function parseRetellToolRequest(
  request: NextRequest,
  options?: { requireLead?: boolean }
): Promise<RetellToolParseResult> {
  const rawBody = await request.text()

  // Auth: accept EITHER a valid Retell webhook signature OR our shared secret
  // (?s=<VOICE_TOOL_SECRET>, baked into the tool URL in the agent config).
  //
  // Why both: Retell signs custom-function calls with an account signing key
  // that is NOT necessarily the RETELL_API_KEY in our env, so signature-only
  // verification fails on this account. The shared secret is an equally strong
  // gate (a secret known only to Retell's server-side tool config and us) and
  // is verifiable end-to-end. The signature path is kept so that if/when the
  // signing key matches, it also works with no per-request secret in the URL.
  const signature = request.headers.get('x-retell-signature') || ''
  const providedSecret = new URL(request.url).searchParams.get('s') || ''
  const authed = secretMatches(providedSecret) || (await verifyRetellWebhook(rawBody, signature))
  if (!authed) {
    return { ok: false, response: new NextResponse('Unauthorized', { status: 401 }) }
  }

  let body: {
    call?: { metadata?: Record<string, unknown> }
    args?: Record<string, unknown>
    arguments?: Record<string, unknown>
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  }

  const metadata = body.call?.metadata || {}
  const leadId = (metadata.lead_id as string) || ''
  const organizationId = (metadata.organization_id as string) || ''
  const conversationId = (metadata.conversation_id as string) || ''
  // Retell nests function args under `args` (or `arguments` on some versions).
  const args = body.args || body.arguments || {}

  if (!leadId || !organizationId) {
    // A call with no lead attached (e.g. unattributed inbound) can't act on a
    // record. Tell the agent what to do instead of failing opaquely.
    return {
      ok: false,
      response: toolReply(
        false,
        'This caller is not linked to a patient record, so this action is unavailable. Offer to have a team member follow up instead.'
      ),
    }
  }

  const supabase = createServiceClient()

  let lead: Record<string, unknown> = {}
  if (options?.requireLead !== false) {
    const { data } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .single()
    if (!data) {
      return {
        ok: false,
        response: toolReply(
          false,
          'The patient record could not be found. Offer to have a team member follow up instead.'
        ),
      }
    }
    lead = data
  }

  return {
    ok: true,
    req: { supabase, leadId, organizationId, conversationId, lead, args },
  }
}
