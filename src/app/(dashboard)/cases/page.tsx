'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, redirect } from 'next/navigation'
import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  FolderPlus,
  Loader2,
  FileImage,
  Brain,
  Stethoscope,
  ClipboardList,
  UserCheck,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronRight,
  FileSignature,
  Banknote,
  CalendarCheck,
  ShieldCheck,
  FlaskConical,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RoutingPills } from '@/components/crm/case-routing'
import type { ClinicalCase, CaseStatus, RecordsChecklist } from '@/types/database'

const STATUS_CONFIG: Record<CaseStatus, {
  label: string; icon: React.ElementType; color: string; bg: string
}> = {
  intake:            { label: 'Intake',            icon: FolderPlus,    color: 'text-aurea-ink-3',  bg: 'bg-aurea-surface-2' },
  analysis:          { label: 'AI Analysis',        icon: Brain,         color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  diagnosis:         { label: 'Needs Diagnosis',    icon: Stethoscope,   color: 'text-aurea-ink-2',  bg: 'bg-aurea-surface-2' },
  treatment_planning:{ label: 'Treatment Planning', icon: ClipboardList, color: 'text-aurea-amber',  bg: 'bg-aurea-amber/10' },
  patient_review:    { label: 'Patient Review',     icon: UserCheck,     color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  accepted:          { label: 'Accepted',           icon: FileSignature, color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  closing:           { label: 'Contract & Funding', icon: Banknote,      color: 'text-aurea-amber',  bg: 'bg-aurea-amber/10' },
  surgery_scheduled: { label: 'Surgery Scheduled',  icon: CalendarCheck, color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  ready_for_surgery: { label: 'Ready for Surgery',  icon: ShieldCheck,   color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  completed:         { label: 'Completed',          icon: CheckCircle2,  color: 'text-aurea-primary', bg: 'bg-aurea-primary/10' },
  archived:          { label: 'Archived',           icon: CheckCircle2,  color: 'text-aurea-ink-3',  bg: 'bg-aurea-surface-2' },
}

const PRIORITY_COLORS: Record<string, string> = {
  low:    'bg-aurea-surface-2 text-aurea-ink-3 border-aurea-border',
  normal: 'bg-aurea-surface-2 text-aurea-ink-2 border-aurea-border',
  high:   'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20',
  urgent: 'bg-aurea-rose/10 text-aurea-rose border-aurea-rose/20',
}

// Two lanes: the funnel Lead Intelligence owns ("In Practice"), then the
// cross-app hand-off stages ("Routing") where each case is routed out to
// Smile Design Lab (records/design) and Dion Clinical (surgery). The routing
// status itself lives on every card via <RoutingPills>.
const STAGE_GROUPS: Array<{ title: string; caption: string; statuses: CaseStatus[] }> = [
  {
    title: 'In Practice',
    caption: 'Owned in Lead Intelligence',
    statuses: ['intake', 'diagnosis', 'treatment_planning', 'patient_review'],
  },
  {
    title: 'Routing',
    caption: 'Routed to Smile Design Lab + Dion Clinical',
    statuses: ['accepted', 'closing', 'surgery_scheduled', 'ready_for_surgery', 'completed'],
  },
]

export default function CasesPage() {
  // Cases retired in LI (2026-07): clinical fulfillment lives in Dion Clinical
  // per the ecosystem split. The route + <CasesContent/> below are left intact
  // so this is reversible — delete this redirect (and re-add the sidebar entry)
  // to restore the board. Guards stale bookmarks / direct URL hits.
  redirect('/dashboard')

  return (
    <RoleGuard requiredPermission="cases:read">
      <CasesContent />
    </RoleGuard>
  )
}

function CasesContent() {
  const router = useRouter()
  const { userProfile } = useOrgStore()
  const [cases, setCases] = useState<ClinicalCase[]>([])
  const [sdlWebBase, setSdlWebBase] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board')
  const [filterDoctor, setFilterDoctor] = useState<string>('all')

  const fetchCases = useCallback(async () => {
    try {
      const res = await fetch('/api/cases')
      const data = await res.json()
      if (data.cases) setCases(data.cases)
      setSdlWebBase(data.sdl_web_base ?? null)
    } catch {
      console.error('Failed to fetch cases')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchCases() }, [fetchCases])

  const filteredCases = filterDoctor === 'all'
    ? cases
    : cases.filter(c => c.assigned_doctor_id === filterDoctor)

  // Get unique doctors
  const doctors = Array.from(
    new Map(
      cases
        .filter(c => c.assigned_doctor)
        .map(c => [c.assigned_doctor!.id, c.assigned_doctor!])
    ).values()
  )

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Clinical Workflow</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">Clinical Cases</h1>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-aurea-ink-2">
            From intake through acceptance here — then routed out to{' '}
            <span className="text-aurea-ink">Smile Design Lab</span> for records &amp; design and{' '}
            <span className="text-aurea-ink">Dion Clinical</span> for surgery.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {doctors.length > 0 && (
            <Select value={filterDoctor} onValueChange={(v) => v && setFilterDoctor(v)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Doctors">
                  {(value) => doctors.find((d) => d.id === value)?.full_name ?? 'All Doctors'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Doctors</SelectItem>
                {doctors.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewMode(viewMode === 'board' ? 'list' : 'board')}
          >
            {viewMode === 'board' ? 'List View' : 'Board View'}
          </Button>
          <Button onClick={() => router.push('/cases/new')} className="gap-2">
            <FolderPlus className="h-[17px] w-[17px]" strokeWidth={1.75} />
            New Case
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-aurea-ink-3" />
        </div>
      ) : viewMode === 'board' ? (
        <KanbanBoard cases={filteredCases} sdlWebBase={sdlWebBase} onCaseClick={(id) => router.push(`/cases/${id}`)} />
      ) : (
        <ListView cases={filteredCases} onCaseClick={(id) => router.push(`/cases/${id}`)} />
      )}
    </div>
  )
}

// ── Kanban Board ────────────────────────────────────────────────

function KanbanBoard({ cases, sdlWebBase, onCaseClick }: { cases: ClinicalCase[]; sdlWebBase: string | null; onCaseClick: (id: string) => void }) {
  return (
    <div className="flex gap-6 overflow-x-auto pb-4">
      {STAGE_GROUPS.map((group, groupIdx) => (
        <div
          key={group.title}
          className={cn(
            'flex-shrink-0',
            groupIdx > 0 && 'border-l border-aurea-border pl-6'
          )}
        >
          <div className="mb-4 px-1">
            <p className="aurea-eyebrow">{group.title}</p>
            <p className="mt-0.5 text-[11px] text-aurea-ink-3">{group.caption}</p>
          </div>
          <div className="flex gap-4">
            {group.statuses.map((status) => {
              const config = STATUS_CONFIG[status]
              const StatusIcon = config.icon
              const columnCases = cases.filter((c) => c.status === status)

              return (
                <div key={status} className="flex-shrink-0 w-[300px]">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg', config.bg)}>
                      <StatusIcon className={cn('h-3.5 w-3.5', config.color)} strokeWidth={1.75} />
                    </div>
                    <span className="text-[13px] font-medium text-aurea-ink">{config.label}</span>
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      {columnCases.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {columnCases.map((c) => (
                      <CaseCard key={c.id} caseData={c} sdlWebBase={sdlWebBase} onClick={() => onCaseClick(c.id)} />
                    ))}
                    {columnCases.length === 0 && (
                      <div className="rounded-lg border border-dashed border-aurea-border p-4 text-center text-[12px] text-aurea-ink-3">
                        No cases
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Case Card ───────────────────────────────────────────────────

function CaseCard({ caseData, sdlWebBase, onClick }: { caseData: ClinicalCase; sdlWebBase: string | null; onClick: () => void }) {
  const fileCount = caseData.files?.length || 0
  const initials = caseData.patient_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  const timeAgo = getTimeAgo(caseData.created_at)

  return (
    <div
      className="aurea-card cursor-pointer p-3 transition-colors hover:bg-aurea-surface-2 group"
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
            {initials}
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium text-aurea-ink truncate">{caseData.patient_name}</p>
            <p className="font-mono text-[10px] text-aurea-ink-3">{caseData.case_number}</p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-aurea-ink-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" strokeWidth={1.75} />
      </div>

      <p className="text-[12px] text-aurea-ink-2 line-clamp-2 mb-2">{caseData.chief_complaint}</p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {caseData.priority !== 'normal' && (
            <span className={cn('inline-flex items-center gap-0.5 rounded border px-1.5 py-0 text-[10px] font-medium', PRIORITY_COLORS[caseData.priority])}>
              {caseData.priority === 'urgent' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" strokeWidth={1.75} />}
              {caseData.priority}
            </span>
          )}
          {fileCount > 0 && (
            <span className="flex items-center gap-0.5 font-mono text-[10px] text-aurea-ink-3">
              <FileImage className="h-3 w-3" strokeWidth={1.75} /> {fileCount}
            </span>
          )}
        </div>
        <span className="flex items-center gap-0.5 font-mono text-[10px] text-aurea-ink-3">
          <Clock className="h-3 w-3" strokeWidth={1.75} /> {timeAgo}
        </span>
      </div>

      {caseData.closing && <ClosingChips closing={caseData.closing} />}

      <RoutingPills caseData={caseData} sdlWebBase={sdlWebBase} />

      {caseData.assigned_doctor && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-aurea-border">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-aurea-surface-2 text-[8px] font-semibold text-aurea-ink-3 ring-1 ring-aurea-border">
            {caseData.assigned_doctor.full_name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </span>
          <span className="text-[10px] text-aurea-ink-3 truncate">
            Dr. {caseData.assigned_doctor.full_name}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Closing Progress Chips ─────────────────────────────────────

function countRecords(checklist: RecordsChecklist | null | undefined): { done: number; total: number } {
  if (!checklist) return { done: 0, total: 8 }
  const values = Object.values(checklist)
  return { done: values.filter(Boolean).length, total: values.length }
}

function ClosingChips({ closing }: { closing: NonNullable<ClinicalCase['closing']> }) {
  const records = countRecords(closing.records_checklist)
  const chip = (active: boolean, Icon: React.ElementType, label: string) => (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        active
          ? 'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary'
          : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'
      )}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
      {label}
    </span>
  )

  return (
    <div className="mt-2 flex flex-wrap gap-1 border-t border-aurea-border pt-2">
      {chip(!!closing.contract_signed_at, FileSignature, 'Signed')}
      {chip(!!closing.financing_funded_at, Banknote, 'Funded')}
      {chip(records.done === records.total, FlaskConical, `Records ${records.done}/${records.total}`)}
    </div>
  )
}

// ── List View ───────────────────────────────────────────────────

function ListView({ cases, onCaseClick }: { cases: ClinicalCase[]; onCaseClick: (id: string) => void }) {
  return (
    <div className="aurea-card overflow-hidden">
      {cases.map((c) => {
        const config = STATUS_CONFIG[c.status]
        const StatusIcon = config.icon
        return (
          <div
            key={c.id}
            className="flex cursor-pointer items-center gap-4 border-b border-aurea-border p-4 transition-colors last:border-0 hover:bg-aurea-surface-2"
            onClick={() => onCaseClick(c.id)}
          >
            <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg shrink-0', config.bg)}>
              <StatusIcon className={cn('h-4 w-4', config.color)} strokeWidth={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[14px] font-medium text-aurea-ink">{c.patient_name}</p>
                <span className="font-mono text-[11px] text-aurea-ink-3">{c.case_number}</span>
                {c.priority !== 'normal' && (
                  <span className={cn('inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium', PRIORITY_COLORS[c.priority])}>
                    {c.priority}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-aurea-ink-3 truncate">{c.chief_complaint}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-aurea-ink-2 shrink-0">
              <span className={cn('h-1.5 w-1.5 rounded-full', config.bg.replace('bg-', 'bg-').includes('primary') ? 'bg-aurea-primary' : config.bg.includes('amber') ? 'bg-aurea-amber' : 'bg-aurea-ink-3')} />
              {config.label}
            </span>
            {c.assigned_doctor && (
              <span className="text-[12px] text-aurea-ink-3 shrink-0 hidden sm:block">
                Dr. {c.assigned_doctor.full_name}
              </span>
            )}
            <span className="font-mono text-[11px] text-aurea-ink-3 shrink-0">
              {getTimeAgo(c.created_at)}
            </span>
            <ChevronRight className="h-4 w-4 text-aurea-ink-3 shrink-0" strokeWidth={1.75} />
          </div>
        )
      })}
      {cases.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FolderPlus className="h-10 w-10 text-aurea-ink-3 mb-4" strokeWidth={1.5} />
          <p className="aurea-display text-[18px] text-aurea-ink">No cases yet</p>
          <p className="mt-1 text-[13px] text-aurea-ink-3">Create your first clinical case to get started</p>
        </div>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}
