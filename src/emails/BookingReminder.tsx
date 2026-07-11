/**
 * Appointment reminder email — sent 24h and 2h before a scheduled consultation.
 *
 * The existing reminder sweep (src/app/api/cron/reminders or src/lib/campaigns/reminders.ts)
 * decides which window (24h vs 2h) and toggles the reminder_sent_24h / reminder_sent_1h flags
 * on the appointments row.
 */

import { Section, Text } from '@react-email/components'
import * as React from 'react'
import { Layout, styles } from './_shared/Layout'
import type { BrandLogistics } from '@/lib/branding/schema'

export type BookingReminderProps = {
  leadId: string
  orgId: string
  orgName: string
  firstName: string
  consultLabel: string
  scheduledAt: string
  timezone?: string
  durationMinutes: number
  location?: string
  /** Which reminder window we're sending — affects subject line + opening. */
  window: '24h' | '2h'
  rescheduleUrl?: string
  /** Address / by-car / BART / what-to-expect — same directions given at booking. */
  logistics?: BrandLogistics
}

const has = (s: string | undefined): s is string => Boolean(s && s.trim())

export function BookingReminder(props: BookingReminderProps) {
  const formatted = formatScheduledAt(props.scheduledAt, props.timezone)
  const opener =
    props.window === '24h'
      ? `Quick reminder, ${props.firstName} — your ${props.consultLabel} is tomorrow.`
      : `${props.firstName}, your ${props.consultLabel} is in about 2 hours.`

  return (
    <Layout
      preview={
        props.window === '24h'
          ? `Reminder: your appointment is tomorrow`
          : `Reminder: your appointment is in 2 hours`
      }
      leadId={props.leadId}
      orgId={props.orgId}
      orgName={props.orgName}
    >
      <Text style={styles.heading}>{opener}</Text>

      <Section style={detailCard}>
        <Text style={styles.detailRow}>
          <span style={styles.detailLabel}>When:</span> {formatted}
        </Text>
        <Text style={styles.detailRow}>
          <span style={styles.detailLabel}>Duration:</span> {props.durationMinutes} minutes
        </Text>
        {props.location ? (
          <Text style={styles.detailRow}>
            <span style={styles.detailLabel}>Where:</span> {props.location}
          </Text>
        ) : null}
      </Section>

      {props.logistics ? <VisitLogistics logistics={props.logistics} /> : null}

      <Text style={styles.paragraph}>
        If anything has changed, reply to this email and we&apos;ll sort it out.
        {props.rescheduleUrl ? (
          <>
            {' '}
            You can also <a href={props.rescheduleUrl}>reschedule online</a>.
          </>
        ) : null}
      </Text>

      <Text style={styles.paragraph}>See you soon — {props.orgName}</Text>
    </Layout>
  )
}

/** "Getting here" + "What to expect" section — mirrors renderVisitLogistics(),
 *  built with React Email primitives so the 24h reminder matches the booking
 *  confirmation. Renders nothing if no logistics are entered. */
function VisitLogistics({ logistics }: { logistics: BrandLogistics }) {
  const { addressText, drivingText, parkingText, transitText, whatToExpectText } = logistics
  const hasGettingHere = has(addressText) || has(drivingText) || has(parkingText) || has(transitText)

  return (
    <>
      {hasGettingHere ? (
        <Section style={gettingHereCard}>
          <Text style={sectionHeading}>Getting here</Text>
          {has(addressText) ? <Text style={styles.detailRow}>{addressText}</Text> : null}
          {has(drivingText) ? (
            <Text style={styles.detailRow}>
              <span style={styles.detailLabel}>By car:</span> {drivingText}
            </Text>
          ) : null}
          {has(parkingText) ? (
            <Text style={styles.detailRow}>
              <span style={styles.detailLabel}>Parking:</span> {parkingText}
            </Text>
          ) : null}
          {has(transitText) ? (
            <Text style={styles.detailRow}>
              <span style={styles.detailLabel}>By BART / transit:</span> {transitText}
            </Text>
          ) : null}
        </Section>
      ) : null}
      {has(whatToExpectText) ? (
        <Section style={detailCard}>
          <Text style={sectionHeading}>What to expect</Text>
          <Text style={{ ...styles.detailRow, whiteSpace: 'pre-line' }}>{whatToExpectText}</Text>
        </Section>
      ) : null}
    </>
  )
}

function formatScheduledAt(iso: string, timezone?: string): string {
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone,
    }).format(date)
  } catch {
    return iso
  }
}

const detailCard: React.CSSProperties = {
  backgroundColor: '#f9fafb',
  borderRadius: '6px',
  padding: '16px 20px',
  margin: '0 0 16px 0',
}

const gettingHereCard: React.CSSProperties = {
  backgroundColor: '#f4f8ff',
  borderRadius: '6px',
  padding: '16px 20px',
  margin: '0 0 16px 0',
}

const sectionHeading: React.CSSProperties = {
  fontWeight: 600,
  margin: '0 0 8px 0',
}

export default BookingReminder
