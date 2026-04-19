'use client'

import { useEffect, useState, use } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Stethoscope,
  ClipboardList,
  CheckCircle2,
  FileImage,
  MessageSquare,
  Brain,
  Loader2,
  Shield,
  Calendar,
  DollarSign,
  Heart,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-50 to-white dark:from-slate-950 dark:to-slate-900">
        <div className="text-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading your case...</p>
        </div>
      </div>
    )
  }

  if (error || !caseData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-50 to-white dark:from-slate-950 dark:to-slate-900">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="p-8 text-center">
            <Shield className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
            <p className="text-sm text-muted-foreground">{error || 'Case not found'}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const totalCost = caseData.treatment_plan?.total_estimated_cost || 0

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white dark:from-slate-950 dark:to-slate-900">
      {/* Hero header */}
      <div className="bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 text-white">
        <div className="max-w-3xl mx-auto px-4 py-12 sm:py-16">
          <div className="flex items-center gap-2 mb-4 text-white/70 text-sm">
            <Shield className="h-4 w-4" />
            <span>Secure Patient Portal</span>
            <span>•</span>
            <span>{caseData.case_number}</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3">Your Treatment Plan</h1>
          <p className="text-white/80 text-lg">
            Hello {caseData.patient_name.split(' ')[0]}, your doctor has prepared a detailed treatment plan for you.
          </p>
          {caseData.assigned_doctor && (
            <div className="flex items-center gap-2 mt-4 text-white/70 text-sm">
              <Stethoscope className="h-4 w-4" />
              <span>
                Dr. {caseData.assigned_doctor.full_name}
                {caseData.assigned_doctor.specialty && ` — ${caseData.assigned_doctor.specialty}`}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6 -mt-4">
        {/* Diagnosis card */}
        {caseData.diagnosis && (
          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="h-8 w-8 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
                  <Stethoscope className="h-4 w-4 text-blue-600" />
                </div>
                Diagnosis
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm leading-relaxed">{caseData.diagnosis.diagnosis_summary}</p>
              <div className="flex flex-wrap gap-4 text-sm">
                {caseData.diagnosis.bone_quality && (
                  <div className="rounded-lg bg-muted/50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">Bone Quality</p>
                    <p className="font-medium">{caseData.diagnosis.bone_quality}</p>
                  </div>
                )}
                {caseData.diagnosis.soft_tissue_status && (
                  <div className="rounded-lg bg-muted/50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">Soft Tissue</p>
                    <p className="font-medium">{caseData.diagnosis.soft_tissue_status}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Treatment Plan */}
        {caseData.treatment_plan && (
          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="h-8 w-8 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
                  <ClipboardList className="h-4 w-4 text-amber-600" />
                </div>
                Treatment Plan
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-relaxed">{caseData.treatment_plan.plan_summary}</p>

              {caseData.treatment_plan.estimated_duration && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  Estimated duration: {caseData.treatment_plan.estimated_duration}
                </div>
              )}

              <Separator />

              <div className="space-y-3">
                {caseData.treatment_plan.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-xl bg-muted/30 p-4">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{item.procedure}</p>
                      {item.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{item.description}</p>
                      )}
                      <Badge variant="outline" className="text-[10px] mt-1">Phase {item.phase}</Badge>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm">${Number(item.estimated_cost).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium">Total Estimated Cost</span>
                </div>
                <span className="text-2xl font-bold text-primary">
                  ${totalCost.toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Images */}
        {caseData.files.length > 0 && (
          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="h-8 w-8 rounded-lg bg-violet-50 dark:bg-violet-900/20 flex items-center justify-center">
                  <FileImage className="h-4 w-4 text-violet-600" />
                </div>
                Your Images ({caseData.files.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {caseData.files.filter(f => f.mime_type?.startsWith('image/')).map((file) => (
                  <a
                    key={file.id}
                    href={file.file_url}
                    target="_blank"
                    rel="noopener"
                    className="rounded-xl overflow-hidden border hover:shadow-md transition-shadow"
                  >
                    <img src={file.file_url} alt={file.file_name} className="w-full h-32 object-cover" />
                    <div className="p-2">
                      <Badge variant="outline" className="text-[10px]">{file.file_type}</Badge>
                    </div>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Accept / Next Steps */}
        <Card className="shadow-lg border-0 bg-gradient-to-br from-emerald-50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10">
          <CardContent className="p-6 text-center">
            {accepted ? (
              <div className="space-y-3">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
                <h3 className="text-lg font-semibold">Plan Acknowledged</h3>
                <p className="text-sm text-muted-foreground">
                  Thank you! Our team will be in touch to schedule your next appointment.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <Heart className="h-10 w-10 text-emerald-600 mx-auto" />
                <h3 className="text-lg font-semibold">Ready to proceed?</h3>
                <p className="text-sm text-muted-foreground">
                  If you have questions, please contact our office. When you&apos;re ready, acknowledge the plan below.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                  <Button
                    size="lg"
                    className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                    onClick={async () => {
                      await fetch(`/api/cases/patient/${shareToken}/accept`, { method: 'POST' }).catch(() => {})
                      setAccepted(true)
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4" /> Acknowledge Treatment Plan
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground pb-8">
          This is a confidential medical document. If you received this in error, please disregard.
        </p>
      </div>
    </div>
  )
}
