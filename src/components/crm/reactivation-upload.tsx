'use client'

import { useState, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft, Upload, Loader2, CheckCircle, XCircle,
  FileSpreadsheet, Download, Users, Zap, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

type CSVRow = Record<string, string>

// Maps common CSV header variations to our field names
const FIELD_MAP: Record<string, string> = {
  'first name': 'first_name', 'firstname': 'first_name', 'first': 'first_name', 'fname': 'first_name',
  'last name': 'last_name', 'lastname': 'last_name', 'last': 'last_name', 'lname': 'last_name',
  'email': 'email', 'email address': 'email', 'e-mail': 'email',
  'phone': 'phone', 'phone number': 'phone', 'telephone': 'phone', 'cell': 'phone', 'mobile': 'phone',
  'city': 'city', 'town': 'city',
  'state': 'state', 'province': 'state',
  'zip': 'zip_code', 'zip code': 'zip_code', 'zipcode': 'zip_code', 'postal code': 'zip_code',
  'source': 'source_type', 'lead source': 'source_type',
  'notes': 'notes', 'comments': 'notes', 'note': 'notes',
}

function parseCSV(text: string): CSVRow[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())
  const rows: CSVRow[] = []

  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields with commas inside
    const values: string[] = []
    let current = ''
    let inQuotes = false
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    values.push(current.trim())

    const row: CSVRow = {}
    headers.forEach((header, idx) => {
      const mappedField = FIELD_MAP[header] || header
      if (values[idx]) row[mappedField] = values[idx].replace(/^"|"$/g, '')
    })
    if (row.first_name || row.email || row.phone) {
      rows.push(row)
    }
  }

  return rows
}

function generateSampleCSV(): string {
  return [
    'First Name,Last Name,Email,Phone,City,State,Notes',
    'John,Smith,john@example.com,(555) 123-4567,Houston,TX,Interested in implants',
    'Jane,Doe,jane@example.com,(555) 987-6543,Austin,TX,Had consultation last year',
    'Bob,Johnson,,,(555) 111-2222,Dallas,TX,Price was a concern',
  ].join('\n')
}

type UploadResult = {
  summary: {
    total: number
    created: number
    matched: number
    enrolled: number
    failed: number
  }
  results: Array<{ row: number; success: boolean; action: string; error?: string }>
}

export function ReactivationUpload({
  campaignId,
  campaignName,
  onBack,
}: {
  campaignId: string
  campaignName: string
  onBack: () => void
}) {
  const [rows, setRows] = useState<CSVRow[]>([])
  const [step, setStep] = useState<'upload' | 'preview' | 'uploading' | 'results'>('upload')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [tagName, setTagName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      const parsed = parseCSV(text)
      if (parsed.length === 0) {
        toast.error('No valid rows found. Make sure your CSV has a header row.')
        return
      }
      setRows(parsed)
      setStep('preview')
      setTagName(`reactivation-${Date.now()}`)
    }
    reader.readAsText(file)
  }

  async function handleUpload() {
    setImporting(true)
    setStep('uploading')
    setProgress(0)

    try {
      // Upload in batches of 100
      const batchSize = 100
      let totalCreated = 0
      let totalMatched = 0
      let totalEnrolled = 0
      let totalFailed = 0
      const allResults: UploadResult['results'] = []

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize)

        const res = await fetch(`/api/reactivation/${campaignId}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leads: batch.map(r => ({
              first_name: r.first_name || 'Unknown',
              last_name: r.last_name,
              email: r.email,
              phone: r.phone,
              city: r.city,
              state: r.state,
              zip_code: r.zip_code,
              source_type: r.source_type || 'other',
              notes: r.notes,
            })),
            tag_name: tagName,
          }),
        })

        if (res.ok) {
          const data = await res.json()
          totalCreated += data.summary.created
          totalMatched += data.summary.matched
          totalEnrolled += data.summary.enrolled
          totalFailed += data.summary.failed
          allResults.push(...data.results)
        } else {
          totalFailed += batch.length
        }

        setProgress(Math.min(((i + batchSize) / rows.length) * 100, 100))
      }

      setUploadResult({
        summary: { total: rows.length, created: totalCreated, matched: totalMatched, enrolled: totalEnrolled, failed: totalFailed },
        results: allResults,
      })
      setStep('results')
      toast.success(`Uploaded ${totalCreated + totalMatched} leads, ${totalEnrolled} enrolled`)
    } catch {
      toast.error('Upload failed')
      setStep('preview')
    } finally {
      setImporting(false)
    }
  }

  function downloadTemplate() {
    const csv = generateSampleCSV()
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'reactivation_leads_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  function resetUpload() {
    setRows([])
    setStep('upload')
    setUploadResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="space-y-6" id="reactivation-upload">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Upload Lead Database</h1>
          <p className="text-sm text-muted-foreground">
            Upload leads to <span className="font-medium text-foreground">{campaignName}</span>
          </p>
        </div>
      </div>

      {/* Upload Step */}
      {step === 'upload' && (
        <Card>
          <CardContent className="py-16">
            <div className="flex flex-col items-center gap-6 max-w-md mx-auto">
              <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-purple-100 to-indigo-100 flex items-center justify-center">
                <FileSpreadsheet className="h-10 w-10 text-purple-500" />
              </div>

              <div className="text-center">
                <p className="font-semibold text-lg">Upload your spreadsheet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Drag and drop or click to select a CSV file with your leads database.
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  Required: <span className="font-medium">First Name</span>. Optional: Last Name, Email, Phone, City, State, ZIP, Notes
                </p>
              </div>

              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
              />

              <div className="flex items-center gap-3">
                <Button
                  onClick={() => fileRef.current?.click()}
                  className="gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                  size="lg"
                >
                  <Upload className="h-5 w-5" />
                  Choose CSV File
                </Button>
                <Button variant="outline" onClick={downloadTemplate} className="gap-2">
                  <Download className="h-4 w-4" />
                  Template
                </Button>
              </div>

              {/* Drop zone visual hint */}
              <div className="w-full border-2 border-dashed border-muted-foreground/20 rounded-xl p-8 text-center"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-purple-400', 'bg-purple-50') }}
                onDragLeave={e => { e.currentTarget.classList.remove('border-purple-400', 'bg-purple-50') }}
                onDrop={e => {
                  e.preventDefault()
                  e.currentTarget.classList.remove('border-purple-400', 'bg-purple-50')
                  const file = e.dataTransfer.files[0]
                  if (file && file.name.endsWith('.csv')) {
                    const reader = new FileReader()
                    reader.onload = (ev) => {
                      const text = ev.target?.result as string
                      const parsed = parseCSV(text)
                      if (parsed.length === 0) {
                        toast.error('No valid rows found')
                        return
                      }
                      setRows(parsed)
                      setStep('preview')
                      setTagName(`reactivation-${Date.now()}`)
                    }
                    reader.readAsText(file)
                  }
                }}
              >
                <p className="text-sm text-muted-foreground">Or drag and drop your CSV file here</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview Step */}
      {step === 'preview' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Badge className="bg-purple-100 text-purple-700 text-sm gap-1">
                <Users className="h-3.5 w-3.5" />
                {rows.length} leads found
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={resetUpload}>Cancel</Button>
              <Button
                size="sm"
                onClick={handleUpload}
                disabled={importing}
                className="gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Upload & Enroll {rows.length} Leads
              </Button>
            </div>
          </div>

          {/* Tag input */}
          <Card>
            <CardContent className="py-3 flex items-center gap-3">
              <Label className="text-sm shrink-0">Auto-tag leads as:</Label>
              <Input
                value={tagName}
                onChange={e => setTagName(e.target.value)}
                placeholder="e.g., spring-reactivation-2026"
                className="h-8 max-w-xs"
              />
            </CardContent>
          </Card>

          {/* Preview Table */}
          <div className="rounded-lg border max-h-[50vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 50).map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                    <TableCell className="font-medium">{row.first_name} {row.last_name || ''}</TableCell>
                    <TableCell className="text-sm">{row.email || '—'}</TableCell>
                    <TableCell className="text-sm">{row.phone || '—'}</TableCell>
                    <TableCell className="text-sm">{[row.city, row.state].filter(Boolean).join(', ') || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{row.notes || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length > 50 && (
              <p className="text-center text-sm text-muted-foreground py-3 border-t">
                ... and {rows.length - 50} more leads
              </p>
            )}
          </div>

          <Card className="bg-amber-50 border-amber-200">
            <CardContent className="py-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-800">Deduplication</p>
                <p className="text-amber-700 text-xs">
                  If a lead already exists (matched by email or phone), they will be enrolled into the campaign without creating a duplicate.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Uploading Progress */}
      {step === 'uploading' && (
        <Card>
          <CardContent className="py-16 flex flex-col items-center gap-6">
            <Loader2 className="h-12 w-12 animate-spin text-purple-600" />
            <div className="text-center">
              <p className="font-semibold text-lg">Uploading & enrolling leads...</p>
              <p className="text-sm text-muted-foreground mt-1">
                This may take a moment for larger databases
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-full max-w-md">
              <div className="h-2 rounded-full bg-purple-100 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center mt-2">
                {Math.round(progress)}% complete
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {step === 'results' && uploadResult && (
        <div className="space-y-4">
          <Card className="bg-gradient-to-br from-emerald-50 to-green-50 border-emerald-200">
            <CardContent className="py-6">
              <div className="flex items-center gap-3 mb-4">
                <CheckCircle className="h-8 w-8 text-emerald-600" />
                <div>
                  <p className="font-semibold text-lg text-emerald-800">Upload Complete!</p>
                  <p className="text-sm text-emerald-700">
                    {uploadResult.summary.enrolled} leads enrolled into the campaign
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="rounded-lg bg-white/70 p-3 text-center">
                  <p className="text-2xl font-bold text-slate-800">{uploadResult.summary.total}</p>
                  <p className="text-xs text-muted-foreground">Total Rows</p>
                </div>
                <div className="rounded-lg bg-white/70 p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600">{uploadResult.summary.created}</p>
                  <p className="text-xs text-muted-foreground">New Leads Created</p>
                </div>
                <div className="rounded-lg bg-white/70 p-3 text-center">
                  <p className="text-2xl font-bold text-blue-600">{uploadResult.summary.matched}</p>
                  <p className="text-xs text-muted-foreground">Existing Matched</p>
                </div>
                <div className="rounded-lg bg-white/70 p-3 text-center">
                  <p className="text-2xl font-bold text-purple-600">{uploadResult.summary.enrolled}</p>
                  <p className="text-xs text-muted-foreground">Enrolled</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {uploadResult.summary.failed > 0 && (
            <Card className="border-red-200">
              <CardContent className="py-4">
                <div className="flex items-center gap-2 mb-2">
                  <XCircle className="h-4 w-4 text-red-500" />
                  <p className="text-sm font-medium text-red-700">
                    {uploadResult.summary.failed} rows failed
                  </p>
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {uploadResult.results.filter(r => !r.success).map(r => (
                    <p key={r.row} className="text-xs text-muted-foreground">
                      Row {r.row}: {r.error}
                    </p>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={resetUpload} className="gap-2">
              <Upload className="h-4 w-4" />
              Upload More Leads
            </Button>
            <Button onClick={onBack} className="gap-2">
              <CheckCircle className="h-4 w-4" />
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
