/**
 * Contract renderer — pure function that merges template sections, variables,
 * and AI output into the final `generated_content` array persisted on
 * patient_contracts.
 *
 * Hard boundary: boilerplate/consent section bodies are attorney-authored and
 * merged with variable resolution. data_table sections render from structured
 * source data (never AI). ai_narrative sections come from the AI and are
 * stored verbatim after passing the validator.
 */

import type { ContractTemplateSection, RenderedContractSection } from '@/types/database'
import type { AiSectionOutput, ContractContext, RenderInput, RenderOutput } from './types'
import { resolveContractVariables, formatCurrency } from './variables'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textToHtmlParagraphs(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`).join('\n')
}

function renderPhaseRows(context: ContractContext) {
  const rows: Array<Record<string, string | number>> = []
  const byPhase = new Map<number, typeof context.phases>()
  for (const item of context.phases) {
    const arr = byPhase.get(item.phase) ?? []
    arr.push(item)
    byPhase.set(item.phase, arr)
  }
  const phaseKeys = [...byPhase.keys()].sort((a, b) => a - b)
  for (const p of phaseKeys) {
    const items = byPhase.get(p) ?? []
    for (const it of items) {
      rows.push({
        phase: p,
        procedure: it.procedure,
        description: it.description,
        tooth_numbers: it.tooth_numbers,
        cdt_code: it.cdt_code,
        estimated_cost: it.estimated_cost,
      })
    }
  }
  return rows
}

function renderPhaseTableHtml(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '<p><em>No phases on file.</em></p>'
  const body = rows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(String(r.phase))}</td>
        <td>${escapeHtml(String(r.procedure))}</td>
        <td>${escapeHtml(String(r.description))}</td>
        <td>${escapeHtml(String(r.tooth_numbers))}</td>
        <td>${escapeHtml(String(r.cdt_code))}</td>
        <td style="text-align: right;">${formatCurrency(Number(r.estimated_cost))}</td>
      </tr>`
    )
    .join('')
  return `
    <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
      <thead>
        <tr>
          <th style="text-align:left; border-bottom:1px solid #ccc; padding:6px 4px;">Phase</th>
          <th style="text-align:left; border-bottom:1px solid #ccc; padding:6px 4px;">Procedure</th>
          <th style="text-align:left; border-bottom:1px solid #ccc; padding:6px 4px;">Description</th>
          <th style="text-align:left; border-bottom:1px solid #ccc; padding:6px 4px;">Tooth</th>
          <th style="text-align:left; border-bottom:1px solid #ccc; padding:6px 4px;">CDT</th>
          <th style="text-align:right; border-bottom:1px solid #ccc; padding:6px 4px;">Estimate</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`
}

function renderPhaseTableText(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return 'No phases on file.'
  return rows
    .map(
      (r) =>
        `Phase ${r.phase} — ${r.procedure}${r.tooth_numbers ? ` (teeth ${r.tooth_numbers})` : ''}${
          r.cdt_code ? ` [${r.cdt_code}]` : ''
        } — ${formatCurrency(Number(r.estimated_cost))}`
    )
    .join('\n')
}

function renderFinancialRows(context: ContractContext) {
  const f = context.financial
  const rows: Array<Record<string, string | number>> = [
    { label: 'Total Treatment Cost', amount: f.contract_amount },
    { label: 'Non-refundable Deposit', amount: f.deposit_amount },
  ]
  if (f.financing_type === 'loan' || f.financing_type === 'in_house') {
    rows.push({ label: 'Estimated Monthly Payment', amount: f.financing_monthly_payment ?? 0 })
  }
  return rows
}

function renderFinancialTableHtml(rows: Array<Record<string, string | number>>): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:6px 4px;">${escapeHtml(String(r.label))}</td>
        <td style="padding:6px 4px; text-align:right;">${formatCurrency(Number(r.amount))}</td>
      </tr>`
    )
    .join('')
  return `
    <table style="width:100%; border-collapse:collapse; font-size:0.95rem;">
      <tbody>${body}</tbody>
    </table>`
}

function renderFinancialTableText(rows: Array<Record<string, string | number>>): string {
  return rows.map((r) => `${r.label}: ${formatCurrency(Number(r.amount))}`).join('\n')
}

function clampWords(text: string, maxWords: number | undefined): string {
  if (!maxWords) return text
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text
  return words.slice(0, maxWords).join(' ') + '…'
}

export function renderContract(input: RenderInput): RenderOutput {
  const { template_sections, ai_output, context } = input
  const aiById = new Map<string, AiSectionOutput>((ai_output ?? []).map((o) => [o.section_id, o]))
  const missingVariables = new Set<string>()
  const generated: RenderedContractSection[] = []

  for (const section of template_sections) {
    let renderedText = ''
    let renderedHtml = ''
    let aiGenerated = false
    let dataRows: RenderedContractSection['data_rows'] | undefined

    if (section.kind === 'ai_narrative') {
      const ai = aiById.get(section.id)
      const raw = ai?.content?.trim() ?? ''
      const clamped = clampWords(raw, section.max_ai_words)
      if (clamped) {
        renderedText = clamped
        renderedHtml = textToHtmlParagraphs(clamped)
        aiGenerated = true
      } else {
        renderedText = '[Pending manual draft]'
        renderedHtml = '<p><em>[Pending manual draft]</em></p>'
      }
    } else if (section.kind === 'boilerplate' || section.kind === 'consent') {
      const body = section.body ?? ''
      const { rendered, missing } = resolveContractVariables(body, context.variables)
      for (const m of missing) missingVariables.add(m)
      renderedText = rendered
      renderedHtml = textToHtmlParagraphs(rendered)
    } else if (section.kind === 'data_table') {
      let rows: Array<Record<string, string | number>> = []
      let htmlTable = ''
      let textTable = ''
      if (section.data_source === 'treatment_plan.phases') {
        rows = renderPhaseRows(context)
        htmlTable = renderPhaseTableHtml(rows)
        textTable = renderPhaseTableText(rows)
      } else if (section.data_source === 'financial.summary') {
        rows = renderFinancialRows(context)
        htmlTable = renderFinancialTableHtml(rows)
        textTable = renderFinancialTableText(rows)
      }
      const preamble = section.body
        ? resolveContractVariables(section.body, context.variables)
        : { rendered: '', missing: [] as string[] }
      for (const m of preamble.missing) missingVariables.add(m)
      renderedText = [preamble.rendered, textTable].filter(Boolean).join('\n\n')
      renderedHtml = [preamble.rendered ? textToHtmlParagraphs(preamble.rendered) : '', htmlTable]
        .filter(Boolean)
        .join('\n')
      dataRows = rows
    } else if (section.kind === 'signature') {
      const body = section.body ?? ''
      const { rendered, missing } = resolveContractVariables(body, context.variables)
      for (const m of missing) missingVariables.add(m)
      renderedText = rendered
      renderedHtml = textToHtmlParagraphs(rendered)
    }

    generated.push({
      section_id: section.id,
      title: section.title,
      kind: section.kind,
      rendered_text: renderedText,
      rendered_html: renderedHtml,
      ai_generated: aiGenerated,
      consent_key: section.consent_key,
      data_source: section.data_source,
      data_rows: dataRows,
    })
  }

  return {
    generated_content: generated,
    missing_variables: [...missingVariables],
  }
}
