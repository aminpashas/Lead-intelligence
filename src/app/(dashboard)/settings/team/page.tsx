'use client'

import { useEffect, useState, useCallback } from 'react'
import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import {
  ROLE_LABELS,
  ROLE_COLORS,
  ASSIGNABLE_ROLES,
  type PracticeRole,
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
import { Separator } from '@/components/ui/separator'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import {
  UserPlus,
  MoreHorizontal,
  Shield,
  ShieldCheck,
  Stethoscope,
  HeartPulse,
  HandHelping,
  ClipboardList,
  Briefcase,
  Loader2,
  CheckCircle2,
  XCircle,
  UsersRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { UserProfile } from '@/types/database'

const ROLE_ICONS: Partial<Record<PracticeRole, React.ElementType>> = {
  doctor_admin: ShieldCheck,
  doctor: Stethoscope,
  nurse: HeartPulse,
  assistant: HandHelping,
  treatment_coordinator: ClipboardList,
  office_manager: Briefcase,
  owner: Shield,
  admin: Shield,
}

const ROLE_ITEMS: Record<string, string> = Object.fromEntries(
  ASSIGNABLE_ROLES.map((r) => [r, ROLE_LABELS[r]])
)

export default function TeamPage() {
  return (
    <RoleGuard requiredPermission="team:manage">
      <TeamContent />
    </RoleGuard>
  )
}

function TeamContent() {
  const { userProfile } = useOrgStore()
  const [members, setMembers] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editMember, setEditMember] = useState<UserProfile | null>(null)
  const [deactivateMember, setDeactivateMember] = useState<UserProfile | null>(null)

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch('/api/team')
      const data = await res.json()
      if (data.members) {
        setMembers(data.members)
      }
    } catch {
      toast.error('Failed to load team members')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  const activeMembers = members.filter((m) => m.is_active)
  const inactiveMembers = members.filter((m) => !m.is_active)

  const roleCounts = activeMembers.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8 max-w-4xl">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Settings</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">Team</h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
            Manage your practice staff, roles, and access levels.
          </p>
        </div>
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger>
            <span className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
              <UserPlus className="h-4 w-4" />
              Invite Member
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
      </header>

      {/* ── KPI strip ───────────────────────────────────────── */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard index="01" label="Total Active" value={activeMembers.length} icon={UsersRound} />
        <StatCard index="02" label="Doctors" value={(roleCounts['doctor_admin'] || 0) + (roleCounts['doctor'] || 0)} icon={Stethoscope} />
        <StatCard index="03" label="Clinical Staff" value={(roleCounts['nurse'] || 0) + (roleCounts['assistant'] || 0)} icon={HeartPulse} />
        <StatCard index="04" label="Admin Staff" value={(roleCounts['office_manager'] || 0) + (roleCounts['treatment_coordinator'] || 0)} icon={Briefcase} />
      </div>

      {/* ── Active members ──────────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Active Members</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">
            {activeMembers.length} active member{activeMembers.length !== 1 ? 's' : ''} in your practice
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
          </div>
        ) : activeMembers.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-aurea-ink-3">
            No team members yet. Invite your first team member to get started.
          </p>
        ) : (
          <div className="px-5">
            {/* Column header row */}
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-aurea-border py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-aurea-ink-3">
              <span>Member</span>
              <span className="hidden md:block">Role</span>
              <span className="hidden md:block">Status</span>
              <span />
            </div>
            {activeMembers.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                currentUserId={userProfile?.id || ''}
                onEdit={() => setEditMember(member)}
                onDeactivate={() => setDeactivateMember(member)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Inactive members ────────────────────────────────── */}
      {inactiveMembers.length > 0 && (
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[22px] text-aurea-ink-3">Inactive Members</h2>
            <p className="mt-0.5 text-[12px] text-aurea-ink-3">
              {inactiveMembers.length} deactivated member{inactiveMembers.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="px-5">
            {inactiveMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between gap-4 border-b border-aurea-border py-3.5 last:border-0 opacity-50"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-3 ring-1 ring-aurea-border">
                    {member.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-aurea-ink line-through">{member.full_name}</p>
                    <p className="truncate font-mono text-[11px] text-aurea-ink-3">{member.email}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant="outline" className="text-xs opacity-50">
                    {ROLE_LABELS[member.role as PracticeRole] || member.role}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[12px]"
                    onClick={async () => {
                      await fetch(`/api/team/${member.id}`, {
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
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Deactivate confirmation ─────────────────────────── */}
      <ConfirmDialog
        open={deactivateMember !== null}
        onOpenChange={(open) => { if (!open) setDeactivateMember(null) }}
        title="Deactivate Team Member"
        description={
          deactivateMember
            ? `Deactivate ${deactivateMember.full_name}? They will lose access to the practice until reactivated.`
            : 'Deactivate this team member?'
        }
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          if (!deactivateMember) return
          await fetch(`/api/team/${deactivateMember.id}`, { method: 'DELETE' })
          fetchMembers()
          toast.success(`${deactivateMember.full_name} has been deactivated`)
        }}
      />

      {/* ── Edit Dialog ─────────────────────────────────────── */}
      {editMember && (
        <EditMemberDialog
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

// ── Stat Card ────────────────────────────────────────────────────

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

// ── Member Row ───────────────────────────────────────────────────

function MemberRow({
  member,
  currentUserId,
  onEdit,
  onDeactivate,
}: {
  member: UserProfile
  currentUserId: string
  onEdit: () => void
  onDeactivate: () => void
}) {
  const role = member.role as PracticeRole
  const RoleIcon = ROLE_ICONS[role] || Shield

  const initials = member.full_name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const isCurrentUser = member.id === currentUserId

  return (
    <div className="flex items-center justify-between gap-4 border-b border-aurea-border py-3.5 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-aurea-ink">
            {member.full_name}
            {isCurrentUser && (
              <span className="text-[11px] text-aurea-ink-3 ml-2">(you)</span>
            )}
          </p>
          <p className="truncate font-mono text-[11px] text-aurea-ink-3">{member.email}</p>
          {/* Phones: the Role/Status columns vanish below md, so carry them
              under the identity instead of dropping them entirely. */}
          <div className="mt-1 flex items-center gap-2 md:hidden">
            <Badge
              variant="outline"
              className={cn('h-4 gap-1 px-1.5 py-0 text-[10px] font-medium', ROLE_COLORS[role])}
            >
              <RoleIcon className="h-2.5 w-2.5" />
              {ROLE_LABELS[role] || role}
            </Badge>
            {member.is_active ? (
              <span className="text-[11px] text-aurea-primary">Active</span>
            ) : (
              <span className="text-[11px] text-aurea-rose">Inactive</span>
            )}
          </div>
        </div>
      </div>

      <div className="hidden md:flex shrink-0 items-center gap-3">
        <Badge
          variant="outline"
          className={cn('gap-1 text-xs font-medium', ROLE_COLORS[role])}
        >
          <RoleIcon className="h-3 w-3" />
          {ROLE_LABELS[role] || role}
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
        {!isCurrentUser && (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-aurea-surface-2 cursor-pointer transition-colors">
                <MoreHorizontal className="h-4 w-4 text-aurea-ink-3" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                Edit Member
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onDeactivate}
                className="text-destructive"
              >
                Deactivate
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

// ── Invite Dialog ────────────────────────────────────────────────

function InviteDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    role: '' as string,
    job_title: '',
    specialty: '',
    phone: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to invite team member')
        return
      }

      if (data.email_sent) {
        toast.success(`${form.full_name} was invited — an email with the setup link is on its way.`)
      } else if (data.invite_url) {
        // Email delivery was clamped (dry-run / test allowlist) or failed.
        // Hand the admin the one-time link so they can deliver it manually.
        try {
          await navigator.clipboard.writeText(data.invite_url)
          toast.success(`${form.full_name} was added. Invite link copied to your clipboard — send it to them directly.`)
        } catch {
          toast.success(`${form.full_name} was added. Invite link (send it to them): ${data.invite_url}`)
        }
      } else {
        toast.success(`${form.full_name} has been added to your team!`)
      }
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
        <DialogTitle>Invite Team Member</DialogTitle>
        <DialogDescription>
          Add a new member to your practice. They&apos;ll receive an email invitation to set up their account.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="invite-name">Full Name *</Label>
            <Input
              id="invite-name"
              placeholder="Dr. Jane Smith"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email *</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="jane@practice.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="invite-role">Role *</Label>
          <Select
            items={ROLE_ITEMS}
            value={form.role}
            onValueChange={(val) => val && setForm({ ...form, role: val })}
            required
          >
            <SelectTrigger id="invite-role">
              <SelectValue placeholder="Select a role..." />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map((r) => {
                const Icon = ROLE_ICONS[r] || Shield
                return (
                  <SelectItem key={r} value={r}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5" />
                      {ROLE_LABELS[r]}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <RoleDescription role={form.role as PracticeRole} />
        </div>

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="invite-title">Job Title</Label>
            <Input
              id="invite-title"
              placeholder="e.g. DDS, RN, CDA"
              value={form.job_title}
              onChange={(e) => setForm({ ...form, job_title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-specialty">Specialty</Label>
            <Input
              id="invite-specialty"
              placeholder="e.g. Implant Surgery"
              value={form.specialty}
              onChange={(e) => setForm({ ...form, specialty: e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="invite-phone">Phone</Label>
          <Input
            id="invite-phone"
            type="tel"
            placeholder="(555) 123-4567"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </div>

        {error && (
          <p className="text-[13px] text-aurea-rose bg-aurea-rose/10 rounded-md px-3 py-2">{error}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !form.role} className="gap-2">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Inviting...
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                Send Invitation
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

// ── Edit Member Dialog ───────────────────────────────────────────

function EditMemberDialog({
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
    role: member.role,
    job_title: member.job_title || '',
    specialty: member.specialty || '',
    phone: member.phone || '',
    full_name: member.full_name,
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/team/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to update member')
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
          <DialogTitle>Edit Team Member</DialogTitle>
          <DialogDescription>
            Update {member.full_name}&apos;s role and profile information.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-name">Full Name</Label>
            <Input
              id="edit-name"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-role">Role</Label>
            <Select
              items={ROLE_ITEMS}
              value={form.role}
              onValueChange={(val) => val && setForm({ ...form, role: val })}
            >
              <SelectTrigger id="edit-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => {
                  const Icon = ROLE_ICONS[r] || Shield
                  return (
                    <SelectItem key={r} value={r}>
                      <span className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5" />
                        {ROLE_LABELS[r]}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <RoleDescription role={form.role as PracticeRole} />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-title">Job Title</Label>
              <Input
                id="edit-title"
                value={form.job_title}
                onChange={(e) => setForm({ ...form, job_title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-specialty">Specialty</Label>
              <Input
                id="edit-specialty"
                value={form.specialty}
                onChange={(e) => setForm({ ...form, specialty: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-phone">Phone</Label>
            <Input
              id="edit-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>

          {error && (
            <p className="text-[13px] text-aurea-rose bg-aurea-rose/10 rounded-md px-3 py-2">{error}</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="gap-2">
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Role Description Helper ──────────────────────────────────────

function RoleDescription({ role }: { role: PracticeRole | '' }) {
  const descriptions: Partial<Record<PracticeRole, string>> = {
    doctor_admin: 'Full access to all features including billing, team management, AI controls, and clinical tools.',
    doctor: 'Clinical and scheduling access only. Cannot manage billing or team.',
    nurse: 'Clinical and scheduling access. Can view leads and manage patient conversations.',
    assistant: 'Clinical and scheduling access. Can view leads and manage patient conversations.',
    treatment_coordinator: 'Clinical access plus marketing tools: campaigns, smart lists, reactivation, and mass messaging.',
    office_manager: 'Full access to all features including billing, team management, AI controls, and clinical tools.',
  }

  if (!role || !descriptions[role]) return null

  return (
    <p className="text-[12px] text-aurea-ink-3 mt-1 leading-relaxed">
      {descriptions[role]}
    </p>
  )
}
