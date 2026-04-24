/**
 * Contract executed — sent to patient after signing, with a signed URL to the PDF.
 * Transactional.
 */

import {
  Body, Button, Container, Head, Html, Preview, Section, Text,
} from '@react-email/components'
import * as React from 'react'

export type ContractExecutedProps = {
  patientFirstName: string
  orgName: string
  downloadUrl: string
}

export function ContractExecuted(props: ContractExecutedProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your signed agreement with {props.orgName}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={brandHeader}>
            <Text style={brandHeaderText}>{props.orgName}</Text>
          </Section>
          <Section style={content}>
            <Text style={heading}>Thanks, {props.patientFirstName}. Your agreement is signed.</Text>
            <Text style={paragraph}>
              A copy of your fully-executed Implant Treatment Services Agreement is attached as
              a secure download. Please save a copy for your records.
            </Text>
            <Section style={{ margin: '24px 0' }}>
              <Button href={props.downloadUrl} style={button}>Download Signed Agreement (PDF)</Button>
            </Section>
            <Text style={smallText}>
              The download link is secured and expires in 7 days. If you need a fresh copy, just
              reply to this email.
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
  backgroundColor: '#ffffff', borderRadius: '8px', margin: '0 auto', maxWidth: '600px', overflow: 'hidden',
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

export default ContractExecuted
