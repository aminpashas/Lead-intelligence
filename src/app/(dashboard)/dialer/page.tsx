import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { PowerDialer, type DialerLead } from '@/components/voice/power-dialer'
import { ManualDialPad } from '@/components/voice/manual-dial-pad'

/**
 * Power dialer — walk a queue of callable leads back-to-back through the browser
 * softphone. The queue is pre-filtered to leads that would actually pass the
 * compliance gate (has phone, consented, not DNC / opted-out), highest AI score
 * first, so the staffer isn't handed dead ends. Each dial still re-runs the full
 * gate server-side in /api/voice/prepare.
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
    .order('ai_score', { ascending: false, nullsFirst: false })
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
