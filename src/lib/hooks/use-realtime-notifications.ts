'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useOrgStore } from '@/lib/store/use-org'
import { useNotificationStore } from '@/lib/store/use-notifications'
import { toast } from 'sonner'

/**
 * Consolidated real-time notification system.
 *
 * Listens for events across leads, messages, appointments, and campaigns.
 * Creates persistent notifications in the Zustand store AND shows Sonner toasts.
 */
export function useRealtimeNotifications() {
  const router = useRouter()
  const { organization } = useOrgStore()
  const supabase = createClient()
  const addNotification = useNotificationStore((s) => s.addNotification)

  useEffect(() => {
    if (!organization?.id) return

    // Channel 1: Leads — new leads + qualification changes
    const leadsChannel = supabase
      .channel('notif-leads')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'leads',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const lead = payload.new as Record<string, unknown>
          const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim()
          const source = (lead.source_type as string)?.replace(/_/g, ' ') || 'Manual entry'

          addNotification({
            type: 'new_lead',
            title: 'New Lead',
            description: `${name} from ${source}`,
            actionUrl: `/leads/${lead.id}`,
          })

          toast.info(`New lead: ${name}`, {
            description: source,
            action: { label: 'View', onClick: () => router.push(`/leads/${lead.id}`) },
          })
          router.refresh()
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'leads',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const lead = payload.new as Record<string, unknown>
          const old = payload.old as Record<string, unknown>
          const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim()

          // Hot lead notification
          if (lead.ai_qualification === 'hot' && old.ai_qualification !== 'hot') {
            addNotification({
              type: 'hot_lead',
              title: 'Hot Lead!',
              description: `${name} scored as hot (${lead.ai_score}/100)`,
              actionUrl: `/leads/${lead.id}`,
            })

            toast.success(`${name} is now a HOT lead!`, {
              description: `AI Score: ${lead.ai_score}/100`,
              action: { label: 'View', onClick: () => router.push(`/leads/${lead.id}`) },
            })
          }

          // Lead went cold
          if (lead.ai_qualification === 'cold' && old.ai_qualification !== 'cold' && old.ai_qualification) {
            addNotification({
              type: 'lead_cold',
              title: 'Lead Went Cold',
              description: `${name} dropped to cold (was ${old.ai_qualification})`,
              actionUrl: `/leads/${lead.id}`,
            })
          }

          router.refresh()
        }
      )
      .subscribe()

    // Channel 2: Messages — inbound messages
    const messagesChannel = supabase
      .channel('notif-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const msg = payload.new as Record<string, unknown>
          if (msg.direction !== 'inbound') return

          const preview = (msg.body as string)?.substring(0, 80) || 'New message'
          const channel = msg.channel as string

          addNotification({
            type: 'inbound_message',
            title: `New ${channel?.toUpperCase() || 'Message'}`,
            description: preview,
            actionUrl: msg.conversation_id ? `/conversations/${msg.conversation_id}` : undefined,
          })

          toast.info('New message received', {
            description: preview,
            action: msg.conversation_id
              ? { label: 'View', onClick: () => router.push(`/conversations/${msg.conversation_id}`) }
              : undefined,
          })
          router.refresh()
        }
      )
      .subscribe()

    // Channel 3: Appointments — new bookings
    const appointmentsChannel = supabase
      .channel('notif-appointments')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'appointments',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const appt = payload.new as Record<string, unknown>
          const scheduledAt = appt.scheduled_at ? new Date(appt.scheduled_at as string) : null
          const dateStr = scheduledAt
            ? scheduledAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            : 'TBD'

          addNotification({
            type: 'appointment_booked',
            title: 'Appointment Booked',
            description: `${(appt.type as string)?.replace(/_/g, ' ')} on ${dateStr}`,
            actionUrl: '/appointments',
          })

          toast.success('New appointment booked!', {
            description: `${(appt.type as string)?.replace(/_/g, ' ')} scheduled for ${dateStr}`,
            action: { label: 'View', onClick: () => router.push('/appointments') },
          })
          router.refresh()
        }
      )
      .subscribe()

    // Channel 4: Campaigns — completions
    const campaignsChannel = supabase
      .channel('notif-campaigns')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'campaigns',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const campaign = payload.new as Record<string, unknown>
          const old = payload.old as Record<string, unknown>

          if (campaign.status === 'completed' && old.status !== 'completed') {
            addNotification({
              type: 'campaign_completed',
              title: 'Campaign Completed',
              description: `"${campaign.name}" has finished`,
              actionUrl: '/campaigns',
            })

            toast.info(`Campaign "${campaign.name}" completed`, {
              action: { label: 'View', onClick: () => router.push('/campaigns') },
            })
          }
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(leadsChannel)
      supabase.removeChannel(messagesChannel)
      supabase.removeChannel(appointmentsChannel)
      supabase.removeChannel(campaignsChannel)
    }
  }, [organization?.id, supabase, router, addNotification])
}
