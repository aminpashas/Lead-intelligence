'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import { useOrgStore } from '@/lib/store/use-org'
import { hasPermission, type PracticeRole } from '@/lib/auth/permissions'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowLeft,
  Loader2,
  Brain,
  Stethoscope,
  ClipboardList,
  Send,
  CheckCircle2,
  FileImage,
  AlertTriangle,
  Plus,
  Trash2,
  Eye,
  ExternalLink,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { ClinicalCase, CaseTreatmentItem } from '@/types/database'

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  intake: { label: 'Intake', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  analysis: { label: 'AI Analysis', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' },
  diagnosis: { label: 'Needs Diagnosis', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  treatment_planning: { label: 'Treatment Planning', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  patient_review: { label: 'Patient Review', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
}

export default function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole
  const canDiagnose = hasPermission(role, 'cases:diagnose')

  const [caseData, setCaseData] = useState<ClinicalCase | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchCase = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${id}`)
      const data = await res.json()
      if (data.case) setCaseData(data.case)
    } catch {
      toast.error('Failed to load case')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchCase() }, [fetchCase])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!caseData) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Case not found</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/cases')}>
          Back to Cases
        </Button>
      </div>
    )
  }

  const statusInfo = STATUS_LABELS[caseData.status] || STATUS_LABELS.intake

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/cases')} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{caseData.patient_name}</h1>
            <Badge variant="outline" className="text-xs">{caseData.case_number}</Badge>
            <Badge className={cn('text-xs', statusInfo.color)}>{statusInfo.label}</Badge>
            {caseData.priority !== 'normal' && (
              <Badge variant="outline" className={cn('text-xs',
                caseData.priority === 'urgent' ? 'border-red-500/50 text-red-600' :
                caseData.priority === 'high' ? 'border-amber-500/50 text-amber-600' :
                'border-slate-500/50 text-slate-600'
              )}>
                {caseData.priority === 'urgent' && <AlertTriangle className="h-3 w-3 mr-1" />}
                {caseData.priority}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1">{caseData.chief_complaint}</p>
          {caseData.assigned_doctor && (
            <div className="flex items-center gap-2 mt-2">
              <Stethoscope className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Assigned to Dr. {caseData.assigned_doctor.full_name}
                {caseData.assigned_doctor.specialty && ` (${caseData.assigned_doctor.specialty})`}
              </span>
            </div>
          )}
        </div>

        {/* Send to Patient */}
        {caseData.status === 'patient_review' && caseData.patient_email && (
          <Button
            className="gap-2 shrink-0"
            onClick={async () => {
              const res = await fetch(`/api/cases/${id}/notify-patient`, { method: 'POST' })
              if (res.ok) {
                toast.success('Treatment plan sent to patient!')
                fetchCase()
              } else {
                toast.error('Failed to send notification')
              }
            }}
          >
            <Send className="h-4 w-4" /> Send to Patient
          </Button>
        )}
        {caseData.status === 'patient_review' && !caseData.patient_email && (
          <Badge variant="outline" className="text-xs text-amber-600 shrink-0">
            No patient email — add email to send
          </Badge>
        )}
        {caseData.patient_notified_at && (
          <Badge variant="outline" className="text-xs text-emerald-600 shrink-0 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Sent {new Date(caseData.patient_notified_at).toLocaleDateString()}
          </Badge>
        )}
      </div>

      {/* Files Gallery */}
      {caseData.files && caseData.files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileImage className="h-4 w-4" /> Uploaded Files ({caseData.files.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {caseData.files.map((file) => (
                <div key={file.id} className="group relative rounded-lg border overflow-hidden">
                  {file.mime_type?.startsWith('image/') ? (
                    <img
                      src={file.file_url}
                      alt={file.file_name}
                      className="w-full h-32 object-cover"
                    />
                  ) : (
                    <div className="w-full h-32 bg-muted flex items-center justify-center">
                      <FileImage className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs font-medium truncate">{file.file_name}</p>
                    <div className="flex items-center gap-1 mt-1">
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                        {file.file_type}
                      </Badge>
                      {file.ai_analyzed_at && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-violet-600 border-violet-500/25">
                          <Brain className="h-2.5 w-2.5 mr-0.5" /> AI
                        </Badge>
                      )}
                    </div>
                  </div>
                  <a
                    href={file.file_url}
                    target="_blank"
                    rel="noopener"
                    className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Eye className="h-6 w-6 text-white" />
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Analysis */}
      {caseData.ai_analysis_summary && (() => {
        const analysis = caseData.ai_analysis_summary as {
          summary?: string
          findings?: Array<{ area: string; condition: string; severity: string; notes?: string }>
          recommended_procedures?: string[]
        }
        return (
          <Card className="border-violet-500/20">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4 text-violet-600" /> AI Analysis
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {analysis.summary && (
                <p className="text-sm">{analysis.summary}</p>
              )}
              {Array.isArray(analysis.findings) && analysis.findings.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Findings</p>
                  {analysis.findings.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm bg-muted/50 rounded-lg p-3">
                      <Badge variant="outline" className={cn('text-[10px] shrink-0',
                        f.severity === 'critical' ? 'border-red-500/50 text-red-600' :
                        f.severity === 'severe' ? 'border-amber-500/50 text-amber-600' :
                        'border-blue-500/50 text-blue-600'
                      )}>
                        {f.severity}
                      </Badge>
                      <div>
                        <span className="font-medium">{f.area}</span>: {f.condition}
                        {f.notes && <p className="text-xs text-muted-foreground mt-0.5">{f.notes}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {Array.isArray(analysis.recommended_procedures) && analysis.recommended_procedures.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Recommended Procedures</p>
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.recommended_procedures.map((p, i) => (
                      <Badge key={i} variant="outline" className="text-xs">{p}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )
      })()}

      {/* Diagnosis Section */}
      {(caseData.status === 'diagnosis' || caseData.status === 'treatment_planning' || caseData.diagnosis) && (
        <DiagnosisSection
          caseId={id}
          diagnosis={caseData.diagnosis || null}
          canDiagnose={canDiagnose}
          onSaved={fetchCase}
        />
      )}

      {/* Treatment Plan Section */}
      {(caseData.status === 'treatment_planning' || caseData.treatment_plan) && (
        <TreatmentPlanSection
          caseId={id}
          treatmentPlan={caseData.treatment_plan || null}
          canDiagnose={canDiagnose}
          onSaved={fetchCase}
        />
      )}

      {/* Complete Case */}
      {caseData.status === 'patient_review' && canDiagnose && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="gap-2"
            onClick={async () => {
              await fetch(`/api/cases/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
              })
              toast.success('Case marked as completed')
              fetchCase()
            }}
          >
            <CheckCircle2 className="h-4 w-4" /> Mark Completed
          </Button>
        </div>
      )}

      {/* Contract generation — surfaced once there is a treatment plan */}
      {caseData.treatment_plan && canDiagnose && (
        <ContractActionsSection caseId={id} caseStatus={caseData.status} />
      )}
    </div>
  )
}

function ContractActionsSection({ caseId, caseStatus }: { caseId: string; caseStatus: string }) {
  const router = useRouter()
  const [contract, setContract] = useState<{ id: string; status: string; needs_manual_draft: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/contracts?status=`)
      if (res.ok) {
        const data = await res.json()
        const match = (data.contracts ?? []).find(
          (c: { clinical_case_id: string; status: string }) =>
            c.clinical_case_id === caseId &&
            !['voided', 'expired', 'declined'].includes(c.status)
        )
        setContract(match ?? null)
      }
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void refresh() }, [caseId])

  const generate = async () => {
    setGenerating(true)
    const res = await fetch('/api/contracts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id: caseId }),
    })
    setGenerating(false)
    if (res.ok) {
      const data = await res.json()
      toast.success(data.needs_manual_draft ? 'Contract stub created — manual draft needed' : 'Contract generated')
      router.push(`/contracts/${data.contract_id}`)
      return
    }
    const err = await res.json().catch(() => ({}))
    if (err.code === 'missing_legal') {
      toast.error('Configure legal settings first')
      router.push('/settings/legal')
      return
    }
    toast.error(err.error ?? 'Contract generation failed')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" /> Treatment Agreement
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-slate-500">Checking contract status…</div>
        ) : contract ? (
          <div className="flex items-center justify-between">
            <div>
              <Badge variant="outline">{contract.status}</Badge>
              {contract.needs_manual_draft && (
                <Badge variant="outline" className="ml-2 text-amber-700 border-amber-300">Manual draft needed</Badge>
              )}
            </div>
            <Button size="sm" onClick={() => router.push(`/contracts/${contract.id}`)}>
              Open contract
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600">
              {caseStatus === 'completed' || caseStatus === 'patient_review'
                ? 'Ready to generate the treatment services agreement.'
                : 'Generate the agreement now, or wait until the patient accepts the plan.'}
            </div>
            <Button size="sm" onClick={generate} disabled={generating}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Generate contract
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Diagnosis Form ──────────────────────────────────────────────

function DiagnosisSection({
  caseId,
  diagnosis,
  canDiagnose,
  onSaved,
}: {
  caseId: string
  diagnosis: ClinicalCase['diagnosis']
  canDiagnose: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(!diagnosis && canDiagnose)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    diagnosis_summary: diagnosis?.diagnosis_summary || '',
    severity: diagnosis?.severity || 'moderate',
    bone_quality: diagnosis?.bone_quality || '',
    soft_tissue_status: diagnosis?.soft_tissue_status || '',
    occlusion_notes: diagnosis?.occlusion_notes || '',
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error)
      }
      toast.success('Diagnosis saved')
      setEditing(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="border-blue-500/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-blue-600" /> Diagnosis
          </CardTitle>
          {diagnosis && canDiagnose && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Diagnosis Summary *</Label>
              <Textarea
                value={form.diagnosis_summary}
                onChange={e => setForm({ ...form, diagnosis_summary: e.target.value })}
                placeholder="Clinical diagnosis and findings..."
                rows={4}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Severity</Label>
                <Select value={form.severity} onValueChange={v => v && setForm({ ...form, severity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mild">Mild</SelectItem>
                    <SelectItem value="moderate">Moderate</SelectItem>
                    <SelectItem value="severe">Severe</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Bone Quality</Label>
                <Input
                  value={form.bone_quality}
                  onChange={e => setForm({ ...form, bone_quality: e.target.value })}
                  placeholder="e.g., D2-D3, adequate"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Soft Tissue Status</Label>
                <Input
                  value={form.soft_tissue_status}
                  onChange={e => setForm({ ...form, soft_tissue_status: e.target.value })}
                  placeholder="e.g., Mild inflammation"
                />
              </div>
              <div className="space-y-2">
                <Label>Occlusion Notes</Label>
                <Input
                  value={form.occlusion_notes}
                  onChange={e => setForm({ ...form, occlusion_notes: e.target.value })}
                  placeholder="e.g., Class I, open bite"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              {diagnosis && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              )}
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
                Save Diagnosis
              </Button>
            </div>
          </form>
        ) : diagnosis ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('text-xs',
                diagnosis.severity === 'critical' ? 'border-red-500/50 text-red-600' :
                diagnosis.severity === 'severe' ? 'border-amber-500/50 text-amber-600' :
                'border-blue-500/50 text-blue-600'
              )}>
                {diagnosis.severity}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Diagnosed {new Date(diagnosis.diagnosed_at).toLocaleDateString()}
              </span>
            </div>
            <p className="text-sm">{diagnosis.diagnosis_summary}</p>
            {(diagnosis.bone_quality || diagnosis.soft_tissue_status || diagnosis.occlusion_notes) && (
              <div className="grid gap-2 sm:grid-cols-3 text-sm">
                {diagnosis.bone_quality && (
                  <div className="bg-muted/50 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground">Bone Quality</p>
                    <p className="font-medium">{diagnosis.bone_quality}</p>
                  </div>
                )}
                {diagnosis.soft_tissue_status && (
                  <div className="bg-muted/50 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground">Soft Tissue</p>
                    <p className="font-medium">{diagnosis.soft_tissue_status}</p>
                  </div>
                )}
                {diagnosis.occlusion_notes && (
                  <div className="bg-muted/50 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground">Occlusion</p>
                    <p className="font-medium">{diagnosis.occlusion_notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            {canDiagnose ? 'Click "Edit" to add a diagnosis' : 'Waiting for doctor to add diagnosis'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Treatment Plan Form ─────────────────────────────────────────

function TreatmentPlanSection({
  caseId,
  treatmentPlan,
  canDiagnose,
  onSaved,
}: {
  caseId: string
  treatmentPlan: ClinicalCase['treatment_plan']
  canDiagnose: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(!treatmentPlan && canDiagnose)
  const [submitting, setSubmitting] = useState(false)
  const [planSummary, setPlanSummary] = useState(treatmentPlan?.plan_summary || '')
  const [estimatedDuration, setEstimatedDuration] = useState(treatmentPlan?.estimated_duration || '')
  const [items, setItems] = useState<CaseTreatmentItem[]>(
    treatmentPlan?.items || [{ procedure: '', description: '', phase: 1, estimated_cost: 0 }]
  )

  function addItem() {
    setItems(prev => [...prev, { procedure: '', description: '', phase: 1, estimated_cost: 0 }])
  }

  function updateItem(index: number, field: keyof CaseTreatmentItem, value: string | number) {
    setItems(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const totalCost = items.reduce((sum, item) => sum + (Number(item.estimated_cost) || 0), 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`/api/cases/${caseId}/treatment-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_summary: planSummary,
          items: items.filter(i => i.procedure),
          total_estimated_cost: totalCost,
          estimated_duration: estimatedDuration,
          phases: Math.max(...items.map(i => i.phase || 1)),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error)
      }
      toast.success('Treatment plan saved — case moved to patient review')
      setEditing(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="border-amber-500/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-amber-600" /> Treatment Plan
          </CardTitle>
          {treatmentPlan && canDiagnose && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Plan Summary *</Label>
                <Textarea
                  value={planSummary}
                  onChange={e => setPlanSummary(e.target.value)}
                  placeholder="Overview of the treatment plan..."
                  rows={3}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Estimated Duration</Label>
                <Input
                  value={estimatedDuration}
                  onChange={e => setEstimatedDuration(e.target.value)}
                  placeholder="e.g., 6-8 months"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Procedures</Label>
                <Button type="button" variant="outline" size="sm" className="gap-1 h-7" onClick={addItem}>
                  <Plus className="h-3 w-3" /> Add
                </Button>
              </div>
              {items.map((item, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_80px_60px_36px] items-end border rounded-lg p-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Procedure</Label>
                    <Input
                      value={item.procedure}
                      onChange={e => updateItem(i, 'procedure', e.target.value)}
                      placeholder="e.g., All-on-4"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={item.description}
                      onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Details..."
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Cost ($)</Label>
                    <Input
                      type="number"
                      value={item.estimated_cost || ''}
                      onChange={e => updateItem(i, 'estimated_cost', parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phase</Label>
                    <Input
                      type="number"
                      min={1}
                      value={item.phase}
                      onChange={e => updateItem(i, 'phase', parseInt(e.target.value) || 1)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeItem(i)}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
              <div className="text-right">
                <p className="text-sm font-semibold">Total: ${totalCost.toLocaleString()}</p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              {treatmentPlan && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              )}
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
                Save Treatment Plan
              </Button>
            </div>
          </form>
        ) : treatmentPlan ? (
          <div className="space-y-4">
            <p className="text-sm">{treatmentPlan.plan_summary}</p>
            {treatmentPlan.estimated_duration && (
              <p className="text-xs text-muted-foreground">Duration: {treatmentPlan.estimated_duration}</p>
            )}
            <div className="space-y-2">
              {treatmentPlan.items.map((item, i) => (
                <div key={i} className="flex items-center gap-3 bg-muted/50 rounded-lg p-3">
                  <Badge variant="outline" className="text-[10px] shrink-0">Phase {item.phase}</Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{item.procedure}</p>
                    {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                  </div>
                  <span className="text-sm font-semibold shrink-0">${Number(item.estimated_cost).toLocaleString()}</span>
                </div>
              ))}
            </div>
            <Separator />
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total Estimated Cost</span>
              <span className="text-lg font-bold">
                ${Number(treatmentPlan.total_estimated_cost || 0).toLocaleString()}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            {canDiagnose ? 'Add a treatment plan to send to the patient' : 'Waiting for doctor to create treatment plan'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
