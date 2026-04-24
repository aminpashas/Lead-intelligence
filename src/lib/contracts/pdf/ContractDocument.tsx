/**
 * ContractDocument — `@react-pdf/renderer` document for patient contract PDFs.
 *
 * Renders:
 *   1. Cover page (practice name, patient, case #, effective date)
 *   2. Sectioned body (one section → one block; preserves template order)
 *   3. Signature page (typed name + drawn-signature image if present)
 *   4. Audit page (timestamps, IP, UA, consent acknowledgments, SHA-256)
 */

import React from 'react'
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import type { PatientContract, RenderedContractSection } from '@/types/database'

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, fontFamily: 'Helvetica', color: '#111827' },
  header: { borderBottomWidth: 1, borderBottomColor: '#d1d5db', paddingBottom: 8, marginBottom: 16 },
  practice: { fontSize: 10, color: '#6b7280' },
  title: { fontSize: 20, fontWeight: 700, marginTop: 4 },
  coverBlock: { marginTop: 24 },
  coverRow: { flexDirection: 'row', marginBottom: 8 },
  coverLabel: { width: 140, color: '#6b7280' },
  coverValue: { flex: 1, fontWeight: 700 },
  sectionTitle: { fontSize: 13, fontWeight: 700, marginTop: 16, marginBottom: 6, color: '#111827' },
  paragraph: { marginBottom: 6, lineHeight: 1.4 },
  table: { marginTop: 4, marginBottom: 8 },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 4 },
  th: { fontSize: 9, fontWeight: 700, color: '#6b7280' },
  td: { fontSize: 10 },
  right: { textAlign: 'right' },
  thPhase: { width: '8%' },
  thProc: { width: '22%' },
  thDesc: { width: '30%' },
  thTooth: { width: '12%' },
  thCdt: { width: '10%' },
  thAmt: { width: '18%' },
  thLabel: { width: '70%' },
  thLabelAmt: { width: '30%' },
  consentRow: { flexDirection: 'row', marginBottom: 4, alignItems: 'flex-start' },
  check: { width: 12, marginTop: 1 },
  signatureBox: { marginTop: 24, borderWidth: 1, borderColor: '#d1d5db', padding: 12 },
  signatureLabel: { fontSize: 9, color: '#6b7280', marginBottom: 4 },
  signatureName: { fontSize: 14, fontWeight: 700 },
  signatureImg: { width: 200, height: 60, objectFit: 'contain' },
  auditText: { fontSize: 9, color: '#374151', marginBottom: 2 },
  hash: { fontFamily: 'Courier', fontSize: 8, color: '#6b7280', wordBreak: 'break-all' },
  pageNumber: { position: 'absolute', bottom: 24, right: 48, fontSize: 9, color: '#9ca3af' },
})

type Props = {
  contract: Pick<PatientContract,
    'id' | 'generated_content' | 'contract_amount' | 'deposit_amount' | 'financing_type' |
    'financing_monthly_payment' | 'signed_at' | 'signer_name' | 'signer_ip' | 'signer_user_agent' |
    'signature_data_url' | 'consents_agreed' | 'template_version' | 'template_snapshot'
  > & {
    patient_name: string
    case_number: string
    organization_name: string
    effective_date: string
    executed_pdf_sha256?: string | null
  }
}

function renderParagraphs(text: string) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return <Text style={styles.paragraph}>{text}</Text>
  return paragraphs.map((p, i) => (
    <Text key={i} style={styles.paragraph}>{p}</Text>
  ))
}

function renderPhaseTable(rows: Array<Record<string, string | number>> | undefined) {
  if (!rows || rows.length === 0) return <Text style={styles.paragraph}>No phases on file.</Text>
  return (
    <View style={styles.table}>
      <View style={styles.tr}>
        <Text style={[styles.th, styles.thPhase]}>Phase</Text>
        <Text style={[styles.th, styles.thProc]}>Procedure</Text>
        <Text style={[styles.th, styles.thDesc]}>Description</Text>
        <Text style={[styles.th, styles.thTooth]}>Tooth</Text>
        <Text style={[styles.th, styles.thCdt]}>CDT</Text>
        <Text style={[styles.th, styles.thAmt, styles.right]}>Estimate</Text>
      </View>
      {rows.map((r, i) => (
        <View key={i} style={styles.tr}>
          <Text style={[styles.td, styles.thPhase]}>{String(r.phase)}</Text>
          <Text style={[styles.td, styles.thProc]}>{String(r.procedure)}</Text>
          <Text style={[styles.td, styles.thDesc]}>{String(r.description)}</Text>
          <Text style={[styles.td, styles.thTooth]}>{String(r.tooth_numbers)}</Text>
          <Text style={[styles.td, styles.thCdt]}>{String(r.cdt_code)}</Text>
          <Text style={[styles.td, styles.thAmt, styles.right]}>
            {formatCurrency(Number(r.estimated_cost))}
          </Text>
        </View>
      ))}
    </View>
  )
}

function renderFinancialTable(rows: Array<Record<string, string | number>> | undefined) {
  if (!rows || rows.length === 0) return null
  return (
    <View style={styles.table}>
      {rows.map((r, i) => (
        <View key={i} style={styles.tr}>
          <Text style={[styles.td, styles.thLabel]}>{String(r.label)}</Text>
          <Text style={[styles.td, styles.thLabelAmt, styles.right]}>
            {formatCurrency(Number(r.amount))}
          </Text>
        </View>
      ))}
    </View>
  )
}

function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function renderSection(section: RenderedContractSection) {
  if (section.kind === 'signature') {
    return null // signature rendered on its own page
  }
  return (
    <View key={section.section_id} wrap={true}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      {section.kind === 'data_table' ? (
        section.data_source === 'treatment_plan.phases'
          ? renderPhaseTable(section.data_rows)
          : renderFinancialTable(section.data_rows)
      ) : (
        renderParagraphs(section.rendered_text)
      )}
    </View>
  )
}

export function ContractDocument({ contract }: Props) {
  const sections = contract.generated_content
  const signatureSection = sections.find((s) => s.kind === 'signature')
  const consents = contract.consents_agreed ?? []

  return (
    <Document>
      {/* Cover */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.practice}>{contract.organization_name}</Text>
          <Text style={styles.title}>Implant Treatment Services Agreement</Text>
        </View>
        <View style={styles.coverBlock}>
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>Patient</Text>
            <Text style={styles.coverValue}>{contract.patient_name}</Text>
          </View>
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>Case Number</Text>
            <Text style={styles.coverValue}>{contract.case_number}</Text>
          </View>
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>Effective Date</Text>
            <Text style={styles.coverValue}>{contract.effective_date}</Text>
          </View>
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>Total Estimated</Text>
            <Text style={styles.coverValue}>{formatCurrency(Number(contract.contract_amount ?? 0))}</Text>
          </View>
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>Deposit Due</Text>
            <Text style={styles.coverValue}>{formatCurrency(Number(contract.deposit_amount ?? 0))}</Text>
          </View>
          {(contract.financing_type === 'loan' || contract.financing_type === 'in_house') && (
            <View style={styles.coverRow}>
              <Text style={styles.coverLabel}>Monthly Payment</Text>
              <Text style={styles.coverValue}>
                {formatCurrency(Number(contract.financing_monthly_payment ?? 0))}
              </Text>
            </View>
          )}
        </View>
        <Text style={styles.pageNumber} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>

      {/* Body */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.practice}>{contract.organization_name} — Agreement for {contract.patient_name}</Text>
        </View>
        {sections.filter((s) => s.kind !== 'signature').map(renderSection)}
        <Text style={styles.pageNumber} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>

      {/* Signature */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.practice}>{contract.organization_name} — Signatures</Text>
        </View>
        {signatureSection && (
          <>
            <Text style={styles.sectionTitle}>{signatureSection.title}</Text>
            {renderParagraphs(signatureSection.rendered_text)}
          </>
        )}
        <View style={styles.signatureBox}>
          <Text style={styles.signatureLabel}>Patient Signature</Text>
          {contract.signature_data_url ? (
            <Image src={contract.signature_data_url} style={styles.signatureImg} />
          ) : (
            <Text style={styles.signatureName}>{contract.signer_name ?? '(not yet signed)'}</Text>
          )}
          {contract.signature_data_url && contract.signer_name && (
            <Text style={styles.auditText}>Typed name: {contract.signer_name}</Text>
          )}
          <Text style={styles.auditText}>
            Signed: {contract.signed_at ? new Date(contract.signed_at).toUTCString() : '(pending)'}
          </Text>
        </View>
        <Text style={styles.pageNumber} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>

      {/* Audit */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.practice}>{contract.organization_name} — Execution Audit Trail</Text>
        </View>
        <Text style={styles.sectionTitle}>Execution record</Text>
        <Text style={styles.auditText}>Contract ID: {contract.id}</Text>
        <Text style={styles.auditText}>Template version: v{contract.template_version}</Text>
        <Text style={styles.auditText}>
          Signed at (UTC): {contract.signed_at ? new Date(contract.signed_at).toUTCString() : '(pending)'}
        </Text>
        <Text style={styles.auditText}>Signer IP: {contract.signer_ip ?? '(unknown)'}</Text>
        <Text style={styles.auditText}>
          Signer user agent: {contract.signer_user_agent ?? '(unknown)'}
        </Text>
        <Text style={styles.sectionTitle}>Consents acknowledged</Text>
        {consents.length === 0 ? (
          <Text style={styles.auditText}>(none recorded)</Text>
        ) : (
          consents.map((c, i) => (
            <Text key={i} style={styles.auditText}>
              ✓ {c.consent_key} — {new Date(c.agreed_at).toUTCString()}
            </Text>
          ))
        )}
        {contract.executed_pdf_sha256 && (
          <>
            <Text style={styles.sectionTitle}>Document hash (SHA-256)</Text>
            <Text style={styles.hash}>{contract.executed_pdf_sha256}</Text>
          </>
        )}
        <Text style={styles.pageNumber} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>
    </Document>
  )
}
