'use client'

/**
 * LeadActions — the shared Call / SMS / Email + Do-Not-Disturb bar.
 *
 * One component, three surfaces: the lead-detail header (`variant="bar"`), a
 * leads-table row and the conversation header (`variant="compact"`). Every send
 * path is already consent-gated server-side, so a channel that's DND'd (or has no
 * destination) is surfaced here as a disabled button with a reason — honest UX
 * instead of a click that the API would just reject.
 *
 * DND is per-channel. The dropdown reflects each channel's own opt-out flag and
 * toggles them independently; "All channels" flips the three together. Lead-
 * initiated opt-outs (STOP / unsubscribe) land on the same flags, so they show up
 * here too — checked, whoever set them.
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Phone, MessageSquare, Mail, BellOff, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'
import type { Lead } from '@/types/database'
import { LeadMessaging } from './lead-messaging'
import { DND_CHANNELS, type DndChannel } from '@/lib/consent/capture'

type Variant = 'bar' | 'compact'

const CHANNEL_LABEL: Record<DndChannel, string> = { sms: 'SMS', email: 'Email', call: 'Calls' }

/** Per-channel DND state read straight off the lead's opt-out columns. */
function dndOf(lead: Lead): Record<DndChannel, boolean> {
  return {
    sms: !!lead.sms_opt_out,
    email: !!lead.email_opt_out,
    call: !!lead.voice_opt_out,
  }
}

export function LeadActions({
  lead,
  variant = 'bar',
}: {
  lead: Lead
  variant?: Variant
}) {
  const router = useRouter()
  const [dnd, setDnd] = useState<Record<DndChannel, boolean>>(() => dndOf(lead))
  const [pending, setPending] = useState<DndChannel | 'all' | null>(null)
  const [calling, setCalling] = useState(false)
  const [msgOpen, setMsgOpen] = useState(false)
  const [msgChannel, setMsgChannel] = useState<'sms' | 'email'>('sms')

  // Resync if the lead prop changes (e.g. after router.refresh or realtime).
  useEffect(() => { setDnd(dndOf(lead)) }, [lead.id, lead.sms_opt_out, lead.email_opt_out, lead.voice_opt_out])

  const compact = variant === 'compact'
  const iconSize = compact ? 'h-3.5 w-3.5' : 'h-4 w-4'

  // Reasons a channel can't be used right now (null = usable).
  const callBlock = !lead.phone ? 'No phone number'
    : lead.do_not_call ? 'On Do-Not-Call registry'
    : dnd.call ? 'Calls muted (DND)'
    : null
  const smsBlock = !lead.phone ? 'No phone number' : dnd.sms ? 'SMS muted (DND)' : null
  const emailBlock = !lead.email ? 'No email address' : dnd.email ? 'Email muted (DND)' : null

  async function setChannelDnd(channels: DndChannel[], enabled: boolean, key: DndChannel | 'all') {
    setPending(key)
    // Optimistic — reflect immediately, roll back on failure.
    const prev = dnd
    setDnd((d) => {
      const next = { ...d }
      for (const c of channels) next[c] = enabled
      return next
    })
    try {
      const res = await fetch(`/api/leads/${lead.id}/dnd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels, enabled }),
      })
      if (!res.ok) throw new Error('DND update failed')
      const label = channels.length === DND_CHANNELS.length
        ? 'all channels'
        : channels.map((c) => CHANNEL_LABEL[c]).join(', ')
      toast.success(`Do Not Disturb ${enabled ? 'on' : 'off'} for ${label}`)
      router.refresh()
    } catch {
      setDnd(prev)
      toast.error('Could not update Do Not Disturb')
    } finally {
      setPending(null)
    }
  }

  async function call() {
    if (callBlock) return
    setCalling(true)
    try {
      const res = await fetch('/api/voice/outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Call failed')
      toast.success(`Calling ${lead.first_name || 'lead'}…`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not place call')
    } finally {
      setCalling(false)
    }
  }

  function openMessage(channel: 'sms' | 'email') {
    setMsgChannel(channel)
    setMsgOpen(true)
  }

  const allOn = DND_CHANNELS.every((c) => dnd[c])
  const anyOn = DND_CHANNELS.some((c) => dnd[c])

  // A reusable action button that stays visible-but-disabled with a reason.
  const action = (opts: {
    label: string
    icon: ReactNode
    block: string | null
    onClick: () => void
    busy?: boolean
  }) => (
    <Button
      variant="outline"
      size="sm"
      onClick={opts.onClick}
      disabled={!!opts.block || opts.busy}
      title={opts.block ?? opts.label}
      className={compact ? 'h-8 gap-1.5 px-2.5' : 'gap-1.5'}
    >
      {opts.busy ? <Loader2 className={`${iconSize} animate-spin`} strokeWidth={1.75} /> : opts.icon}
      {!compact && <span>{opts.label}</span>}
    </Button>
  )

  return (
    <div
      className="flex items-center gap-2"
      // On a table row, keep clicks from bubbling up to the row's navigate handler.
      onClick={(e) => e.stopPropagation()}
    >
      {action({ label: 'Call', icon: <Phone className={iconSize} strokeWidth={1.75} />, block: callBlock, onClick: call, busy: calling })}
      {action({ label: 'SMS', icon: <MessageSquare className={iconSize} strokeWidth={1.75} />, block: smsBlock, onClick: () => openMessage('sms') })}
      {action({ label: 'Email', icon: <Mail className={iconSize} strokeWidth={1.75} />, block: emailBlock, onClick: () => openMessage('email') })}

      <DropdownMenu>
        <DropdownMenuTrigger
          title="Do Not Disturb"
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border text-sm font-medium transition-colors',
            compact ? 'h-8 px-2.5' : 'px-3 py-2',
            anyOn
              ? 'border-aurea-rose/20 bg-aurea-rose/10 text-aurea-rose hover:bg-aurea-rose/20'
              : 'border-aurea-border text-aurea-ink hover:bg-aurea-surface-2'
          )}
        >
          {pending ? <Loader2 className={`${iconSize} animate-spin`} strokeWidth={1.75} /> : <BellOff className={iconSize} strokeWidth={1.75} />}
          {!compact && <span>DND{anyOn ? ` (${DND_CHANNELS.filter((c) => dnd[c]).length})` : ''}</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Do Not Disturb</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {DND_CHANNELS.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={dnd[c]}
              disabled={pending !== null}
              closeOnClick={false}
              onCheckedChange={(v) => setChannelDnd([c], v, c)}
            >
              Mute {CHANNEL_LABEL[c]}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending !== null}
            closeOnClick={false}
            // If everything is already muted, this un-mutes all; else mute all.
            onClick={() => setChannelDnd([...DND_CHANNELS], !allOn, 'all')}
          >
            <Check className={`mr-2 h-4 w-4 ${allOn ? 'opacity-100' : 'opacity-0'}`} strokeWidth={1.75} />
            {allOn ? 'Un-mute all channels' : 'Mute all channels'}
          </DropdownMenuItem>
          {lead.do_not_call && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-[11px] text-aurea-ink-3">
                On the Do-Not-Call registry — calls stay blocked regardless of DND.
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled messaging dialog, reused for both SMS and Email (no trigger). */}
      <LeadMessaging
        lead={lead}
        defaultChannel={msgChannel}
        open={msgOpen}
        onOpenChange={setMsgOpen}
      />
    </div>
  )
}
