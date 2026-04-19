/**
 * Day 2 reactivation email — sent automatically by the seeded Reactivation campaign
 * (supabase/migrations/024_seed_reactivation_campaign.sql, step 2).
 *
 * Tone: low-pressure, addresses the two top objections (cost / recovery time),
 * one clear CTA to the Cal.com booking link.
 */

import { Button, Section, Text } from '@react-email/components'
import * as React from 'react'
import { Layout, styles } from './_shared/Layout'

export type NurtureDay2Props = {
  leadId: string
  orgId: string
  orgName: string
  firstName: string
  bookingUrl: string  // Cal.com link from src/lib/cal/booking-link.ts
  /** Optional original inquiry topic (e.g. "All-on-X consultation") for personalization. */
  originalInquiry?: string
}

export function NurtureDay2(props: NurtureDay2Props) {
  const inquiry = props.originalInquiry || 'your inquiry'

  return (
    <Layout
      preview={`Still thinking it over, ${props.firstName}?`}
      leadId={props.leadId}
      orgId={props.orgId}
      orgName={props.orgName}
    >
      <Text style={styles.heading}>Hi {props.firstName},</Text>

      <Text style={styles.paragraph}>
        No pressure at all — just wanted to follow up on {inquiry} you sent us at{' '}
        {props.orgName}.
      </Text>

      <Text style={styles.paragraph}>
        A lot of patients in your situation worry about cost or recovery time. Both are
        easier to plan around than you&apos;d think — financing is straightforward, and the
        consult itself is free.
      </Text>

      <Text style={styles.paragraph}>
        If now isn&apos;t the right time, just reply and let me know. Otherwise, here&apos;s a
        link to grab a slot whenever works for you.
      </Text>

      <Section style={{ margin: '24px 0' }}>
        <Button href={props.bookingUrl} style={styles.primaryButton}>
          Book a free consultation
        </Button>
      </Section>

      <Text style={styles.paragraph}>— The team at {props.orgName}</Text>
    </Layout>
  )
}

export default NurtureDay2
