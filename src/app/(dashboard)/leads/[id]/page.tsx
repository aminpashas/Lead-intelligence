import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { getOwnProfile } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { LeadDetail } from '@/components/crm/lead-detail'
import { buildTimeline, TIMELINE_ACTIVITY_TYPES } from '@/lib/timeline/build-timeline'
import { fetchLeadNotes } from '@/lib/timeline/lead-notes'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'
import { decryptLeadPII } from '@/lib/encryption'
import { isFlagEnabled } from '@/lib/org/flags'
import { resolvePracticeTimeZone } from '@/lib/time/practice-timezone'
import type { Tag } from '@/types/database'

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch lead with relations
  const { data: leadRow } = await supabase
    .from('leads')
    .select(`
      *,
      pipeline_stage:pipeline_stages(*),
      source:lead_sources(*),
      assigned_user:user_profiles!leads_assigned_to_fkey(*)
    `)
    .eq('id', id)
    .single()

  if (!leadRow) notFound()

  // PII is encrypted at rest — decrypt server-side before rendering.
  const lead = decryptLeadPII(leadRow)

  // Everything below only depends on the lead row, so it all runs in parallel.
  // Messages and voice calls are each fetched ONCE per table (full rows, all
  // conversations for the lead) and both consumers — the in-lead chat thread
  // and the unified timeline — are derived from that single result.
  const [
    { data: activities },
    { data: timelineActivities },
    { data: conversations },
    { data: allMessages },
    { data: allVoiceCalls },
    { data: patientProfile },
    { data: latestAnalysis },
    { data: stages },
    { data: teamMembers },
    // Account-level pre-qualification switch — drives whether the per-lead
    // "Send Pre-Qual" action shows in the action bar.
    prequalEnabled,
    // Practice no-show fee switch — drives whether the per-lead "Card link"
    // action (text/resend the card-on-file link) shows in the action bar.
    { data: bookingSettingsRow },
    // Thread timestamps render in the practice timezone so SSR (UTC) and the
    // browser agree on day boundaries.
    timeZone,
    // Admins get the per-call "Use for AI training" control on call cards.
    { data: ownProfile },
    { data: leadTagRows },
    { data: leadTasks },
  ] = await Promise.all([
    // Audit trail for the Details panel — every activity type, most recent first.
    supabase
      .from('lead_activities')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    // Timeline activities — notes + stage changes only. Filtered in the QUERY,
    // not after it: the audit query above caps at 50 rows of *any* type, and on a
    // busy lead (29 activity types — score updates, tags, campaign enrolments)
    // notes and stage changes get pushed out of that window before the timeline
    // builder ever sees them, silently emptying the Timeline view.
    supabase
      .from('lead_activities')
      .select('id, created_at, activity_type, title, description')
      .eq('lead_id', id)
      .in('activity_type', TIMELINE_ACTIVITY_TYPES)
      .order('created_at', { ascending: true }),
    supabase
      .from('conversations')
      .select('*')
      .eq('lead_id', id)
      .order('last_message_at', { ascending: false }),
    supabase
      .from('messages')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('voice_calls')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: true }),
    // Latest AI intelligence (already computed by /api/ai/analyze)
    supabase
      .from('patient_profiles')
      .select('*')
      .eq('lead_id', id)
      .maybeSingle(),
    supabase
      .from('conversation_analyses')
      .select('*')
      .eq('lead_id', id)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('pipeline_stages')
      .select('*')
      .eq('organization_id', lead.organization_id)
      .order('position'),
    // Team members for assignment
    supabase
      .from('user_profiles')
      .select('id, full_name, email, role')
      .eq('organization_id', lead.organization_id)
      .eq('is_active', true),
    isFlagEnabled(supabase, lead.organization_id, 'financing_prequal_enabled'),
    supabase
      .from('booking_settings')
      .select('no_show_fee_enabled')
      .eq('organization_id', lead.organization_id)
      .maybeSingle(),
    resolvePracticeTimeZone(supabase, lead.organization_id),
    // `id` too: the Notes panel needs the viewer's id to decide which notes
    // expose edit/delete controls.
    getOwnProfile(supabase, 'id, role'),
    supabase
      .from('lead_tags')
      .select('tag:tags(*)')
      .eq('lead_id', id)
      .eq('organization_id', lead.organization_id),
    // Live (open/claimed) tasks for this lead — surfaced by LeadTaskCard so they
    // don't go stale. First read to use the human_tasks_lead_idx index.
    supabase
      .from('human_tasks')
      .select(
        'id, kind, title, detail, status, priority, due_at, assigned_to, reviewed_at, created_at'
      )
      .eq('lead_id', id)
      .eq('organization_id', lead.organization_id)
      .in('status', ['open', 'claimed'])
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  // The most recently active conversation is the one the embedded chat opens on.
  const primaryConversation = conversations?.[0] ?? null

  // Everything the lead has said or done — texts AND emails across every
  // conversation, plus every finished call (even calls logged against the lead
  // with no conversation_id) — so the in-lead thread shows it all together, not
  // just the primary conversation's slice. Sending/AI still target
  // primaryConversation below; this is purely what the thread renders. Derived
  // from the single allMessages/allVoiceCalls fetch above — no duplicate query.
  const threadMessages = allMessages || []
  const threadCalls = (allVoiceCalls || []).filter((c) => c.ended_at != null)

  // Unified timeline caps at the first 300 messages/calls (created_at asc).
  const timeline = buildTimeline({
    messages: (allMessages || []).slice(0, 300),
    calls: (allVoiceCalls || []).slice(0, 300),
    activities: timelineActivities || [],
  })

  const notes = await fetchLeadNotes(supabase, id)

  const analyzableConversationId = pickConversationToAnalyze(conversations || [])

  const noShowFeeEnabled = bookingSettingsRow?.no_show_fee_enabled === true

  const canTrainAi = !!ownProfile && isAdminRole(ownProfile.role)

  // Lead's tags (via the lead_tags join), so the Tags card renders populated.
  const initialTags: Tag[] = (leadTagRows || [])
    .map((row) => row.tag as any as Tag | null)
    .filter((tag): tag is Tag => Boolean(tag))

  return (
    <LeadDetail
      lead={lead}
      activities={activities || []}
      conversations={conversations || []}
      primaryConversation={primaryConversation}
      threadMessages={threadMessages}
      threadCalls={threadCalls}
      timeline={timeline}
      patientProfile={patientProfile}
      latestAnalysis={latestAnalysis}
      analyzableConversationId={analyzableConversationId}
      stages={stages || []}
      teamMembers={teamMembers || []}
      initialTags={initialTags}
      prequalEnabled={prequalEnabled}
      noShowFeeEnabled={noShowFeeEnabled}
      timeZone={timeZone}
      canTrainAi={canTrainAi}
      notes={notes}
      currentUserId={ownProfile?.id ?? null}
      tasks={leadTasks || []}
    />
  )
}
