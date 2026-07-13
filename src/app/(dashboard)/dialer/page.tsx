import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { PowerDialer, type DialerLead } from '@/components/voice/power-dialer'
import { ManualDialPad } from '@/components/voice/manual-dial-pad'

/**
 * Power dialer — walk a queue of callable leads back-to-back through the browser
 * softphone. The queue is pre-filtered to leads that would actually pass the
 * compliance gate (has phone, consented, not DNC / opted-out). Ordering is
 * highest AI score first so the staffer isn't handed dead ends — but scores are
 * frequently absent (an org may have no leads scored yet), which leaves the whole
 * candidate set tied at 0. When that happens the score key is meaningless and
 * LIMIT would return an arbitrary, unstable slice, so we fall back to freshest-
 * first (never-contacted, then most-recently-contacted, then newest lead) with an
 * `id` tiebreak for a deterministic queue. Each dial still re-runs the full gate
 * server-side in /api/voice/prepare.
 */
export default async function DialerPage() {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: rows } = await supabase
    .from('leads')
    .select(
      'id, first_name, last_name, phone, phone_formatted, ai_score, ai_qualification, status, last_contacted_at, city, state'
    )
    .eq('organization_id', orgId)
    .eq('do_not_call', false)
    .eq('voice_opt_out', false)
    .eq('voice_consent', true)
    .not('phone', 'is', null)
    .not('status', 'in', '(lost,disqualified,completed)')
    // Score wins when it exists; otherwise everything ties at 0, so freshest-first
    // (never-contacted → most-recent contact → newest lead) drives the queue, with
    // `id` as a deterministic tiebreak so the same queue renders on every load.
    .order('ai_score', { ascending: false, nullsFirst: false })
    .order('last_contacted_at', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(100)

  // Lead phone numbers are encrypted at rest — decrypt server-side, then hand the
  // client only a last-4 for display (never the full number).
  const leads: DialerLead[] = (rows || []).map((r) => {
    const dec = decryptLeadPII(r as Record<string, unknown>)
    const phone = ((dec.phone_formatted as string) || (dec.phone as string) || '').replace(/[^0-9]/g, '')
    return {
      id: r.id as string,
      first_name: (dec.first_name as string) || 'Lead',
      last_name: (dec.last_name as string) || null,
      ai_score: (r.ai_score as number) ?? null,
      ai_qualification: (r.ai_qualification as string) || 'unscored',
      status: (r.status as string) || 'new',
      last_contacted_at: (r.last_contacted_at as string) || null,
      city: (dec.city as string) || null,
      state: (r.state as string) || null,
      phone_last4: phone.slice(-4),
    }
  })

  return (
    <div className="mx-auto max-w-2xl">
      <ManualDialPad />
      <PowerDialer initialLeads={leads} />
    </div>
  )
}
