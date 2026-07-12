'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  AGENCY_LEVEL_LABELS,
  AGENCY_LEVEL_COLORS,
  AGENCY_LEVEL_DESCRIPTIONS,
  ASSIGNABLE_AGENCY_LEVELS,
  resolveAgencyLevel,
  type AgencyAccessLevel,
} from '@/lib/auth/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  UserPlus,
  MoreHorizontal,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Eye,
  Loader2,
  CheckCircle2,
  XCircle,
  UsersRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { UserProfile } from '@/types/database'

const LEVEL_ICONS: Record<AgencyAccessLevel, React.ElementType> = {
  owner: ShieldCheck,
  manager: SlidersHorizontal,
  analyst: Eye,
}

const LEVEL_ITEMS: Record<string, string> = Object.fromEntries(
  ASSIGNABLE_AGENCY_LEVELS.map((l) => [l, AGENCY_LEVEL_LABELS[l]])
)

function levelOf(m: UserProfile): AgencyAccessLevel {
  return (resolveAgencyLevel(m.role, m.agency_access_level) ?? 'owner') as AgencyAccessLevel
}

export default function AgencyTeamPage() {
  const [members, setMembers] = useState<UserProfile[]>([])
  const [viewerLevel, setViewerLevel] = useState<AgencyAccessLevel | null>(null)
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editMember, setEditMember] = useState<UserProfile | null>(null)

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch('/api/agency/team')
      const data = await res.json()
      if (data.members) setMembers(data.members)
      if (data.viewerLevel) setViewerLevel(data.viewerLevel)
    } catch {
      toast.error('Failed to load agency team')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  const canManage = viewerLevel === 'owner'
  const activeMembers = members.filter((m) => m.is_active)
  const inactiveMembers = members.filter((m) => !m.is_active)

  const counts = activeMembers.reduce(
    (acc, m) => {
      acc[levelOf(m)] += 1
      return acc
    },
    { owner: 0, manager: 0, analyst: 0 } as Record<AgencyAccessLevel, number>
  )

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8 max-w-4xl">
      {/* Header */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Agency</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">Agency Team</h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
            Manage who works inside your agency and what they can do across every practice.
          </p>
        </div>
        {canManage && (
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger>
              <span className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
                <UserPlus className="h-4 w-4" />
                Invite Staff
              </span>
            </DialogTrigger>
            <InviteDialog
              onClose={() => setInviteOpen(false)}
              onSuccess={() => {
                setInviteOpen(false)
                fetchMembers()
              }}
            />
          </Dialog>
        )}
      </header>

      {/* KPI strip */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard index="01" label="Total Active" value={activeMembers.length} icon={UsersRound} />
        <StatCard index="02" label="Owners" value={counts.owner} icon={ShieldCheck} />
        <StatCard index="03" label="Managers" value={counts.manager} icon={SlidersHorizontal} />
        <StatCard index="04" label="Analysts" value={counts.analyst} icon={Eye} />
      </div>

      {!canManage && !loading && (
        <p className="text-[13px] text-aurea-ink-3 bg-aurea-surface-2 rounded-md px-4 py-3">
          You have <span className="font-medium text-aurea-ink-2">{viewerLevel ? AGENCY_LEVEL_LABELS[viewerLevel] : 'limited'}</span> access —
          you can view the agency team, but only an Agency Owner can invite or change staff.
        </p>
      )}

      {/* Active members */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Active Staff</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">
            {activeMembers.length} active member{activeMembers.length !== 1 ? 's' : ''} in your agency
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
          </div>
        ) : activeMembers.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-aurea-ink-3">No agency staff yet.</p>
        ) : (
          <div className="px-5">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-aurea-border py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-aurea-ink-3">
              <span>Member</span>
              <span className="hidden md:block">Access</span>
              <span className="hidden md:block">Status</span>
              <span />
            </div>
            {activeMembers.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                canManage={canManage}
                onEdit={() => setEditMember(member)}
                onDeactivate={async () => {
                  const res = await fetch(`/api/agency/team/${member.id}`, { method: 'DELETE' })
                  if (!res.ok) {
                    const d = await res.json().catch(() => ({}))
                    toast.error(d.error || 'Failed to deactivate')
                    return
                  }
                  fetchMembers()
                  toast.success(`${member.full_name} has been deactivated`)
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Inactive */}
      {inactiveMembers.length > 0 && (
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[22px] text-aurea-ink-3">Inactive Staff</h2>
          </div>
          <div className="px-5">
            {inactiveMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between gap-4 border-b border-aurea-border py-3.5 last:border-0 opacity-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-aurea-ink line-through">{member.full_name}</p>
                  <p className="truncate font-mono text-[11px] text-aurea-ink-3">{member.email}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[12px]"
                    onClick={async () => {
                      await fetch(`/api/agency/team/${member.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_active: true }),
                      })
                      fetchMembers()
                      toast.success(`${member.full_name} has been reactivated`)
                    }}
                  >
                    Reactivate
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {editMember && (
        <EditDialog
          member={editMember}
          open={!!editMember}
          onClose={() => setEditMember(null)}
          onSuccess={() => {
            setEditMember(null)
            fetchMembers()
          }}
        />
      )}
    </div>
  )
}

function StatCard({
  index,
  label,
  value,
  icon: Icon,
}: {
  index: string
  label: string
  value: number
  icon: React.ElementType
}) {
  return (
    <div className="aurea-card p-5">
      <div className="flex items-center justify-between">
        <p className="aurea-eyebrow">{label}</p>
        <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{index}</span>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <p className="aurea-display text-[40px] tabular-nums text-aurea-ink">{value}</p>
        <Icon className="mb-1.5 h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
      </div>
    </div>
  )
}

function MemberRow({
  member,
  canManage,
  onEdit,
  onDeactivate,
}: {
  member: UserProfile
  canManage: boolean
  onEdit: () => void
  onDeactivate: () => void
}) {
  const level = levelOf(member)
  const Icon = LEVEL_ICONS[level] || Shield
  const initials = member.full_name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex items-center justify-between gap-4 border-b border-aurea-border py-3.5 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-aurea-ink">{member.full_name}</p>
          <p className="truncate font-mono text-[11px] text-aurea-ink-3">{member.email}</p>
        </div>
      </div>

      <div className="hidden md:flex shrink-0 items-center gap-3">
        <Badge variant="outline" className={cn('gap-1 text-xs font-medium', AGENCY_LEVEL_COLORS[level])}>
          <Icon className="h-3 w-3" />
          {AGENCY_LEVEL_LABELS[level]}
        </Badge>
      </div>

      <div className="hidden md:flex shrink-0 items-center gap-1.5">
        {member.is_active ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={2} />
            <span className="text-[12px] text-aurea-primary">Active</span>
          </>
        ) : (
          <>
            <XCircle className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={2} />
            <span className="text-[12px] text-aurea-rose">Inactive</span>
          </>
        )}
      </div>

      <div className="shrink-0">
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-aurea-surface-2 cursor-pointer transition-colors">
                <MoreHorizontal className="h-4 w-4 text-aurea-ink-3" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>Edit Access</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDeactivate} className="text-destructive">
                Deactivate
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

function LevelDescription({ level }: { level: AgencyAccessLevel | '' }) {
  if (!level) return null
  return (
    <p className="text-[12px] text-aurea-ink-3 mt-1 leading-relaxed">{AGENCY_LEVEL_DESCRIPTIONS[level]}</p>
  )
}

function LevelSelect({
  value,
  onChange,
  id,
}: {
  value: string
  onChange: (v: string) => void
  id: string
}) {
  return (
    <Select items={LEVEL_ITEMS} value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select an access level..." />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_AGENCY_LEVELS.map((l) => {
          const Icon = LEVEL_ICONS[l]
          return (
            <SelectItem key={l} value={l}>
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5" />
                {AGENCY_LEVEL_LABELS[l]}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

function InviteDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({ full_name: '', email: '', agency_access_level: '', job_title: '', phone: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/agency/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to invite')
        return
      }
      toast.success(`${form.full_name} has been added to your agency`)
      onSuccess()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Invite Agency Staff</DialogTitle>
        <DialogDescription>
          Add someone to your agency. They&apos;ll receive an email to set up their account.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ag-name">Full Name *</Label>
            <Input id="ag-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ag-email">Email *</Label>
            <Input id="ag-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ag-level">Access Level *</Label>
          <LevelSelect id="ag-level" value={form.agency_access_level} onChange={(v) => setForm({ ...form, agency_access_level: v })} />
          <LevelDescription level={form.agency_access_level as AgencyAccessLevel} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ag-phone">Phone</Label>
          <Input id="ag-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        {error && <p className="text-[13px] text-aurea-rose bg-aurea-rose/10 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting || !form.agency_access_level} className="gap-2">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Inviting...</> : <><UserPlus className="h-4 w-4" />Send Invitation</>}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function EditDialog({
  member,
  open,
  onClose,
  onSuccess,
}: {
  member: UserProfile
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({
    agency_access_level: levelOf(member) as string,
    full_name: member.full_name,
    phone: member.phone || '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/agency/team/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to update')
        return
      }
      toast.success(`${form.full_name} has been updated`)
      onSuccess()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Agency Staff</DialogTitle>
          <DialogDescription>Update {member.full_name}&apos;s access level and details.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-ag-name">Full Name</Label>
            <Input id="edit-ag-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-ag-level">Access Level</Label>
            <LevelSelect id="edit-ag-level" value={form.agency_access_level} onChange={(v) => setForm({ ...form, agency_access_level: v })} />
            <LevelDescription level={form.agency_access_level as AgencyAccessLevel} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-ag-phone">Phone</Label>
            <Input id="edit-ag-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          {error && <p className="text-[13px] text-aurea-rose bg-aurea-rose/10 rounded-md px-3 py-2">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting} className="gap-2">
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Saving...</> : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
