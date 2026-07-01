'use client'

import { useEffect, useState, use } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Stethoscope,
  ClipboardList,
  CheckCircle2,
  FileImage,
  Loader2,
  Shield,
  Calendar,
  DollarSign,
  Heart,
} from 'lucide-react'

type PatientCaseData = {
  case_number: string
  patient_name: string
  chief_complaint: string
  status: string
  files: Array<{
    id: string
    file_name: string
    file_url: string
    file_type: string
    mime_type: string | null
  }>
  diagnosis: {
    diagnosis_summary: string
    severity: string
    bone_quality: string | null
    soft_tissue_status: string | null
  } | null
  treatment_plan: {
    plan_summary: string
    total_estimated_cost: number | null
    estimated_duration: string | null
    items: Array<{
      procedure: string
      description: string
      phase: number
      estimated_cost: number
    }>
  } | null
  assigned_doctor: {
    full_name: string
    specialty: string | null
  } | null
}

export default function PatientCaseReviewPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId: shareToken } = use(params)
  const [caseData, setCaseData] = useState<PatientCaseData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    async function fetchCase() {
      try {
        const res = await fetch(`/api/cases/patient/${shareToken}`)
        if (!res.ok) {
          setError('This link is invalid or has expired.')
          return
        }
        const data = await res.json()
        setCaseData(data.case)
      } catch {
        setError('Failed to load your case.')
      } finally {
        setLoading(false)
      }
    }
    fetchCase()
  }, [shareToken])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 animate-in fade-in-0 duration-500">
        <div className="text-center">
          <Loader2 className="h-10 w-10 animate-spin text-aurea-primary mx-auto mb-4" strokeWidth={1.75} />
          <p className="text-aurea-ink-3 text-[14px]">Loading your case...</p>
        </div>
      </div>
    )
  }

  if (error || !caseData) {
    return (
      <div className="flex items-center justify-center py-24 animate-in fade-in-0 duration-500">
        <div className="aurea-card max-w-md w-full mx-4 p-8 text-center">
          <Shield className="h-12 w-12 text-aurea-ink-3 mx-auto mb-4" strokeWidth={1.75} />
          <h2 className="aurea-display text-[22px] text-aurea-ink mb-2">Access Denied</h2>
          <p className="text-[14px] text-aurea-ink-3">{error || 'Case not found'}</p>
        </div>
      </div>
    )
  }

  const totalCost = caseData.treatment_plan?.total_estimated_cost || 0

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Deep-ink hero ── */}
      <div className="relative overflow-hidden bg-aurea-ink">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(70% 60% at 100% 0%, oklch(0.7 0.14 162 / 0.14) 0%, transparent 60%)' }}
        />
        <div className="relative max-w-3xl mx-auto px-4 py-12 sm:py-16">
          <p className="aurea-eyebrow text-aurea-primary mb-4">
            Secure Patient Portal &middot; {caseData.case_number}
          </p>
          <h1 className="aurea-display text-[34px] sm:text-[42px] text-white leading-[1.06] mb-3">
            Your Treatment Plan
          </h1>
          <p className="text-white/75 text-[16px] leading-relaxed">
            Hello {caseData.patient_name.split(' ')[0]}, your doctor has prepared a detailed treatment plan for you.
          </p>
          {caseData.assigned_doctor && (
            <div className="flex items-center gap-2 mt-4 text-white/55 text-[13px]">
              <Stethoscope className="h-[15px] w-[15px]" strokeWidth={1.75} />
              <span>
                Dr. {caseData.assigned_doctor.full_name}
                {caseData.assigned_doctor.specialty && ` — ${caseData.assigned_doctor.specialty}`}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
        {/* Diagnosis card */}
        {caseData.diagnosis && (
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-aurea-border px-5 py-4">
              <div className="h-8 w-8 rounded-lg bg-aurea-surface-2 flex items-center justify-center shrink-0">
                <Stethoscope className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
              </div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Diagnosis</h2>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-[14px] leading-relaxed text-aurea-ink-2">{caseData.diagnosis.diagnosis_summary}</p>
              <div className="flex flex-wrap gap-3 text-[13px]">
                {caseData.diagnosis.bone_quality && (
                  <div className="rounded-lg bg-aurea-surface-2 border border-aurea-border px-3 py-2">
                    <p className="aurea-eyebrow text-aurea-ink-3 mb-1">Bone Quality</p>
                    <p className="font-medium text-aurea-ink">{caseData.diagnosis.bone_quality}</p>
                  </div>
                )}
                {caseData.diagnosis.soft_tissue_status && (
                  <div className="rounded-lg bg-aurea-surface-2 border border-aurea-border px-3 py-2">
                    <p className="aurea-eyebrow text-aurea-ink-3 mb-1">Soft Tissue</p>
                    <p className="font-medium text-aurea-ink">{caseData.diagnosis.soft_tissue_status}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Treatment Plan */}
        {caseData.treatment_plan && (
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-aurea-border px-5 py-4">
              <div className="h-8 w-8 rounded-lg bg-aurea-surface-2 flex items-center justify-center shrink-0">
                <ClipboardList className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
              </div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Treatment Plan</h2>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-[14px] leading-relaxed text-aurea-ink-2">{caseData.treatment_plan.plan_summary}</p>

              {caseData.treatment_plan.estimated_duration && (
                <div className="flex items-center gap-2 text-[13px] text-aurea-ink-3">
                  <Calendar className="h-[15px] w-[15px]" strokeWidth={1.75} />
                  Estimated duration: {caseData.treatment_plan.estimated_duration}
                </div>
              )}

              <div className="border-t border-aurea-border" />

              <div className="space-y-2">
                {caseData.treatment_plan.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-lg bg-aurea-surface-2 border border-aurea-border p-4">
                    <div className="h-8 w-8 rounded-full bg-aurea-primary/10 flex items-center justify-center text-[12px] font-bold text-aurea-primary shrink-0 font-mono tabular-nums">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[14px] text-aurea-ink">{item.procedure}</p>
                      {item.description && (
                        <p className="text-[13px] text-aurea-ink-3 mt-0.5">{item.description}</p>
                      )}
                      <Badge variant="outline" className="text-[10px] mt-1.5">Phase {item.phase}</Badge>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono tabular-nums text-[14px] font-semibold text-aurea-ink">
                        ${Number(item.estimated_cost).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-aurea-border" />

              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2 text-aurea-ink-2">
                  <DollarSign className="h-[17px] w-[17px]" strokeWidth={1.75} />
                  <span className="text-[14px] font-medium">Total Estimated Cost</span>
                </div>
                <span className="aurea-display tabular-nums text-[26px] text-aurea-primary">
                  ${totalCost.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Images */}
        {caseData.files.length > 0 && (
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-aurea-border px-5 py-4">
              <div className="h-8 w-8 rounded-lg bg-aurea-surface-2 flex items-center justify-center shrink-0">
                <FileImage className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
              </div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">
                Your Images ({caseData.files.length})
              </h2>
            </div>
            <div className="px-5 py-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {caseData.files.filter(f => f.mime_type?.startsWith('image/')).map((file) => (
                  <a
                    key={file.id}
                    href={file.file_url}
                    target="_blank"
                    rel="noopener"
                    className="rounded-lg overflow-hidden border border-aurea-border hover:border-aurea-border-strong transition-colors"
                  >
                    <img src={file.file_url} alt={file.file_name} className="w-full h-32 object-cover" />
                    <div className="p-2 bg-aurea-surface-2">
                      <Badge variant="outline" className="text-[10px]">{file.file_type}</Badge>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Accept / Next Steps */}
        <div className="aurea-card p-6 text-center">
          {accepted ? (
            <div className="space-y-3">
              <CheckCircle2 className="h-12 w-12 text-aurea-primary mx-auto" strokeWidth={1.75} />
              <h3 className="aurea-display text-[22px] text-aurea-ink">Plan Acknowledged</h3>
              <p className="text-[14px] text-aurea-ink-3 max-w-sm mx-auto">
                Thank you! Our team will be in touch to schedule your next appointment.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <Heart className="h-10 w-10 text-aurea-primary mx-auto" strokeWidth={1.75} />
              <h3 className="aurea-display text-[22px] text-aurea-ink">Ready to proceed?</h3>
              <p className="text-[14px] text-aurea-ink-3 max-w-sm mx-auto">
                If you have questions, please contact our office. When you&apos;re ready, acknowledge the plan below.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <Button
                  size="lg"
                  className="gap-2 bg-aurea-primary text-white hover:bg-aurea-primary/90"
                  onClick={async () => {
                    await fetch(`/api/cases/patient/${shareToken}/accept`, { method: 'POST' }).catch(() => {})
                    setAccepted(true)
                  }}
                >
                  <CheckCircle2 className="h-[17px] w-[17px]" strokeWidth={1.75} /> Acknowledge Treatment Plan
                </Button>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-[11.5px] text-aurea-ink-3 pb-8">
          This is a confidential medical document. If you received this in error, please disregard.
        </p>
      </div>
    </div>
  )
}
