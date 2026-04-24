/**
 * Contract ready — sent to patient when staff approves a contract draft.
 * Transactional (no unsubscribe needed). Portal link opens the signing page.
 */

import {
  Body, Button, Container, Head, Html, Preview, Section, Text,
} from '@react-email/components'
import * as React from 'react'

export type ContractReadyProps = {
  patientFirstName: string
  orgName: string
  portalUrl: string
  expiresAt: string // human-readable
}

export function ContractReady(props: ContractReadyProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your treatment agreement from {props.orgName} is ready to sign</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={brandHeader}>
            <Text style={brandHeaderText}>{props.orgName}</Text>
          </Section>
          <Section style={content}>
            <Text style={heading}>Your treatment agreement is ready, {props.patientFirstName}.</Text>
            <Text style={paragraph}>
              We&apos;ve prepared your Implant Treatment Services Agreement. Please review the
              treatment plan, financial summary, and consents, then sign electronically.
            </Text>
            <Section style={{ margin: '24px 0' }}>
              <Button href={props.portalUrl} style={button}>Review &amp; Sign</Button>
            </Section>
            <Text style={smallText}>
              This secure link expires on {props.expiresAt}. If you need assistance, reply to
              this email or call the practice.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = {
  backgroundColor: '#f5f5f5',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  margin: 0,
  padding: '24px 0',
}
const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  margin: '0 auto',
  maxWidth: '600px',
  overflow: 'hidden',
}
const brandHeader: React.CSSProperties = { backgroundColor: '#0f172a', padding: '20px 32px' }
const brandHeaderText: React.CSSProperties = {
  color: '#ffffff', fontSize: '18px', fontWeight: 600, margin: 0, letterSpacing: '0.02em',
}
const content: React.CSSProperties = { padding: '32px' }
const heading: React.CSSProperties = {
  color: '#0f172a', fontSize: '22px', fontWeight: 600, margin: '0 0 16px 0',
}
const paragraph: React.CSSProperties = {
  color: '#374151', fontSize: '15px', lineHeight: 1.6, margin: '0 0 16px 0',
}
const smallText: React.CSSProperties = {
  color: '#6b7280', fontSize: '13px', lineHeight: 1.5, margin: '16px 0 0 0',
}
const button: React.CSSProperties = {
  backgroundColor: '#0f172a', borderRadius: '6px', color: '#ffffff',
  display: 'inline-block', fontSize: '15px', fontWeight: 600, padding: '12px 24px',
  textDecoration: 'none',
}

export default ContractReady
