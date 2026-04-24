/**
 * Post-generation validator for AI-written contract sections.
 *
 * The AI is only trusted to write narrative prose. This validator catches any
 * attempt to hallucinate numbers, codes, drug names, or guarantee language
 * before the content is persisted.
 */

import type { ContractTemplateSection } from '@/types/database'
import type { AiSectionOutput, ValidationIssue, ValidationResult } from './types'
import { checkResponseCompliance, detectPHI } from '@/lib/ai/hipaa'

// CDT code pattern (dental codes are D followed by 4 digits)
const CDT_CODE_RE = /\bD\d{4}\b/
// Dollar amounts
const DOLLAR_RE = /\$\s*\d/
// Drug suffix list — common pharma suffixes that indicate named medications.
// We allow general words like "anesthesia" or "sedation" — we only flag specific named drugs.
const DRUG_SUFFIXES = [
  'caine',   // lidocaine, benzocaine
  'pril',    // lisinopril
  'statin',  // atorvastatin
  'prazole', // omeprazole
  'mycin',   // amoxicillin → "mycin" catches clarithromycin, vancomycin
  'cillin',  // amoxicillin, penicillin
  'floxacin',// ciprofloxacin
  'sartan',  // losartan
  'olol',    // metoprolol
  'azepam',  // diazepam
  'zolam',   // alprazolam
  'vastatin',
]
const DRUG_RE = new RegExp(`\\b\\w{3,}(?:${DRUG_SUFFIXES.join('|')})\\b`, 'i')

// Phone-like digit run (7+ consecutive digits — don't want the AI inventing phone numbers)
const LONG_DIGIT_RE = /\b\d{7,}\b/

export function validateAiSections(
  aiOutput: AiSectionOutput[],
  sections: ContractTemplateSection[]
): ValidationResult {
  const issues: ValidationIssue[] = []
  const sectionById = new Map(sections.map((s) => [s.id, s]))

  const requiredAiSectionIds = sections
    .filter((s) => s.kind === 'ai_narrative' && s.required !== false)
    .map((s) => s.id)
  const gotIds = new Set(aiOutput.map((o) => o.section_id))

  for (const id of requiredAiSectionIds) {
    if (!gotIds.has(id)) {
      issues.push({
        section_id: id,
        severity: 'violation',
        category: 'missing',
        description: `AI did not emit required narrative section "${id}"`,
      })
    }
  }

  for (const out of aiOutput) {
    const section = sectionById.get(out.section_id)
    if (!section) {
      issues.push({
        section_id: out.section_id,
        severity: 'warning',
        category: 'missing',
        description: `AI emitted content for unknown section_id "${out.section_id}"`,
      })
      continue
    }
    const content = out.content ?? ''

    if (DOLLAR_RE.test(content)) {
      issues.push({
        section_id: out.section_id,
        severity: 'violation',
        category: 'forbidden_number',
        description: 'Contains a dollar amount. Financial numbers must come from data_table sections, not AI.',
      })
    }
    if (CDT_CODE_RE.test(content)) {
      issues.push({
        section_id: out.section_id,
        severity: 'violation',
        category: 'forbidden_code',
        description: 'Contains a CDT procedure code. Codes are only rendered in the Phases table.',
      })
    }
    if (DRUG_RE.test(content)) {
      issues.push({
        section_id: out.section_id,
        severity: 'violation',
        category: 'drug_reference',
        description: 'Mentions a named medication. Use generic "as directed by your provider."',
      })
    }
    if (LONG_DIGIT_RE.test(content)) {
      issues.push({
        section_id: out.section_id,
        severity: 'warning',
        category: 'forbidden_number',
        description: 'Contains a long digit run. The AI should not generate phone-like numbers.',
      })
    }

    // Guarantee / diagnosis language via shared HIPAA checker
    const complianceIssues = checkResponseCompliance(content)
    for (const ci of complianceIssues) {
      if (ci.category === 'treatment_guarantee') {
        issues.push({
          section_id: out.section_id,
          severity: 'violation',
          category: 'guarantee_language',
          description: ci.description,
        })
      } else if (ci.category === 'medical_advice') {
        issues.push({
          section_id: out.section_id,
          severity: 'warning',
          category: 'guarantee_language',
          description: ci.description,
        })
      } else if (ci.category === 'phi_exposure') {
        issues.push({
          section_id: out.section_id,
          severity: 'violation',
          category: 'phi_leakage',
          description: ci.description,
        })
      }
    }

    // Additional PHI sweep (emails, SSNs) — the AI should never output any of this
    const phi = detectPHI(content)
    if (phi.length > 0) {
      issues.push({
        section_id: out.section_id,
        severity: 'violation',
        category: 'phi_leakage',
        description: `AI output contains PHI (${phi.map((p) => p.category).join(', ')}).`,
      })
    }

    // Word count cap
    if (section.max_ai_words) {
      const wordCount = content.trim().split(/\s+/).filter(Boolean).length
      if (wordCount > section.max_ai_words + 20) {
        // 20-word grace; we'll clamp in the renderer anyway
        issues.push({
          section_id: out.section_id,
          severity: 'warning',
          category: 'word_count',
          description: `Section exceeds max_ai_words (${wordCount} > ${section.max_ai_words}).`,
        })
      }
    }
  }

  const isValid = !issues.some((i) => i.severity === 'violation')
  return { isValid, issues }
}
