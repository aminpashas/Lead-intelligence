import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { EXPECTED_CRONS } from '@/lib/cron/with-cron'
import { buildRegistryRows, type CronRunSnapshot } from '@/lib/automation/matrix'
import { AutomationCommandCenter } from '@/components/automation/command-center'
import type { AutomationSettings } from '@/components/automation/types'
import type { AutomationPolicy } from '@/types/database'

export const metadata = {
  title: 'Automation | Lead Intelligence',
}

/**
 * Automation Command Center — the "never blindsided" page: who (AI/human)
 * owns each kind of work right now, which workflows are running and healthy,
 * the live kill/shadow/SLA controls, and the AI-vs-Human scoreboard.
 */
export default async function AutomationPage() {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role || !hasPermission(role, 'ai_control:read')) return null

  const [orgRes, policiesRes, campaignsRes, voiceRes, stagesRes, sequencesRes] =
    await Promise.all([
      supabase
        .from('organizations')
        .select(
          `timezone, autopilot_enabled, autopilot_paused, autopilot_mode,
           autopilot_outreach_suppressed, autopilot_confidence_threshold,
           autopilot_max_messages_per_hour, autopilot_active_hours_start,
           autopilot_active_hours_end, autopilot_stop_words, autopilot_schedule,
           autopilot_speed_to_lead, human_first_sla_enabled, human_first_sla_seconds`
        )
        .eq('id', orgId)
        .single(),
      supabase
        .from('automation_policies')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: true }),
      supabase
        .from('campaigns')
        .select('id, name, status, channel, type')
        .eq('organization_id', orgId)
        .in('status', ['active', 'paused'])
        .order('name')
        .limit(100),
      supabase
        .from('voice_campaigns')
        .select('id, name, status, agent_type, live_transfer_enabled, transfer_mode')
        .eq('organization_id', orgId)
        .in('status', ['active', 'paused', 'scheduled'])
        .order('name')
        .limit(50),
      supabase
        .from('pipeline_stages')
        .select('id, name, color, position')
        .eq('organization_id', orgId)
        .order('position'),
      supabase
        .from('outreach_sequences')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('enabled', true),
    ])

  // cron_runs is service-role-only by design (no RLS policies); the registry
  // is platform infrastructure, shown read-only to anyone who can read this
  // page. One query, reduced to the latest heartbeat per cron.
  const cronNames = Object.keys(EXPECTED_CRONS)
  const service = createServiceClient()
  const { data: runs } = await service
    .from('cron_runs')
    .select('cron, status, ran_at, error, items_processed')
    .in('cron', cronNames)
    .order('ran_at', { ascending: false })
    .limit(cronNames.length * 5)

  const latestByCron: Record<string, CronRunSnapshot> = {}
  for (const run of runs ?? []) {
    if (!latestByCron[run.cron]) {
      latestByCron[run.cron] = {
        status: run.status,
        ran_at: run.ran_at,
        error: run.error,
        items_processed: run.items_processed,
      }
    }
  }
  const registryRows = buildRegistryRows(EXPECTED_CRONS, latestByCron)

  const org = orgRes.data ?? {}

  return (
    <AutomationCommandCenter
      settings={org as AutomationSettings}
      policies={(policiesRes.data ?? []) as AutomationPolicy[]}
      campaigns={campaignsRes.data ?? []}
      voiceCampaigns={voiceRes.data ?? []}
      stages={stagesRes.data ?? []}
      registryRows={registryRows}
      counts={{
        activeCampaigns: (campaignsRes.data ?? []).filter((c) => c.status === 'active').length,
        activeVoiceCampaigns: (voiceRes.data ?? []).filter((v) => v.status === 'active').length,
        enabledSequences: sequencesRes.count ?? 0,
      }}
      isAdmin={hasPermission(role, 'ai_control:write')}
      canKillSwitch={
        ['doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin'].includes(role)
      }
    />
  )
}
