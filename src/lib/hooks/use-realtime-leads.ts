'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useOrgStore } from '@/lib/store/use-org'
import { toast } from 'sonner'

/**
 * Subscribe to real-time lead changes for the current organization.
 * Triggers a router refresh when leads are inserted/updated/deleted.
 */
export function useRealtimeLeads() {
  const router = useRouter()
  const { organization } = useOrgStore()
  const supabase = createClient()

  useEffect(() => {
    if (!organization?.id) return

    const channel = supabase
      .channel('leads-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'leads',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const lead = payload.new as any
          toast.info(`New lead: ${lead.first_name} ${lead.last_name || ''}`, {
            description: lead.source_type?.replace(/_/g, ' ') || 'Manual entry',
            action: {
              label: 'View',
              onClick: () => router.push(`/leads/${lead.id}`),
            },
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
        () => {
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [organization?.id, supabase, router])
}

/**
 * Subscribe to real-time conversation/message updates.
 */
export function useRealtimeConversations() {
  const router = useRouter()
  const { organization } = useOrgStore()
  const supabase = createClient()

  useEffect(() => {
    if (!organization?.id) return

    const channel = supabase
      .channel('conversations-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const msg = payload.new as any
          if (msg.direction === 'inbound') {
            toast.info('New message received', {
              description: msg.body?.substring(0, 80),
              action: {
                label: 'View',
                onClick: () => router.push(`/leads/${msg.lead_id}`),
              },
            })
          }
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [organization?.id, supabase, router])
}
