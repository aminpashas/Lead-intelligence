import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_PRACTICE_TIMEZONE } from './zoned'

/**
 * The practice's configured IANA timezone (from `booking_settings.timezone`),
 * or a sensible default when booking hasn't been set up for the org.
 *
 * Thread timestamps render in this zone so the server (UTC on Vercel) and the
 * browser agree on which calendar day each message belongs to. Never throws —
 * a missing row or query error falls back to the default.
 */
export async function resolvePracticeTimeZone(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
): Promise<string> {
  if (!orgId) return DEFAULT_PRACTICE_TIMEZONE
  const { data } = await supabase
    .from('booking_settings')
    .select('timezone')
    .eq('organization_id', orgId)
    .maybeSingle()
  return (data?.timezone as string | undefined) || DEFAULT_PRACTICE_TIMEZONE
}
