'use client'

import { MessageSquare, MessageCircle, MessageCircleMore, Mail, Phone, Camera, Globe } from 'lucide-react'
import { channelMeta, type ChannelMeta } from '@/lib/channels'

/**
 * Glyph lookup for the channel registry's `icon` names.
 *
 * `satisfies` ties this map to the registry's icon union, so adding a channel
 * that needs a new glyph is a compile error here rather than a silent fallback
 * in the UI.
 */
const CHANNEL_GLYPH = {
  'message-square': MessageSquare,
  'message-circle': MessageCircle,
  'message-circle-more': MessageCircleMore,
  camera: Camera,
  mail: Mail,
  phone: Phone,
  globe: Globe,
} satisfies Record<ChannelMeta['icon'], React.ComponentType<{ className?: string; strokeWidth?: number }>>

/**
 * Channel glyph, driven by the registry.
 *
 * Shared by the inbox rail and the lead timeline, which previously each kept
 * their own channel→icon map. Both omitted the social channels, so a patient's
 * Messenger DM rendered with the same generic icon as an SMS.
 *
 * `tinted` applies the channel's brand accent — lucide 1.x has no Facebook or
 * Instagram mark, so colour is what makes them recognizable at a glance.
 */
export function ChannelIcon({
  channel,
  className,
  tinted = false,
}: {
  channel: string
  className?: string
  tinted?: boolean
}) {
  const meta = channelMeta(channel)
  const Glyph = CHANNEL_GLYPH[meta.icon]
  return (
    <Glyph
      className={`${className ?? 'h-3 w-3'}${tinted ? ` ${meta.accent}` : ''}`}
      strokeWidth={1.75}
    />
  )
}
