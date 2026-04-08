'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Upload, Loader2, CheckCircle, XCircle, FileSpreadsheet } from 'lucide-react'
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
  'condition': 'dental_condition', 'dental condition': 'dental_condition',
  'utm_source': 'utm_source', 'utm source': 'utm_source',
  'utm_campaign': 'utm_campaign', 'utm campaign': 'utm_campaign',
  'utm_medium': 'utm_medium', 'utm medium': 'utm_medium',
}

function parseCSV(text: string): CSVRow[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase())
  const rows: CSVRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
    const row: CSVRow = {}
    headers.forEach((header, idx) => {
      const mappedField = FIELD_MAP[header] || header
      if (values[idx]) row[mappedField] = values[idx]
    })
    if (row.first_name || row.email || row.phone) {
      rows.push(row)
    }
  }

  return rows
}

export function LeadCSVImport() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CSVRow[]>([])
  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState<Array<{ row: number; success: boolean; error?: string }>>([])
  const [step, setStep] = useState<'upload' | 'preview' | 'results'>('upload')
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      const parsed = parseCSV(text)
      setRows(parsed)
      setStep('preview')
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    setImporting(true)
    const importResults: typeof results = []

    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i]
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            first_name: row.first_name || 'Unknown',
            last_name: row.last_name,
            email: row.email,
            phone: row.phone,
            city: row.city,
            state: row.state,
            zip_code: row.zip_code,
            source_type: row.source_type,
            notes: row.notes,
            utm_source: row.utm_source,
            utm_campaign: row.utm_campaign,
          }),
        })

        if (res.ok) {
          importResults.push({ row: i + 1, success: true })
        } else {
          const data = await res.json()
          importResults.push({ row: i + 1, success: false, error: data.error })
        }
      } catch {
        importResults.push({ row: i + 1, success: false, error: 'Network error' })
      }
    }

    setResults(importResults)
    setStep('results')
    setImporting(false)

    const successCount = importResults.filter((r) => r.success).length
    toast.success(`Imported ${successCount}/${rows.length} leads`)
    router.refresh()
  }

  function resetDialog() {
    setRows([])
    setResults([])
    setStep('upload')
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetDialog() }}>
      <DialogTrigger>
        <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent cursor-pointer">
          <Upload className="h-4 w-4" />
          Import CSV
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Leads from CSV</DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div className="py-12 flex flex-col items-center gap-4">
            <FileSpreadsheet className="h-12 w-12 text-muted-foreground" />
            <div className="text-center">
              <p className="font-medium">Upload your CSV file</p>
              <p className="text-sm text-muted-foreground mt-1">
                Required columns: First Name. Optional: Last Name, Email, Phone, City, State, ZIP, Source, Notes
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button onClick={() => fileRef.current?.click()} className="gap-2">
              <Upload className="h-4 w-4" />
              Choose CSV File
            </Button>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Found <strong>{rows.length}</strong> leads to import
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={resetDialog}>Cancel</Button>
                <Button size="sm" onClick={handleImport} disabled={importing} className="gap-1.5">
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {importing ? `Importing... (${results.length}/${rows.length})` : `Import ${rows.length} Leads`}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border max-h-[50vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">
                        {row.first_name} {row.last_name}
                      </TableCell>
                      <TableCell className="text-sm">{row.email || '—'}</TableCell>
                      <TableCell className="text-sm">{row.phone || '—'}</TableCell>
                      <TableCell className="text-sm">
                        {[row.city, row.state].filter(Boolean).join(', ') || '—'}
                      </TableCell>
                      <TableCell className="text-sm">{row.source_type || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length > 50 && (
                <p className="text-center text-sm text-muted-foreground py-2">
                  ... and {rows.length - 50} more rows
                </p>
              )}
            </div>
          </div>
        )}

        {step === 'results' && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Badge className="bg-green-100 text-green-700">
                <CheckCircle className="h-3 w-3 mr-1" />
                {results.filter((r) => r.success).length} imported
              </Badge>
              {results.some((r) => !r.success) && (
                <Badge className="bg-red-100 text-red-700">
                  <XCircle className="h-3 w-3 mr-1" />
                  {results.filter((r) => !r.success).length} failed
                </Badge>
              )}
            </div>

            {results.some((r) => !r.success) && (
              <div className="rounded-lg border p-3 space-y-1">
                <p className="text-sm font-medium text-destructive">Failed rows:</p>
                {results.filter((r) => !r.success).map((r) => (
                  <p key={r.row} className="text-xs text-muted-foreground">
                    Row {r.row}: {r.error}
                  </p>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => { setOpen(false); resetDialog() }}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
