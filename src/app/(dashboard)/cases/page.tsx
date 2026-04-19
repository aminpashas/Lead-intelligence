'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClinicalCase, CaseStatus } from '@/types/database'

const STATUS_CONFIG: Record<CaseStatus, {
  label: string; icon: React.ElementType; color: string; gradient: string
}> = {
  intake: { label: 'Intake', icon: FolderPlus, color: 'text-slate-600', gradient: 'from-slate-500/10 to-slate-400/10' },
  analysis: { label: 'AI Analysis', icon: Brain, color: 'text-violet-600', gradient: 'from-violet-500/10 to-purple-500/10' },
  diagnosis: { label: 'Needs Diagnosis', icon: Stethoscope, color: 'text-blue-600', gradient: 'from-blue-500/10 to-cyan-500/10' },
  treatment_planning: { label: 'Treatment Planning', icon: ClipboardList, color: 'text-amber-600', gradient: 'from-amber-500/10 to-orange-500/10' },
  patient_review: { label: 'Patient Review', icon: UserCheck, color: 'text-emerald-600', gradient: 'from-emerald-500/10 to-teal-500/10' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'text-green-600', gradient: 'from-green-500/10 to-emerald-500/10' },
  archived: { label: 'Archived', icon: CheckCircle2, color: 'text-gray-400', gradient: 'from-gray-300/10 to-gray-400/10' },
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  normal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  urgent: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

const KANBAN_STATUSES: CaseStatus[] = ['intake', 'diagnosis', 'treatment_planning', 'patient_review', 'completed']

export default function CasesPage() {
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
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board')
  const [filterDoctor, setFilterDoctor] = useState<string>('all')

  const fetchCases = useCallback(async () => {
    try {
      const res = await fetch('/api/cases')
      const data = await res.json()
      if (data.cases) setCases(data.cases)
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Clinical Cases</h1>
          <p className="text-muted-foreground">
            Manage patient cases from intake through treatment delivery
          </p>
        </div>
        <div className="flex items-center gap-2">
          {doctors.length > 0 && (
            <Select value={filterDoctor} onValueChange={(v) => v && setFilterDoctor(v)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Doctors" />
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
            <FolderPlus className="h-4 w-4" />
            New Case
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : viewMode === 'board' ? (
        <KanbanBoard cases={filteredCases} onCaseClick={(id) => router.push(`/cases/${id}`)} />
      ) : (
        <ListView cases={filteredCases} onCaseClick={(id) => router.push(`/cases/${id}`)} />
      )}
    </div>
  )
}

// ── Kanban Board ────────────────────────────────────────────────

function KanbanBoard({ cases, onCaseClick }: { cases: ClinicalCase[]; onCaseClick: (id: string) => void }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {KANBAN_STATUSES.map((status) => {
        const config = STATUS_CONFIG[status]
        const StatusIcon = config.icon
        const columnCases = cases.filter((c) => c.status === status)

        return (
          <div key={status} className="flex-shrink-0 w-[300px]">
            <div className="flex items-center gap-2 mb-3 px-1">
              <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br', config.gradient)}>
                <StatusIcon className={cn('h-3.5 w-3.5', config.color)} />
              </div>
              <span className="text-sm font-medium">{config.label}</span>
              <Badge variant="outline" className="text-xs ml-auto h-5 px-1.5">
                {columnCases.length}
              </Badge>
            </div>
            <div className="space-y-2">
              {columnCases.map((c) => (
                <CaseCard key={c.id} caseData={c} onClick={() => onCaseClick(c.id)} />
              ))}
              {columnCases.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No cases
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Case Card ───────────────────────────────────────────────────

function CaseCard({ caseData, onClick }: { caseData: ClinicalCase; onClick: () => void }) {
  const fileCount = caseData.files?.length || 0
  const initials = caseData.patient_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  const timeAgo = getTimeAgo(caseData.created_at)

  return (
    <Card
      className="cursor-pointer hover:shadow-md hover:border-primary/20 transition-all duration-200 group"
      onClick={onClick}
    >
      <CardContent className="p-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar className="h-7 w-7 shrink-0">
              <AvatarFallback className="text-[10px] font-medium">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{caseData.patient_name}</p>
              <p className="text-[10px] text-muted-foreground">{caseData.case_number}</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{caseData.chief_complaint}</p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {caseData.priority !== 'normal' && (
              <Badge variant="outline" className={cn('text-[10px] px-1 py-0 h-4', PRIORITY_COLORS[caseData.priority])}>
                {caseData.priority === 'urgent' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />}
                {caseData.priority}
              </Badge>
            )}
            {fileCount > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <FileImage className="h-3 w-3" /> {fileCount}
              </span>
            )}
          </div>
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" /> {timeAgo}
          </span>
        </div>

        {caseData.assigned_doctor && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t">
            <Avatar className="h-5 w-5">
              <AvatarFallback className="text-[8px]">
                {caseData.assigned_doctor.full_name.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <span className="text-[10px] text-muted-foreground truncate">
              Dr. {caseData.assigned_doctor.full_name}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── List View ───────────────────────────────────────────────────

function ListView({ cases, onCaseClick }: { cases: ClinicalCase[]; onCaseClick: (id: string) => void }) {
  return (
    <div className="space-y-2">
      {cases.map((c) => {
        const config = STATUS_CONFIG[c.status]
        const StatusIcon = config.icon
        return (
          <Card
            key={c.id}
            className="cursor-pointer hover:shadow-sm hover:border-primary/20 transition-all"
            onClick={() => onCaseClick(c.id)}
          >
            <CardContent className="p-4 flex items-center gap-4">
              <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br shrink-0', config.gradient)}>
                <StatusIcon className={cn('h-4 w-4', config.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm">{c.patient_name}</p>
                  <span className="text-xs text-muted-foreground">{c.case_number}</span>
                  {c.priority !== 'normal' && (
                    <Badge variant="outline" className={cn('text-[10px] px-1 py-0 h-4', PRIORITY_COLORS[c.priority])}>
                      {c.priority}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{c.chief_complaint}</p>
              </div>
              <Badge variant="outline" className="text-xs shrink-0">
                {config.label}
              </Badge>
              {c.assigned_doctor && (
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                  Dr. {c.assigned_doctor.full_name}
                </span>
              )}
              <span className="text-xs text-muted-foreground shrink-0">
                {getTimeAgo(c.created_at)}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        )
      })}
      {cases.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FolderPlus className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <p className="font-medium">No cases yet</p>
          <p className="text-sm text-muted-foreground mt-1">Create your first clinical case to get started</p>
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
