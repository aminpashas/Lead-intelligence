/**
 * VENDORED MIRROR of Dion's `events/case.ts` — the slice Lead Intelligence
 * PRODUCES. `case.treatment_agreed` is emitted when a patient agrees to a
 * treatment plan (the case closes in the CRM); Dion Clinical consumes it and
 * opens a surgery-scheduling work item.
 *
 * Source of truth: dion-enterprise-stack/packages/contracts/src/events/case.ts
 * PHI rule: ids, CDT codes and dates only — never clinical narrative.
 */
import { z } from 'zod'
import { dionEvent } from './envelope'

export const caseTreatmentAgreed = dionEvent(
  'case.treatment_agreed',
  z.object({
    /** The CRM case id (clinical_cases.id). */
    caseId: z.string().min(1),
    dionPatientId: z.string().nullable(),
    /** CRM-side treatment plan reference (case_treatment_plans.id). */
    treatmentPlanId: z.string().nullable(),
    agreementConfirmedAt: z.string().datetime(),
    /** YYYY-MM-DD target date, when the CRM already has one. */
    estimatedSurgeryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    /** CDT procedure codes only — never clinical narrative. */
    proceduresCdt: z.array(z.string()).default([]),
  }),
)

export const dionCaseSchema = z.discriminatedUnion('type', [caseTreatmentAgreed])

export type DionCaseEvent = z.infer<typeof dionCaseSchema>
