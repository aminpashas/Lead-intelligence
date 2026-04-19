/**
 * Generate per-lead Cal.com booking URLs that prefill name/phone/email,
 * so the lead never has to re-enter data.
 *
 * Format:  {booking_base_url}/{event_type_slug}?name=...&email=...&smsReminderNumber=...&metadata[lead_id]=...
 *
 * Brief reference: Section 2.4.
 */

import { decryptField } from '@/lib/encryption'
import type { CalConfig } from './client'

export type LeadBookingFields = {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null         // may be encrypted; we'll decrypt
  phone_formatted?: string | null  // may be encrypted; E.164 expected after decrypt
}

export type BookingLinkOptions = {
  config: CalConfig
  lead: LeadBookingFields
  /** Internal slug, e.g. 'aox-consult'. Falls back to first configured event type. */
  consultSlug?: string
}

export type BookingLinkResult =
  | { ok: true; url: string; eventType: string; eventLabel: string }
  | { ok: false; reason: 'no_event_types' | 'unknown_consult_slug' }

export function generateBookingLink(opts: BookingLinkOptions): BookingLinkResult {
  if (opts.config.event_types.length === 0) {
    return { ok: false, reason: 'no_event_types' }
  }

  const eventType = opts.consultSlug
    ? opts.config.event_types.find((et) => et.slug === opts.consultSlug)
    : opts.config.event_types[0]

  if (!eventType) {
    return { ok: false, reason: 'unknown_consult_slug' }
  }

  const fullName = [opts.lead.first_name, opts.lead.last_name].filter(Boolean).join(' ').trim()
  const email = opts.lead.email ? (decryptField(opts.lead.email) || opts.lead.email) : ''
  const phone = opts.lead.phone_formatted
    ? (decryptField(opts.lead.phone_formatted) || opts.lead.phone_formatted)
    : ''

  const params = new URLSearchParams()
  if (fullName) params.set('name', fullName)
  if (email) params.set('email', email)
  if (phone) params.set('smsReminderNumber', phone)
  // Cal.com round-trips metadata via webhook payload — this is how we re-link the booking to the lead.
  params.set('metadata[lead_id]', opts.lead.id)

  // Strip trailing slash from base
  const base = opts.config.booking_base_url.replace(/\/$/, '')
  const url = `${base}/${eventType.slug}?${params.toString()}`

  return { ok: true, url, eventType: eventType.slug, eventLabel: eventType.label }
}
