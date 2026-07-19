import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadNote } from '@/components/crm/lead-notes-panel'

/**
 * Loads a lead's manual team notes, newest first, with author names resolved.
 *
 * Notes live in `lead_activities` as `note_added` rows. This filters on the type
 * in the query rather than fetching-then-filtering — the same starvation trap
 * that used to empty the lead timeline (see TIMELINE_ACTIVITY_TYPES).
 */
export async function fetchLeadNotes(
  supabase: SupabaseClient,
  leadId: string,
  limit = 100,
): Promise<LeadNote[]> {
  const { data: rows } = await supabase
    .from('lead_activities')
    .select('id, created_at, description, user_id')
    .eq('lead_id', leadId)
    .eq('activity_type', 'note_added')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!rows?.length) return []

  // Resolve author names in one round-trip rather than per-note.
  const authorIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (authorIds.length) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, email')
      .in('id', authorIds)
    for (const p of profiles ?? []) {
      names.set(p.id, p.full_name || p.email || 'Team member')
    }
  }

  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    description: r.description,
    user_id: r.user_id,
    author_name: r.user_id ? names.get(r.user_id) ?? null : null,
  }))
}
