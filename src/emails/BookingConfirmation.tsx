/**
 * Booking confirmation email — sent on Cal.com BOOKING_CREATED webhook.
 *
 * Wired from src/app/api/webhooks/cal/route.ts.
 */

import { Button, Section, Text } from '@react-email/components'
import * as React from 'react'
import { Layout, styles } from './_shared/Layout'

export type BookingConfirmationProps = {
  leadId: string
  orgId: string
  orgName: string
  firstName: string
  consultLabel: string         // e.g. "AOX Consultation"
  scheduledAt: string          // ISO string
  timezone?: string            // e.g. "America/Los_Angeles"
  durationMinutes: number
  location?: string            // physical address or "Video call"
  rescheduleUrl?: string       // optional Cal.com reschedule link
  cancelUrl?: string           // optional Cal.com cancel link
}

export function BookingConfirmation(props: BookingConfirmationProps) {
  const formatted = formatScheduledAt(props.scheduledAt, props.timezone)

  return (
    <Layout
      preview={`Your ${props.consultLabel} at ${props.orgName} is confirmed`}
      leadId={props.leadId}
      orgId={props.orgId}
      orgName={props.orgName}
    >
      <Text style={styles.heading}>You&apos;re booked, {props.firstName}.</Text>

      <Text style={styles.paragraph}>
        Confirming your {props.consultLabel} with {props.orgName}. Looking forward to
        meeting you.
      </Text>

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

      {props.rescheduleUrl || props.cancelUrl ? (
        <Section style={{ margin: '24px 0' }}>
          {props.rescheduleUrl ? (
            <Button href={props.rescheduleUrl} style={styles.primaryButton}>
              Reschedule
            </Button>
          ) : null}
          {props.cancelUrl ? (
            <Text style={{ ...styles.paragraph, marginTop: '12px' }}>
              Need to cancel? <a href={props.cancelUrl}>Click here</a>.
            </Text>
          ) : null}
        </Section>
      ) : null}

      <Text style={styles.paragraph}>
        We&apos;ll send a reminder 24 hours and 2 hours before. If anything changes, just
        reply to this email.
      </Text>
    </Layout>
  )
}

function formatScheduledAt(iso: string, timezone?: string): string {
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
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

export default BookingConfirmation
