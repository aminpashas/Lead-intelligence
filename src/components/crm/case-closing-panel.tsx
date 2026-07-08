'use client'

/**
 * Case Closing Panel — the post-close workflow surface on a clinical case.
 *
 * Shows the 7-step closing stepper (contract → funding → consent → pre-op →
 * surgery → records) with a card per concern. Steps normally advance
 * automatically (contract e-sign, financing webhooks, surgery booking); every
 * card also offers a manual path for work done on paper / in office.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Loader2,
  CheckCircle2,
  Circle,
  FileSignature,
  Banknote,
  ShieldCheck,
  Send,
  CalendarCheck,
  FlaskConical,
  ClipboardCheck,
  ClipboardList,
  ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { TreatmentClosing, TreatmentClosingStep, RecordsChecklist, LabOrder, PreopFormStatus } from '@/types/database'

type Progress = {
  current_step: TreatmentClosingStep
  current_step_label: string
  steps_completed: TreatmentClosingStep[]
  steps_remaining: TreatmentClosingStep[]
  percent_complete: number
  next_action: string
  next_action_detail: string
  surgery_in_days: number | null
  blockers: string[]
}

type ContractSummary = {
  id: string
  status: string
  contract_amount: number | null
  sent_at: string | null
  signed_at: string | null
} | null

type FinancingSummary = {
  id: string
  status: string
  approved_lender_slug: string | null
  requested_amount: number | null
  approved_amount: number | null
  approved_terms: { monthly_payment?: number } | null
} | null

type PreopSummary = {
  id: string
  status: PreopFormStatus
  title: string
  sent_via: string | null
  sent_at: string | null
  acknowledged_at: string | null
}

type SurgeryAppointment = {
  id: string
  status: string
  scheduled_at: string
  duration_minutes: number | null
  location: string | null
  carestack_sync_status: string | null
} | null

type ClosingState = {
  closing: TreatmentClosing | null
  progress: Progress | null
  contract: ContractSummary
  financing: FinancingSummary
  lab_orders: LabOrder[]
  preop_forms: PreopSummary[]
  surgery_appointment: SurgeryAppointment
}

const STEPS: Array<{ key: TreatmentClosingStep; label: string }> = [
  { key: 'treatment_plan_presented', label: 'Plan Presented' },
  { key: 'contract_signed', label: 'Contract' },
  { key: 'financing_funded', label: 'Funding' },
  { key: 'consent_signed', label: 'Consent' },
  { key: 'preop_instructions_sent', label: 'Pre-Op' },
  { key: 'surgery_scheduled', label: 'Surgery' },
  { key: 'records_confirmed', label: 'Records' },
]

// Base UI's <SelectValue> renders the raw value, so map each value → trigger label.
const FUNDING_TYPE_LABELS: Record<string, string> = {
  loan: 'Lender loan',
  cash: 'Cash / card',
  in_house: 'In-house plan',
  insurance: 'Insurance',
}

const RECORDS_LABELS: Record<keyof RecordsChecklist, string> = {
  medical_records: 'Medical records received',
  dental_records: 'Dental records received',
  ct_scan: 'CT / CBCT scan on file',
  prescription_ready: 'Prescriptions ready',
  surgical_guide_ready: 'Surgical guide ready',
  lab_work_ordered: 'Lab work ordered',
  anesthesia_confirmed: 'Anesthesia confirmed',
  surgeon_availability: 'Surgeon availability confirmed',
}

export function CaseClosingPanel({ caseId, onChanged }: { caseId: string; onChanged?: () => void }) {
  const router = useRouter()
  const [state, setState] = useState<ClosingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${caseId}/closing`)
      if (res.ok) setState(await res.json())
    } finally {
      setLoading(false)
    }
  }, [caseId])

  useEffect(() => { void refresh() }, [refresh])

  const advance = useCallback(async (step: TreatmentClosingStep, data: Record<string, unknown> = {}, label?: string) => {
    setBusy(step)
    try {
      const res = await fetch(`/api/cases/${caseId}/closing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, data }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to update')
      }
      toast.success(label ?? 'Step updated')
      await refresh()
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setBusy(null)
    }
  }, [caseId, refresh, onChanged])

  const patchChecklist = useCallback(async (key: string, value: boolean) => {
    setBusy(`records:${key}`)
    try {
      const res = await fetch(`/api/cases/${caseId}/closing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records_checklist: { [key]: value } }),
      })
      if (!res.ok) throw new Error('Failed to update checklist')
      await refresh()
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update checklist')
    } finally {
      setBusy(null)
    }
  }, [caseId, refresh, onChanged])

  if (loading) {
    return (
      <div className="aurea-card flex items-center justify-center p-10">
        <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
      </div>
    )
  }

  const closing = state?.closing ?? null
  const progress = state?.progress ?? null
  const completed = new Set(closing?.steps_completed ?? [])

  return (
    <div className="space-y-4">
      {/* Stepper */}
      <div className="aurea-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="aurea-eyebrow mb-1">Closing → Surgery</p>
            {progress ? (
              <p className="text-[13px] text-aurea-ink-2">
                {progress.next_action}
                {progress.surgery_in_days !== null && progress.surgery_in_days >= 0 && (
                  <span className="ml-2 font-mono text-[11px] text-aurea-ink-3">
                    surgery in {progress.surgery_in_days}d
                  </span>
                )}
              </p>
            ) : (
              <p className="text-[13px] text-aurea-ink-2">
                Start the closing once the patient agrees to treatment.
              </p>
            )}
          </div>
          {progress && (
            <span className="aurea-display text-[24px] tabular-nums text-aurea-ink">
              {progress.percent_complete}%
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {STEPS.map((step, i) => {
            const done = completed.has(step.key)
            const isCurrent = closing?.current_step === step.key
            return (
              <div key={step.key} className="flex items-center">
                {i > 0 && <div className={cn('h-px w-4 sm:w-7', done ? 'bg-aurea-primary/50' : 'bg-aurea-border')} />}
                <div className="flex flex-col items-center gap-1 px-1">
                  {done ? (
                    <CheckCircle2 className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
                  ) : (
                    <Circle className={cn('h-5 w-5', isCurrent ? 'text-aurea-amber' : 'text-aurea-ink-3/40')} strokeWidth={1.75} />
                  )}
                  <span className={cn(
                    'whitespace-nowrap text-[10px] font-medium',
                    done ? 'text-aurea-ink' : isCurrent ? 'text-aurea-amber' : 'text-aurea-ink-3'
                  )}>
                    {step.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {progress && progress.blockers.length > 0 && (
          <p className="mt-3 rounded-lg border border-aurea-amber/20 bg-aurea-amber/10 px-3 py-2 text-[12px] text-aurea-amber">
            {progress.blockers.join(' · ')}
          </p>
        )}

        {!closing && (
          <Button
            size="sm"
            className="mt-2 gap-2"
            disabled={busy !== null}
            onClick={() => advance('treatment_plan_presented', {}, 'Closing started')}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" strokeWidth={1.75} />}
            Start Closing
          </Button>
        )}
      </div>

      {closing && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ContractCard
            contract={state?.contract ?? null}
            closing={closing}
            busy={busy}
            onOpen={(id) => router.push(`/contracts/${id}`)}
            onMarkSigned={() => advance('contract_signed', {
              contract_amount: state?.contract?.contract_amount ?? closing.contract_amount ?? undefined,
            }, 'Contract marked signed')}
          />
          <FundingCard
            financing={state?.financing ?? null}
            closing={closing}
            busy={busy}
            onMarkFunded={(type) => advance('financing_funded', { financing_type: type }, 'Funding recorded')}
          />
          <ConsentCard
            closing={closing}
            busy={busy}
            onMarkSigned={(forms) => advance('consent_signed', { consent_forms: forms }, 'Consent recorded')}
          />
          <PreopCard
            caseId={caseId}
            closing={closing}
            forms={state?.preop_forms ?? []}
            onSent={() => { void refresh(); onChanged?.() }}
          />
          <SurgeryCard
            caseId={caseId}
            closing={closing}
            appointment={state?.surgery_appointment ?? null}
            onBooked={() => { void refresh(); onChanged?.() }}
          />
          <LabCard
            caseId={caseId}
            orders={state?.lab_orders ?? []}
            checklist={closing.records_checklist}
            busy={busy}
            onToggleOrdered={(v) => patchChecklist('lab_work_ordered', v)}
            onSubmitted={() => { void refresh(); onChanged?.() }}
          />
          <div className="lg:col-span-2">
            <IntakeCard
              caseId={caseId}
              closing={closing}
              onSaved={() => { void refresh(); onChanged?.() }}
            />
          </div>
          <div className="lg:col-span-2">
            <RecordsCard
              checklist={closing.records_checklist}
              confirmedAt={closing.records_confirmed_at}
              busy={busy}
              onToggle={patchChecklist}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Cards ───────────────────────────────────────────────────────

function CardShell({ icon: Icon, title, done, children }: {
  icon: React.ElementType
  title: string
  done?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('aurea-card overflow-hidden', done && 'border-aurea-primary/20')}>
      <div className="flex items-center gap-2 border-b border-aurea-border px-4 py-3">
        <Icon className={cn('h-4 w-4', done ? 'text-aurea-primary' : 'text-aurea-ink-3')} strokeWidth={1.75} />
        <h3 className="text-[14px] font-medium text-aurea-ink">{title}</h3>
        {done && <CheckCircle2 className="ml-auto h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function ContractCard({ contract, closing, busy, onOpen, onMarkSigned }: {
  contract: ContractSummary
  closing: TreatmentClosing
  busy: string | null
  onOpen: (id: string) => void
  onMarkSigned: () => void
}) {
  const done = !!closing.contract_signed_at
  return (
    <CardShell icon={FileSignature} title="Treatment Contract" done={done}>
      <div className="space-y-3">
        {contract ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13px] text-aurea-ink-2 capitalize">{contract.status.replace(/_/g, ' ')}</p>
              {contract.contract_amount != null && (
                <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
                  ${Number(contract.contract_amount).toLocaleString()}
                </p>
              )}
            </div>
            <Button variant="outline" size="sm" className="gap-1" onClick={() => onOpen(contract.id)}>
              Open <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            </Button>
          </div>
        ) : (
          <p className="text-[13px] text-aurea-ink-3">
            No contract yet — generate one from the Treatment Agreement section below.
          </p>
        )}
        {done ? (
          <p className="font-mono text-[11px] text-aurea-ink-3">
            Signed {new Date(closing.contract_signed_at!).toLocaleDateString()}
          </p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={onMarkSigned}
          >
            {busy === 'contract_signed' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Mark signed (paper)
          </Button>
        )}
      </div>
    </CardShell>
  )
}

function FundingCard({ financing, closing, busy, onMarkFunded }: {
  financing: FinancingSummary
  closing: TreatmentClosing
  busy: string | null
  onMarkFunded: (type: 'loan' | 'in_house' | 'cash' | 'insurance') => void
}) {
  const done = !!closing.financing_funded_at
  const [type, setType] = useState<'loan' | 'in_house' | 'cash' | 'insurance'>(closing.financing_type ?? 'loan')
  return (
    <CardShell icon={Banknote} title="Funding" done={done}>
      <div className="space-y-3">
        {financing && (
          <div className="rounded-lg bg-aurea-surface-2 p-2.5 text-[12px] text-aurea-ink-2">
            <span className="capitalize">{financing.status.replace(/_/g, ' ')}</span>
            {financing.approved_lender_slug && <> via <span className="font-medium">{financing.approved_lender_slug}</span></>}
            {financing.approved_amount != null && (
              <span className="ml-1 font-mono tabular-nums">${Number(financing.approved_amount).toLocaleString()}</span>
            )}
            {financing.approved_terms?.monthly_payment != null && (
              <span className="ml-1 font-mono text-[11px] text-aurea-ink-3">
                (${financing.approved_terms.monthly_payment}/mo)
              </span>
            )}
          </div>
        )}
        {done ? (
          <p className="font-mono text-[11px] text-aurea-ink-3">
            {closing.financing_type === 'cash' ? 'Paid' : 'Funded'} {new Date(closing.financing_funded_at!).toLocaleDateString()}
            {closing.financing_type && <span className="ml-1 capitalize">({closing.financing_type.replace('_', '-')})</span>}
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-[11px]">Payment method</Label>
              <Select items={FUNDING_TYPE_LABELS} value={type} onValueChange={(v) => v && setType(v as typeof type)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="loan">Lender loan</SelectItem>
                  <SelectItem value="cash">Cash / card</SelectItem>
                  <SelectItem value="in_house">In-house plan</SelectItem>
                  <SelectItem value="insurance">Insurance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => onMarkFunded(type)}>
              {busy === 'financing_funded' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Mark funded
            </Button>
          </div>
        )}
      </div>
    </CardShell>
  )
}

function ConsentCard({ closing, busy, onMarkSigned }: {
  closing: TreatmentClosing
  busy: string | null
  onMarkSigned: (forms: string[]) => void
}) {
  const done = !!closing.consent_signed_at
  const DEFAULT_FORMS = ['Surgical consent', 'Anesthesia consent']
  return (
    <CardShell icon={ShieldCheck} title="Consent Forms" done={done}>
      {done ? (
        <div className="space-y-1">
          <p className="font-mono text-[11px] text-aurea-ink-3">
            Signed {new Date(closing.consent_signed_at!).toLocaleDateString()}
          </p>
          {closing.consent_forms.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {closing.consent_forms.map((f) => (
                <span key={f} className="inline-flex rounded border border-aurea-border px-1.5 py-0.5 text-[11px] text-aurea-ink-2">{f}</span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-aurea-ink-3">
            Surgical + anesthesia consent, signed digitally or in office.
          </p>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => onMarkSigned(DEFAULT_FORMS)}>
            {busy === 'consent_signed' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Mark consents signed
          </Button>
        </div>
      )}
    </CardShell>
  )
}

function PreopCard({ caseId, closing, forms, onSent }: {
  caseId: string
  closing: TreatmentClosing
  forms: PreopSummary[]
  onSent: () => void
}) {
  const done = !!closing.preop_instructions_sent_at
  const [sending, setSending] = useState(false)
  const latest = forms[0] ?? null

  const send = async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/preop`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to send pre-op instructions')
      }
      const data = await res.json()
      toast.success(data.sent_via ? `Pre-op instructions sent via ${data.sent_via}` : 'Pre-op instructions sent')
      onSent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <CardShell icon={Send} title="Pre-Op Instructions" done={done}>
      <div className="space-y-3">
        {latest ? (
          <div className="rounded-lg bg-aurea-surface-2 p-2.5 text-[12px] text-aurea-ink-2">
            <span className="capitalize">{latest.status}</span>
            {latest.sent_at && <span className="ml-1 font-mono text-[11px] text-aurea-ink-3">sent {new Date(latest.sent_at).toLocaleDateString()}</span>}
            {latest.acknowledged_at && (
              <span className="ml-1 text-aurea-primary">· acknowledged {new Date(latest.acknowledged_at).toLocaleDateString()}</span>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-aurea-ink-3">
            Fasting, medications, ride arrangements — delivered by SMS/email with an acknowledgment link.
          </p>
        )}
        <Button variant={done ? 'ghost' : 'outline'} size="sm" disabled={sending} onClick={send}>
          {sending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {done ? 'Resend' : 'Send pre-op instructions'}
        </Button>
      </div>
    </CardShell>
  )
}

function SurgeryCard({ caseId, closing, appointment, onBooked }: {
  caseId: string
  closing: TreatmentClosing
  appointment: SurgeryAppointment
  onBooked: () => void
}) {
  const done = !!closing.surgery_date
  const [booking, setBooking] = useState(false)
  const [when, setWhen] = useState('')
  const [duration, setDuration] = useState('120')
  const [surgeryType, setSurgeryType] = useState('')

  const book = async () => {
    if (!when) { toast.error('Pick a surgery date & time'); return }
    setBooking(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/surgery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_at: new Date(when).toISOString(),
          duration_minutes: parseInt(duration) || 120,
          surgery_type: surgeryType || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to book surgery')
      }
      toast.success('Surgery booked — syncing to EHR')
      onBooked()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to book')
    } finally {
      setBooking(false)
    }
  }

  return (
    <CardShell icon={CalendarCheck} title="Surgery Date" done={done}>
      {done ? (
        <div className="space-y-1">
          <p className="text-[14px] font-medium text-aurea-ink">
            {new Date(`${closing.surgery_date}T${closing.surgery_time || '09:00'}`).toLocaleString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </p>
          {closing.surgery_type && <p className="text-[12px] text-aurea-ink-2">{closing.surgery_type}</p>}
          {appointment && (
            <p className="font-mono text-[11px] text-aurea-ink-3">
              EHR sync: {appointment.carestack_sync_status ?? 'pending'}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 space-y-1">
              <Label className="text-[11px]">Date & time</Label>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Duration (min)</Label>
              <Input type="number" min={30} step={30} value={duration} onChange={(e) => setDuration(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Procedure</Label>
              <Input placeholder="e.g. All-on-4, upper" value={surgeryType} onChange={(e) => setSurgeryType(e.target.value)} className="h-8" />
            </div>
          </div>
          <Button size="sm" disabled={booking} onClick={book} className="gap-2">
            {booking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarCheck className="h-3.5 w-3.5" strokeWidth={1.75} />}
            Book surgery
          </Button>
          <p className="text-[11px] text-aurea-ink-3">
            Books the chair, starts reminders, and syncs to CareStack + Dion Clinical.
          </p>
        </div>
      )}
    </CardShell>
  )
}

function LabCard({ caseId, orders, checklist, busy, onToggleOrdered, onSubmitted }: {
  caseId: string
  orders: LabOrder[]
  checklist: RecordsChecklist
  busy: string | null
  onToggleOrdered: (v: boolean) => void
  onSubmitted: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const active = orders.find((o) => !['cancelled', 'error'].includes(o.status)) ?? null

  const submit = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/lab-order`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to submit lab case')
      }
      toast.success('Case sent to Smile Design Lab')
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <CardShell icon={FlaskConical} title="Records to Lab" done={checklist.lab_work_ordered}>
      <div className="space-y-3">
        {active ? (
          <div className="rounded-lg bg-aurea-surface-2 p-2.5 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="capitalize text-aurea-ink-2">{active.status.replace(/_/g, ' ')}</span>
              {active.external_case_number && (
                <span className="font-mono text-[11px] text-aurea-ink-3">{active.external_case_number}</span>
              )}
            </div>
            {active.files_sent.length > 0 && (
              <p className="mt-1 font-mono text-[11px] text-aurea-ink-3">{active.files_sent.length} file(s) sent</p>
            )}
            {active.tracking?.tracking_number && (
              <p className="mt-1 font-mono text-[11px] text-aurea-ink-3">
                {active.tracking.carrier ?? 'Tracking'}: {active.tracking.tracking_number}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-aurea-ink-3">
            Send scans, photos and the lab slip to the lab for the surgical guide & restoration.
          </p>
        )}
        <div className="flex items-center gap-2">
          {!active && (
            <Button variant="outline" size="sm" disabled={submitting} onClick={submit}>
              {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Send to Smile Design Lab
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === 'records:lab_work_ordered'}
            onClick={() => onToggleOrdered(!checklist.lab_work_ordered)}
          >
            {checklist.lab_work_ordered ? 'Unmark ordered' : 'Mark ordered manually'}
          </Button>
        </div>
      </div>
    </CardShell>
  )
}

function IntakeField({ label, value, onChange, placeholder, className }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label className="text-[11px]">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8" />
    </div>
  )
}

function IntakeCard({ caseId, closing, onSaved }: {
  caseId: string
  closing: TreatmentClosing
  onSaved: () => void
}) {
  const i = closing.intake ?? {}
  const [pharmacy, setPharmacy] = useState(i.preferred_pharmacy ?? '')
  const [pcpName, setPcpName] = useState(i.pcp_name ?? '')
  const [pcpPhone, setPcpPhone] = useState(i.pcp_phone ?? '')
  const [driverName, setDriverName] = useState(i.driver_name ?? '')
  const [driverPhone, setDriverPhone] = useState(i.driver_phone ?? '')
  const [ecName, setEcName] = useState(i.emergency_contact_name ?? '')
  const [ecPhone, setEcPhone] = useState(i.emergency_contact_phone ?? '')
  const [preopDate, setPreopDate] = useState(i.preop_date ?? '')
  const [discount, setDiscount] = useState(i.discount_amount != null ? String(i.discount_amount) : '')
  const [smoker, setSmoker] = useState(!!i.uses_tobacco_vape_marijuana)
  const [saving, setSaving] = useState(false)

  // "Done" once the two sedation-critical fields are captured.
  const done = !!(driverName && ecName)

  const save = async () => {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        preferred_pharmacy: pharmacy.trim(),
        pcp_name: pcpName.trim(),
        pcp_phone: pcpPhone.trim(),
        driver_name: driverName.trim(),
        driver_phone: driverPhone.trim(),
        emergency_contact_name: ecName.trim(),
        emergency_contact_phone: ecPhone.trim(),
        preop_date: preopDate,
        uses_tobacco_vape_marijuana: smoker,
      }
      const d = parseFloat(discount)
      if (discount.trim() && Number.isFinite(d)) payload.discount_amount = d
      const res = await fetch(`/api/cases/${caseId}/intake`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to save intake')
      }
      toast.success('Pre-surgical intake saved')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <CardShell icon={ClipboardList} title="Pre-Surgical Intake" done={done}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <IntakeField label="Driver / escort name" value={driverName} onChange={setDriverName} placeholder="Required for sedation" />
          <IntakeField label="Driver / escort phone" value={driverPhone} onChange={setDriverPhone} />
          <IntakeField label="Emergency contact name" value={ecName} onChange={setEcName} />
          <IntakeField label="Emergency contact phone" value={ecPhone} onChange={setEcPhone} />
          <IntakeField label="Primary care physician" value={pcpName} onChange={setPcpName} />
          <IntakeField label="PCP phone" value={pcpPhone} onChange={setPcpPhone} />
          <IntakeField label="Preferred pharmacy" value={pharmacy} onChange={setPharmacy} className="sm:col-span-2" />
          <div className="space-y-1">
            <Label className="text-[11px]">Pre-op appointment date</Label>
            <Input type="date" value={preopDate} onChange={(e) => setPreopDate(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Discount amount ($)</Label>
            <Input type="number" min={0} step={100} value={discount} onChange={(e) => setDiscount(e.target.value)} className="h-8" placeholder="0" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-aurea-ink-2">
          <input
            type="checkbox"
            checked={smoker}
            onChange={(e) => setSmoker(e.target.checked)}
            className="h-4 w-4 rounded border-aurea-border"
          />
          Patient uses tobacco, vape, or marijuana (adds the smoker consent to the contract)
        </label>
        <Button size="sm" disabled={saving} onClick={save} className="gap-2">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardList className="h-3.5 w-3.5" strokeWidth={1.75} />}
          Save intake
        </Button>
        <p className="text-[11px] text-aurea-ink-3">
          Feeds the FMR contract (driver, pharmacy, PCP, emergency contact) and gates the smoker consent.
        </p>
      </div>
    </CardShell>
  )
}

function RecordsCard({ checklist, confirmedAt, busy, onToggle }: {
  checklist: RecordsChecklist
  confirmedAt: string | null
  busy: string | null
  onToggle: (key: string, value: boolean) => void
}) {
  const entries = Object.entries(RECORDS_LABELS) as Array<[keyof RecordsChecklist, string]>
  const doneCount = entries.filter(([k]) => checklist[k]).length
  return (
    <CardShell icon={ClipboardCheck} title={`Surgery Readiness (${doneCount}/${entries.length})`} done={!!confirmedAt}>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {entries.map(([key, label]) => {
          const checked = checklist[key]
          const isBusy = busy === `records:${key}`
          return (
            <button
              key={key}
              type="button"
              disabled={isBusy}
              onClick={() => onToggle(key, !checked)}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors',
                checked
                  ? 'border-aurea-primary/25 bg-aurea-primary/5 text-aurea-ink'
                  : 'border-aurea-border text-aurea-ink-2 hover:bg-aurea-surface-2'
              )}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-aurea-ink-3" />
              ) : checked ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-aurea-primary" strokeWidth={1.75} />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-aurea-ink-3/50" strokeWidth={1.75} />
              )}
              {label}
            </button>
          )
        })}
      </div>
      {confirmedAt ? (
        <p className="mt-3 font-mono text-[11px] text-aurea-primary">
          All records confirmed {new Date(confirmedAt).toLocaleDateString()} — case is ready for surgery.
        </p>
      ) : (
        <p className="mt-3 text-[11px] text-aurea-ink-3">
          When every item is checked, the case moves to Ready for Surgery.
        </p>
      )}
    </CardShell>
  )
}
