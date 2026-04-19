'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Upload,
  X,
  FileImage,
  FileText,
  Loader2,
  ArrowLeft,
  Stethoscope,
  Camera,
  ScanLine,
  Box,
  FolderPlus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { UserProfile, CaseFileType } from '@/types/database'

const FILE_TYPE_OPTIONS: { value: CaseFileType; label: string; icon: React.ElementType }[] = [
  { value: 'intraoral', label: 'Intraoral Photo', icon: Camera },
  { value: 'extraoral', label: 'Extraoral Photo', icon: Camera },
  { value: 'xray', label: 'X-Ray', icon: ScanLine },
  { value: 'panoramic', label: 'Panoramic', icon: ScanLine },
  { value: 'periapical', label: 'Periapical', icon: ScanLine },
  { value: 'cephalometric', label: 'Cephalometric', icon: ScanLine },
  { value: 'cbct', label: 'CBCT Scan', icon: Box },
  { value: 'ct_scan', label: 'CT Scan', icon: Box },
  { value: 'stl', label: 'STL Model', icon: Box },
  { value: 'photo', label: 'Other Photo', icon: FileImage },
  { value: 'other', label: 'Other', icon: FileText },
]

type PendingFile = {
  file: File
  fileType: CaseFileType
  preview: string | null
}

export default function NewCasePage() {
  return (
    <RoleGuard requiredPermission="cases:create">
      <NewCaseContent />
    </RoleGuard>
  )
}

function NewCaseContent() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [doctors, setDoctors] = useState<UserProfile[]>([])
  const [form, setForm] = useState({
    patient_name: '',
    patient_email: '',
    patient_phone: '',
    chief_complaint: '',
    clinical_notes: '',
    assigned_doctor_id: '',
    priority: 'normal',
  })
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])

  useEffect(() => {
    fetch('/api/team')
      .then(r => r.json())
      .then(data => {
        if (data.members) {
          setDoctors(data.members.filter((m: UserProfile) =>
            ['doctor_admin', 'doctor'].includes(m.role) && m.is_active
          ))
        }
      })
      .catch(() => {})
  }, [])

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const items = Array.from(e.dataTransfer.files)
    addFiles(items)
  }, [])

  function addFiles(files: File[]) {
    const newPending: PendingFile[] = files.map((file) => {
      let fileType: CaseFileType = 'photo'
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (ext === 'stl') fileType = 'stl'
      else if (ext === 'dcm' || ext === 'dicom') fileType = 'ct_scan'
      else if (file.type.startsWith('image/')) fileType = 'photo'

      return {
        file,
        fileType,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }
    })
    setPendingFiles(prev => [...prev, ...newPending])
  }

  function removeFile(index: number) {
    setPendingFiles(prev => {
      const updated = [...prev]
      if (updated[index].preview) URL.revokeObjectURL(updated[index].preview!)
      updated.splice(index, 1)
      return updated
    })
  }

  function updateFileType(index: number, fileType: CaseFileType) {
    setPendingFiles(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], fileType }
      return updated
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.patient_name || !form.chief_complaint) {
      toast.error('Patient name and chief complaint are required')
      return
    }

    setSubmitting(true)

    try {
      // 1. Create the case
      const caseRes = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const caseData = await caseRes.json()
      if (!caseRes.ok) throw new Error(caseData.error)

      const caseId = caseData.case.id

      // 2. Upload files if any
      if (pendingFiles.length > 0) {
        const formData = new FormData()
        pendingFiles.forEach(pf => {
          formData.append('files', pf.file)
          formData.append('file_types', pf.fileType)
        })

        const fileRes = await fetch(`/api/cases/${caseId}/files`, {
          method: 'POST',
          body: formData,
        })
        const fileData = await fileRes.json()
        if (!fileRes.ok) {
          toast.error('Case created but file upload failed')
        } else {
          toast.success(
            `Case created with ${fileData.files?.length || 0} files. ${fileData.analysis_count > 0 ? `AI analyzed ${fileData.analysis_count} images.` : ''}`
          )
        }
      } else {
        toast.success('Case created successfully')
      }

      router.push(`/cases/${caseId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create case')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/cases')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Clinical Case</h1>
          <p className="text-muted-foreground">Create a case with imaging uploads for doctor review</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Patient Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Patient Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="patient_name">Patient Name *</Label>
                <Input
                  id="patient_name"
                  placeholder="John Smith"
                  value={form.patient_name}
                  onChange={e => setForm({ ...form, patient_name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="patient_email">Email</Label>
                <Input
                  id="patient_email"
                  type="email"
                  placeholder="john@example.com"
                  value={form.patient_email}
                  onChange={e => setForm({ ...form, patient_email: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="patient_phone">Phone</Label>
                <Input
                  id="patient_phone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={form.patient_phone}
                  onChange={e => setForm({ ...form, patient_phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select value={form.priority} onValueChange={v => v && setForm({ ...form, priority: v })}>
                  <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Clinical Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Clinical Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="chief_complaint">Chief Complaint *</Label>
              <Textarea
                id="chief_complaint"
                placeholder="Patient presents with... (describe the primary concern)"
                value={form.chief_complaint}
                onChange={e => setForm({ ...form, chief_complaint: e.target.value })}
                rows={3}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="clinical_notes">Clinical Notes</Label>
              <Textarea
                id="clinical_notes"
                placeholder="Additional observations, medical history, etc."
                value={form.clinical_notes}
                onChange={e => setForm({ ...form, clinical_notes: e.target.value })}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Assign to Doctor</Label>
              <Select value={form.assigned_doctor_id} onValueChange={v => v && setForm({ ...form, assigned_doctor_id: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a doctor..." />
                </SelectTrigger>
                <SelectContent>
                  {doctors.map(d => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="flex items-center gap-2">
                        <Stethoscope className="h-3.5 w-3.5" />
                        {d.full_name}
                        {d.specialty && <span className="text-muted-foreground text-xs">({d.specialty})</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* File Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Images & Scans</CardTitle>
            <CardDescription>
              Upload dental photos, X-rays, STL files, or CT scans. AI will analyze images automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Drop zone */}
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="group border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <Upload className="h-8 w-8 mx-auto text-muted-foreground group-hover:text-primary transition-colors mb-3" />
              <p className="text-sm font-medium">Drop files here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">
                Photos (JPG, PNG) • X-Rays • STL Files • CT/CBCT Scans
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.stl,.dcm,.dicom"
                className="hidden"
                onChange={e => {
                  if (e.target.files) addFiles(Array.from(e.target.files))
                  e.target.value = ''
                }}
              />
            </div>

            {/* Pending files */}
            {pendingFiles.length > 0 && (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-medium">{pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} ready</p>
                {pendingFiles.map((pf, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                    {pf.preview ? (
                      <img src={pf.preview} alt="" className="h-12 w-12 rounded-md object-cover shrink-0" />
                    ) : (
                      <div className="h-12 w-12 rounded-md bg-muted flex items-center justify-center shrink-0">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{pf.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(pf.file.size / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                    <Select value={pf.fileType} onValueChange={v => v && updateFileType(i, v as CaseFileType)}>
                      <SelectTrigger className="w-[150px] h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FILE_TYPE_OPTIONS.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => removeFile(i)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push('/cases')}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting} className="gap-2 min-w-[140px]">
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
            ) : (
              <><FolderPlus className="h-4 w-4" /> Create Case</>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
