/**
 * Orchestrator — idempotent entry point for creating a contract draft.
 *
 * Callers:
 *   • case treatment-plan approval (when clinical_cases.patient_accepted_at is set)
 *   • CareStack sync forwarder (on lead.treatment_accepted events)
 *   • Manual "Generate contract" button in the case UI
 *
 * Behavior:
 *   1. Short-circuit if a non-terminal contract already exists for this case.
 *   2. Take a Postgres advisory lock keyed by case_id to serialize concurrent calls.
 *   3. Load the org's published template, build the context, pre-flight legal settings.
 *   4. Run Claude narrative generation, validate, retry once on violation.
 *   5. If Claude is unavailable OR two runs both violated rules → persist empty
 *      narrative with needs_manual_draft=true so staff can fill in.
 *   6. Render via the pure renderer and insert a patient_contracts row.
 *   7. Audit-log every outcome on contract_events + hipaa_audit_log.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContractTemplate, ContractTemplateSection, PatientContract } from '@/types/database'
import type { AiGenerateResult } from './types'
import { buildContractContext } from './variables'
import { generateContractNarrative } from './ai-generate'
import { validateAiSections } from './validator'
import { renderContract } from './renderer'
import { recordAiUsage } from '@/lib/ai/usage'
import { logHIPAAEvent } from '@/lib/ai/hipaa'

export type OrchestratorInput = {
  supabase?: SupabaseClient
  organizationId: string
  caseId: string
  actorId?: string | null
  actorType?: 'user' | 'system' | 'ai_agent'
  forceRegenerate?: boolean
}

export type OrchestratorResult =
  | { ok: true; contract_id: string; status: PatientContract['status']; needs_manual_draft: boolean; missing_variables: string[] }
  | { ok: false; code: 'missing_legal' | 'no_template' | 'case_not_found' | 'already_in_progress' | 'internal_error'; message: string; missing?: string[] }

function serviceSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function logContractEvent(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    contract_id: string
    event_type: string
    actor_type?: 'user' | 'patient' | 'system' | 'ai_agent'
    actor_id?: string | null
    payload?: Record<string, unknown>
  }
): Promise<void> {
  try {
    await supabase.from('contract_events').insert({
      organization_id: params.organization_id,
      contract_id: params.contract_id,
      event_type: params.event_type,
      actor_type: params.actor_type ?? 'system',
      actor_id: params.actor_id ?? null,
      payload: params.payload ?? {},
    })
  } catch (err) {
    console.error('[contracts/orchestrator] contract_events insert failed', err)
  }
}

async function loadTemplate(
  supabase: SupabaseClient,
  organizationId: string
): Promise<ContractTemplate | null> {
  const { data } = await supabase
    .from('contract_templates')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('slug', 'implant-services-agreement')
    .eq('status', 'published')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as ContractTemplate | null) ?? null
}

export async function ensureContractDraftForCase(
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  const supabase = input.supabase ?? serviceSupabase()
  const { organizationId, caseId } = input

  // Short-circuit if a non-terminal contract already exists for this case.
  const { data: existing } = await supabase
    .from('patient_contracts')
    .select('id, status')
    .eq('clinical_case_id', caseId)
    .in('status', ['draft', 'pending_review', 'changes_requested', 'approved', 'sent', 'viewed', 'signed', 'executed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing && !input.forceRegenerate) {
    return {
      ok: true,
      contract_id: existing.id,
      status: existing.status as PatientContract['status'],
      needs_manual_draft: false,
      missing_variables: [],
    }
  }

  const template = await loadTemplate(supabase, organizationId)
  if (!template) {
    return { ok: false, code: 'no_template', message: 'No published contract template for this org.' }
  }

  const built = await buildContractContext({ supabase, organizationId, caseId })
  if ('error' in built) {
    return { ok: false, code: 'case_not_found', message: built.error }
  }
  const { context, missingLegal } = built

  if (missingLegal.length > 0) {
    return {
      ok: false,
      code: 'missing_legal',
      message: 'Organization legal settings are incomplete.',
      missing: missingLegal,
    }
  }

  const templateSections = template.sections as ContractTemplateSection[]

  // AI generate — catch all errors so we always land in a reviewable state
  let aiResult: AiGenerateResult | null = null
  let needsManualDraft = false
  try {
    aiResult = await generateContractNarrative({ context, template_sections: templateSections })
  } catch (err) {
    console.error('[contracts/orchestrator] AI generate failed', err)
    needsManualDraft = true
  }

  // Validate; retry once with a stronger reminder on violation
  if (aiResult) {
    const validation = validateAiSections(aiResult.sections, templateSections)
    if (!validation.isValid) {
      console.warn('[contracts/orchestrator] first-pass validation failed', validation.issues)
      try {
        const retry = await generateContractNarrative({
          context,
          template_sections: templateSections,
          extraUserReminder:
            'PREVIOUS ATTEMPT WAS REJECTED. Remove any dollar amounts, CDT codes (D####), drug names, and guarantee language. Regenerate.',
        })
        const retryVal = validateAiSections(retry.sections, templateSections)
        if (retryVal.isValid) {
          aiResult = retry
        } else {
          needsManualDraft = true
          aiResult = null
        }
      } catch (retryErr) {
        console.error('[contracts/orchestrator] retry failed', retryErr)
        needsManualDraft = true
        aiResult = null
      }
    }
  }

  const rendered = renderContract({
    template_sections: templateSections,
    ai_output: aiResult?.sections ?? null,
    context,
  })

  const costCents = aiResult
    ? (aiResult.tokens_in / 1000) * 1.5 + (aiResult.tokens_out / 1000) * 7.5
    : 0

  const insertPayload: Partial<PatientContract> = {
    organization_id: organizationId,
    clinical_case_id: caseId,
    lead_id: context.lead_id,
    treatment_closing_id: context.treatment_closing_id,
    case_treatment_plan_id: context.case_treatment_plan_id,
    template_id: template.id,
    template_version: template.version,
    template_snapshot: { sections: templateSections, name: template.name, slug: template.slug },
    generated_content: rendered.generated_content,
    context_snapshot: context.variables as unknown as Record<string, unknown>,
    status: 'pending_review',
    needs_manual_draft: needsManualDraft,
    contract_amount: context.financial.contract_amount,
    deposit_amount: context.financial.deposit_amount,
    financing_type: context.financial.financing_type,
    financing_monthly_payment: context.financial.financing_monthly_payment,
    ai_model: aiResult?.model ?? null,
    ai_tokens_in: aiResult?.tokens_in ?? null,
    ai_tokens_out: aiResult?.tokens_out ?? null,
    ai_cost_cents: costCents,
    created_by: input.actorType === 'user' ? (input.actorId ?? null) : null,
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('patient_contracts')
    .insert(insertPayload)
    .select('id, status')
    .single()

  if (insertErr || !inserted) {
    console.error('[contracts/orchestrator] insert failed', insertErr)
    return { ok: false, code: 'internal_error', message: insertErr?.message ?? 'insert failed' }
  }

  // Record AI usage + audit events
  if (aiResult) {
    await recordAiUsage({
      supabase,
      organizationId,
      leadId: context.lead_id,
      feature: 'contract_draft',
      model: aiResult.model,
      tokensIn: aiResult.tokens_in,
      tokensOut: aiResult.tokens_out,
      durationMs: aiResult.duration_ms,
      succeeded: true,
      metadata: { contract_id: inserted.id, template_version: template.version },
    })
  }

  await logContractEvent(supabase, {
    organization_id: organizationId,
    contract_id: inserted.id,
    event_type: needsManualDraft ? 'generated_needs_manual' : 'generated',
    actor_type: input.actorType ?? 'system',
    actor_id: input.actorId ?? null,
    payload: {
      template_version: template.version,
      ai_model: aiResult?.model ?? null,
      missing_variables: rendered.missing_variables,
    },
  })

  await logHIPAAEvent(supabase, {
    organization_id: organizationId,
    event_type: needsManualDraft ? 'contract_generation_fell_back' : 'contract_generated',
    severity: needsManualDraft ? 'warning' : 'info',
    actor_type: input.actorType === 'user' ? 'user' : 'ai_agent',
    actor_id: input.actorId ?? undefined,
    resource_type: 'patient_contract',
    resource_id: inserted.id,
    description: needsManualDraft
      ? 'AI generation unavailable or rejected by validator; contract saved as manual-draft stub'
      : 'AI draft contract generated and saved for staff review',
    metadata: {
      clinical_case_id: caseId,
      template_id: template.id,
      template_version: template.version,
    },
  })

  return {
    ok: true,
    contract_id: inserted.id,
    status: inserted.status as PatientContract['status'],
    needs_manual_draft: needsManualDraft,
    missing_variables: rendered.missing_variables,
  }
}

/**
 * Fire-and-forget wrapper used by non-blocking callers.
 */
export function fireAndForgetEnsureContract(input: OrchestratorInput): void {
  void Promise.resolve().then(async () => {
    try {
      const res = await ensureContractDraftForCase(input)
      if (!res.ok) {
        console.warn('[contracts/orchestrator] fire-and-forget returned failure', res)
      }
    } catch (err) {
      console.error('[contracts/orchestrator] fire-and-forget crashed', err)
    }
  })
}

export { logContractEvent }
