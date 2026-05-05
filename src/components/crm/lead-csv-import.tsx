'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  CheckCircle,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

// ────────────────────────────────────────────────────────────────
// Field mapping
// ────────────────────────────────────────────────────────────────

const CANONICAL_FIELDS = [
  { value: '__ignore__', label: '— Ignore —' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'zip_code', label: 'ZIP code' },
  { value: 'age', label: 'Age' },
  { value: 'dental_condition', label: 'Dental condition' },
  { value: 'dental_condition_details', label: 'Dental condition details' },
  { value: 'current_dental_situation', label: 'Current dental situation' },
  { value: 'has_dentures', label: 'Has dentures (yes/no)' },
  { value: 'has_dental_insurance', label: 'Has dental insurance (yes/no)' },
  { value: 'insurance_provider', label: 'Insurance provider' },
  { value: 'financing_interest', label: 'Financing interest' },
  { value: 'budget_range', label: 'Budget range' },
  { value: 'source_type', label: 'Source type' },
  { value: 'utm_source', label: 'UTM source' },
  { value: 'utm_medium', label: 'UTM medium' },
  { value: 'utm_campaign', label: 'UTM campaign' },
  { value: 'utm_content', label: 'UTM content' },
  { value: 'utm_term', label: 'UTM term' },
  { value: 'gclid', label: 'GCLID' },
  { value: 'fbclid', label: 'FBCLID' },
  { value: 'landing_page_url', label: 'Landing page URL' },
  { value: 'notes', label: 'Notes' },
  { value: 'sms_consent_at', label: 'Opt-in date — SMS' },
  { value: 'email_consent_at', label: 'Opt-in date — Email' },
  { value: 'voice_consent_at', label: 'Opt-in date — Voice' },
  { value: 'do_not_call', label: 'Do not call (yes/no)' },
] as const

type CanonicalField = (typeof CANONICAL_FIELDS)[number]['value']

const HEADER_HINTS: Record<string, CanonicalField> = {
  'first name': 'first_name', firstname: 'first_name', first: 'first_name', fname: 'first_name', given: 'first_name',
  'last name': 'last_name', lastname: 'last_name', last: 'last_name', lname: 'last_name', surname: 'last_name', family: 'last_name',
  email: 'email', 'email address': 'email', 'e-mail': 'email', 'email_address': 'email',
  phone: 'phone', 'phone number': 'phone', telephone: 'phone', cell: 'phone', mobile: 'phone', 'phone_number': 'phone',
  city: 'city', town: 'city',
  state: 'state', province: 'state', region: 'state',
  zip: 'zip_code', 'zip code': 'zip_code', zipcode: 'zip_code', 'postal code': 'zip_code', postal: 'zip_code',
  age: 'age',
  source: 'source_type', 'lead source': 'source_type',
  notes: 'notes', comments: 'notes', note: 'notes',
  condition: 'dental_condition', 'dental condition': 'dental_condition',
  utm_source: 'utm_source', 'utm source': 'utm_source',
  utm_medium: 'utm_medium', 'utm medium': 'utm_medium',
  utm_campaign: 'utm_campaign', 'utm campaign': 'utm_campaign',
  'opted in at': 'sms_consent_at', 'opt-in date': 'sms_consent_at', opt_in_date: 'sms_consent_at',
  dnc: 'do_not_call', 'do not call': 'do_not_call', do_not_call: 'do_not_call',
}

function autoMapHeader(header: string): CanonicalField {
  const norm = header.trim().toLowerCase()
  if (HEADER_HINTS[norm]) return HEADER_HINTS[norm]
  // Fuzzy: match canonical value/label substrings
  for (const f of CANONICAL_FIELDS) {
    if (f.value === '__ignore__') continue
    if (norm === f.value.replace(/_/g, ' ')) return f.value
    if (norm === f.value) return f.value
  }
  return '__ignore__'
}

const BOOLEAN_FIELDS: CanonicalField[] = ['has_dentures', 'has_dental_insurance', 'do_not_call']
const NUMBER_FIELDS: CanonicalField[] = ['age']

function coerceCell(value: string, field: CanonicalField): unknown {
  const v = (value ?? '').toString().trim()
  if (v === '') return undefined
  if (BOOLEAN_FIELDS.includes(field)) {
    const t = v.toLowerCase()
    if (['true', 'yes', 'y', '1'].includes(t)) return true
    if (['false', 'no', 'n', '0'].includes(t)) return false
    return undefined
  }
  if (NUMBER_FIELDS.includes(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return v
}

// ────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────

type Step = 'upload' | 'map' | 'consent' | 'preview' | 'results'

type ParsedRow = Record<string, string>

type CampaignOption = { id: string; name: string; channel: string }
type UserOption = { id: string; full_name: string }

type ImportResult = {
  inserted: number
  skipped_duplicates: number
  overwritten?: number
  failed: Array<{ row: number; error: string }>
  lead_ids: string[]
}

export function LeadCSVImport() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState<string>('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [mapping, setMapping] = useState<Record<string, CanonicalField>>({})

  // Consent step
  const [smsConsent, setSmsConsent] = useState(false)
  const [emailConsent, setEmailConsent] = useState(false)
  const [voiceConsent, setVoiceConsent] = useState(false)
  const [consentSource, setConsentSource] = useState('')
  const [attestation, setAttestation] = useState(false)

  // Defaults step
  const [sourceType, setSourceType] = useState('')
  const [assignedTo, setAssignedTo] = useState<string>('')
  const [tagInput, setTagInput] = useState('')
  const [runScoring, setRunScoring] = useState(true)
  const [enrollCampaignId, setEnrollCampaignId] = useState<string>('')
  const [dedupeMode, setDedupeMode] = useState<'skip' | 'overwrite' | 'allow'>('skip')

  // Loaded options
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([])
  const [teamMembers, setTeamMembers] = useState<UserOption[]>([])

  // Run state
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  // Load campaigns + team members lazily on dialog open
  useEffect(() => {
    if (!open) return
    fetch('/api/campaigns?status=active')
      .then((r) => (r.ok ? r.json() : { campaigns: [] }))
      .then((d) => setCampaigns(d.campaigns || []))
      .catch(() => setCampaigns([]))
    fetch('/api/team')
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setTeamMembers(d.members || []))
      .catch(() => setTeamMembers([]))
  }, [open])

  function reset() {
    setStep('upload')
    setFileName('')
    setHeaders([])
    setRows([])
    setMapping({})
    setSmsConsent(false)
    setEmailConsent(false)
    setVoiceConsent(false)
    setConsentSource('')
    setAttestation(false)
    setSourceType('')
    setAssignedTo('')
    setTagInput('')
    setRunScoring(true)
    setEnrollCampaignId('')
    setDedupeMode('skip')
    setResult(null)
    setImporting(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    Papa.parse<ParsedRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const fields = (results.meta.fields || []).filter(Boolean)
        setHeaders(fields)
        setRows(results.data as ParsedRow[])
        const initialMap: Record<string, CanonicalField> = {}
        for (const f of fields) initialMap[f] = autoMapHeader(f)
        setMapping(initialMap)
        setStep('map')
      },
      error: (err) => {
        toast.error(`Failed to parse CSV: ${err.message}`)
      },
    })
  }

  // Build row payloads from raw rows + mapping
  function buildPayloadRows(): Array<Record<string, unknown>> {
    return rows.map((raw) => {
      const out: Record<string, unknown> = {}
      for (const [csvHeader, field] of Object.entries(mapping)) {
        if (field === '__ignore__') continue
        const v = coerceCell(raw[csvHeader] ?? '', field)
        if (v !== undefined) out[field] = v
      }
      return out
    })
  }

  // Validation summary for the preview step
  function validationSummary(payload: Array<Record<string, unknown>>) {
    let ok = 0
    let missingContact = 0
    for (const row of payload) {
      const hasFirst = !!(row.first_name && String(row.first_name).trim())
      const hasContact = !!(row.email || row.phone)
      if (!hasContact) {
        missingContact++
        continue
      }
      if (hasFirst || hasContact) ok++
    }
    return { ok, missingContact, total: payload.length }
  }

  const mappedFields = new Set(Object.values(mapping).filter((v) => v !== '__ignore__'))
  const hasContact = mappedFields.has('email') || mappedFields.has('phone')
  const hasFirstName = mappedFields.has('first_name')

  const channelChosen = smsConsent || emailConsent || voiceConsent
  const consentReady = channelChosen && consentSource.trim().length > 0 && attestation

  async function runImport() {
    setImporting(true)
    setResult(null)
    try {
      const payloadRows = buildPayloadRows()
      const tagList = tagInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: payloadRows,
          consent: {
            sms: smsConsent,
            email: emailConsent,
            voice: voiceConsent,
            source: consentSource.trim(),
            attested_at: new Date().toISOString(),
          },
          defaults: {
            source_type: sourceType.trim() || undefined,
            assigned_to: assignedTo || undefined,
            tags: tagList.length > 0 ? tagList : undefined,
            file_name: fileName,
          },
          post_actions: {
            score: runScoring,
            enroll_campaign_id: enrollCampaignId || undefined,
          },
          dedupe: dedupeMode,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Import failed')
        setImporting(false)
        return
      }
      setResult(data as ImportResult)
      setStep('results')
      toast.success(`Imported ${data.inserted}/${rows.length} leads`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  // ──────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset() }}>
      <DialogTrigger>
        <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent cursor-pointer">
          <Upload className="h-4 w-4" />
          Import CSV
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Leads from CSV</DialogTitle>
          <StepIndicator step={step} />
        </DialogHeader>

        {step === 'upload' && (
          <div className="py-12 flex flex-col items-center gap-4">
            <FileSpreadsheet className="h-12 w-12 text-muted-foreground" />
            <div className="text-center">
              <p className="font-medium">Upload your CSV file</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                You'll map columns, attest consent, and choose import options on the next steps.
                Each row needs at minimum a phone or email.
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="hidden"
            />
            <Button onClick={() => fileRef.current?.click()} className="gap-2">
              <Upload className="h-4 w-4" />
              Choose CSV File
            </Button>
          </div>
        )}

        {step === 'map' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Found <strong>{rows.length}</strong> rows in <strong>{fileName}</strong>. Map each
              CSV column to a lead field, or set it to "Ignore". At minimum, map First Name and
              either Email or Phone.
            </p>
            <div className="rounded-lg border max-h-[50vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>CSV Column</TableHead>
                    <TableHead>Sample (row 1)</TableHead>
                    <TableHead>Maps to</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {headers.map((h) => (
                    <TableRow key={h}>
                      <TableCell className="font-medium">{h}</TableCell>
                      <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">
                        {rows[0]?.[h] ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={mapping[h] || '__ignore__'}
                          onValueChange={(v) => setMapping({ ...mapping, [h]: v as CanonicalField })}
                        >
                          <SelectTrigger className="w-[260px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CANONICAL_FIELDS.map((f) => (
                              <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground space-y-1">
                {!hasFirstName && <p className="text-amber-600">⚠ First name is recommended.</p>}
                {!hasContact && <p className="text-red-600">✗ At least one of Email or Phone must be mapped.</p>}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep('upload')}>Back</Button>
                <Button size="sm" disabled={!hasContact} onClick={() => setStep('consent')}>Next</Button>
              </div>
            </div>
          </div>
        )}

        {step === 'consent' && (
          <div className="space-y-5">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
              <div className="flex gap-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>
                  Automated SMS, email, and AI calls are gated by per-lead consent. Imported leads
                  must have previously opted in to each channel you enable below — you'll attest to
                  that here, and the timestamp + source are stored on every row for the audit trail.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <ConsentToggle label="SMS consent (TCPA)" description="Required for automated SMS sends and the AI auto-dialer." checked={smsConsent} onChange={setSmsConsent} />
              <ConsentToggle label="Email consent (CAN-SPAM)" description="Required for marketing emails and drip cadences." checked={emailConsent} onChange={setEmailConsent} />
              <ConsentToggle label="Voice consent (TCPA)" description="Required for the AI auto-dialer (Retell). Manual calls aren't gated." checked={voiceConsent} onChange={setVoiceConsent} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="consent-source">Consent source <span className="text-red-500">*</span></Label>
              <Input
                id="consent-source"
                placeholder="e.g. historical_form_2024, prior_consult_intake_2025"
                value={consentSource}
                onChange={(e) => setConsentSource(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A short identifier describing where the consent came from. Stored on every imported lead.
              </p>
            </div>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={attestation}
                onChange={(e) => setAttestation(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I attest these leads previously opted in to receive the channels checked above and
                I can produce documentation of that consent on request.
              </span>
            </label>

            <div className="flex justify-between">
              <Button variant="outline" size="sm" onClick={() => setStep('map')}>Back</Button>
              <Button size="sm" disabled={!consentReady} onClick={() => setStep('preview')}>Next</Button>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <PreviewStep
            rows={rows}
            headers={headers}
            mapping={mapping}
            buildPayloadRows={buildPayloadRows}
            validationSummary={validationSummary}
            sourceType={sourceType}
            setSourceType={setSourceType}
            assignedTo={assignedTo}
            setAssignedTo={setAssignedTo}
            tagInput={tagInput}
            setTagInput={setTagInput}
            runScoring={runScoring}
            setRunScoring={setRunScoring}
            enrollCampaignId={enrollCampaignId}
            setEnrollCampaignId={setEnrollCampaignId}
            dedupeMode={dedupeMode}
            setDedupeMode={setDedupeMode}
            campaigns={campaigns}
            teamMembers={teamMembers}
            importing={importing}
            onBack={() => setStep('consent')}
            onRun={runImport}
          />
        )}

        {step === 'results' && result && (
          <ResultsStep
            result={result}
            totalRows={rows.length}
            tagInput={tagInput}
            onClose={() => { setOpen(false); reset() }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'map', label: 'Map' },
    { key: 'consent', label: 'Consent' },
    { key: 'preview', label: 'Options' },
    { key: 'results', label: 'Done' },
  ]
  const idx = steps.findIndex((s) => s.key === step)
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {steps.map((s, i) => (
        <span key={s.key} className={i <= idx ? 'font-medium text-foreground' : ''}>
          {i + 1}. {s.label}
          {i < steps.length - 1 && <span className="ml-2">›</span>}
        </span>
      ))}
    </div>
  )
}

function ConsentToggle({
  label, description, checked, onChange,
}: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function PreviewStep(props: {
  rows: ParsedRow[]
  headers: string[]
  mapping: Record<string, CanonicalField>
  buildPayloadRows: () => Array<Record<string, unknown>>
  validationSummary: (rows: Array<Record<string, unknown>>) => { ok: number; missingContact: number; total: number }
  sourceType: string
  setSourceType: (v: string) => void
  assignedTo: string
  setAssignedTo: (v: string) => void
  tagInput: string
  setTagInput: (v: string) => void
  runScoring: boolean
  setRunScoring: (v: boolean) => void
  enrollCampaignId: string
  setEnrollCampaignId: (v: string) => void
  dedupeMode: 'skip' | 'overwrite' | 'allow'
  setDedupeMode: (v: 'skip' | 'overwrite' | 'allow') => void
  campaigns: CampaignOption[]
  teamMembers: UserOption[]
  importing: boolean
  onBack: () => void
  onRun: () => void
}) {
  const payloadRows = props.buildPayloadRows()
  const summary = props.validationSummary(payloadRows)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="source-type">Source name</Label>
          <Input
            id="source-type"
            placeholder="e.g. cold_list_2026_05"
            value={props.sourceType}
            onChange={(e) => props.setSourceType(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Assign to</Label>
          <Select value={props.assignedTo || 'unassigned'} onValueChange={(v) => props.setAssignedTo(v === 'unassigned' || !v ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {props.teamMembers.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 col-span-2">
          <Label htmlFor="tags">Tags (comma-separated)</Label>
          <Input
            id="tags"
            placeholder="e.g. imported, test_batch_1, prior_inquiry"
            value={props.tagInput}
            onChange={(e) => props.setTagInput(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Enroll into campaign (optional)</Label>
          <Select value={props.enrollCampaignId || 'none'} onValueChange={(v) => props.setEnrollCampaignId(v === 'none' || !v ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {props.campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name} ({c.channel})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>If duplicate found</Label>
          <Select value={props.dedupeMode} onValueChange={(v) => props.setDedupeMode(v as 'skip' | 'overwrite' | 'allow')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip (recommended)</SelectItem>
              <SelectItem value="overwrite">Overwrite existing</SelectItem>
              <SelectItem value="allow">Insert anyway</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Run AI scoring after import</p>
            <p className="text-xs text-muted-foreground">Scores each lead 0–100 and assigns Hot / Warm / Cold / Unqualified.</p>
          </div>
          <Switch checked={props.runScoring} onCheckedChange={props.setRunScoring} />
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-3 text-sm">
          <Badge className="bg-green-100 text-green-700">{summary.ok} valid</Badge>
          {summary.missingContact > 0 && (
            <Badge className="bg-red-100 text-red-700">{summary.missingContact} missing email/phone</Badge>
          )}
          <span className="text-muted-foreground">of {summary.total} total</span>
        </div>
      </div>

      <div className="rounded-lg border max-h-[35vh] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payloadRows.slice(0, 50).map((r, i) => {
              const hasContact = !!(r.email || r.phone)
              return (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</TableCell>
                  <TableCell className="text-sm">{(r.email as string) || '—'}</TableCell>
                  <TableCell className="text-sm">{(r.phone as string) || '—'}</TableCell>
                  <TableCell>
                    {hasContact ? (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600" />
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {payloadRows.length > 50 && (
          <p className="text-center text-xs text-muted-foreground py-2">… and {payloadRows.length - 50} more</p>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={props.onBack} disabled={props.importing}>Back</Button>
        <Button size="sm" disabled={props.importing} onClick={props.onRun} className="gap-1.5">
          {props.importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {props.importing ? 'Importing…' : `Import ${summary.ok} leads`}
        </Button>
      </div>
    </div>
  )
}

function ResultsStep({
  result, totalRows, tagInput, onClose,
}: {
  result: ImportResult
  totalRows: number
  tagInput: string
  onClose: () => void
}) {
  const firstTag = tagInput.split(',').map((t) => t.trim()).filter(Boolean)[0]
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-green-100 text-green-700">
          <CheckCircle className="h-3 w-3 mr-1" /> {result.inserted} imported
        </Badge>
        {result.skipped_duplicates > 0 && (
          <Badge className="bg-amber-100 text-amber-700">{result.skipped_duplicates} skipped (dupes)</Badge>
        )}
        {result.overwritten && result.overwritten > 0 ? (
          <Badge className="bg-blue-100 text-blue-700">{result.overwritten} overwritten</Badge>
        ) : null}
        {result.failed.length > 0 && (
          <Badge className="bg-red-100 text-red-700">
            <XCircle className="h-3 w-3 mr-1" /> {result.failed.length} failed
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">of {totalRows}</span>
      </div>

      {result.failed.length > 0 && (
        <div className="rounded-lg border p-3 space-y-1 max-h-[30vh] overflow-auto">
          <p className="text-sm font-medium text-destructive">Failed rows:</p>
          {result.failed.slice(0, 100).map((r) => (
            <p key={r.row} className="text-xs text-muted-foreground">Row {r.row}: {r.error}</p>
          ))}
        </div>
      )}

      <div className="flex justify-between">
        {firstTag ? (
          <a
            href={`/leads?tag=${encodeURIComponent(firstTag)}`}
            className="text-sm text-blue-600 hover:underline self-center"
          >
            View imported leads →
          </a>
        ) : <span />}
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}
