'use client'

import { useEffect, useState, useCallback } from 'react'
import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import {
  ROLE_LABELS,
  ROLE_COLORS,
  ASSIGNABLE_ROLES,
  isAdminRole,
  type PracticeRole,
} from '@/lib/auth/permissions'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team Management</h1>
          <p className="text-muted-foreground">
            Manage your practice staff, roles, and access levels
          </p>
        </div>
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger>
            <span className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
              <UserPlus className="h-4 w-4" />
              Invite Team Member
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
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Active"
          value={activeMembers.length}
          icon={UsersRound}
          gradient="from-violet-500/10 to-purple-500/10"
          iconColor="text-violet-600 dark:text-violet-400"
        />
        <StatCard
          label="Doctors"
          value={(roleCounts['doctor_admin'] || 0) + (roleCounts['doctor'] || 0)}
          icon={Stethoscope}
          gradient="from-blue-500/10 to-cyan-500/10"
          iconColor="text-blue-600 dark:text-blue-400"
        />
        <StatCard
          label="Clinical Staff"
          value={(roleCounts['nurse'] || 0) + (roleCounts['assistant'] || 0)}
          icon={HeartPulse}
          gradient="from-emerald-500/10 to-teal-500/10"
          iconColor="text-emerald-600 dark:text-emerald-400"
        />
        <StatCard
          label="Admin Staff"
          value={(roleCounts['office_manager'] || 0) + (roleCounts['treatment_coordinator'] || 0)}
          icon={Briefcase}
          gradient="from-amber-500/10 to-orange-500/10"
          iconColor="text-amber-600 dark:text-amber-400"
        />
      </div>

      {/* Team Table */}
      <Card>
        <CardHeader>
          <CardTitle>Active Team Members</CardTitle>
          <CardDescription>
            {activeMembers.length} active member{activeMembers.length !== 1 ? 's' : ''} in your practice
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">Title</TableHead>
                  <TableHead className="hidden lg:table-cell">Specialty</TableHead>
                  <TableHead className="hidden md:table-cell">Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeMembers.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    currentUserId={userProfile?.id || ''}
                    onEdit={() => setEditMember(member)}
                    onDeactivate={async () => {
                      await fetch(`/api/team/${member.id}`, { method: 'DELETE' })
                      fetchMembers()
                      toast.success(`${member.full_name} has been deactivated`)
                    }}
                  />
                ))}
                {activeMembers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                      No team members yet. Invite your first team member to get started.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Inactive Members */}
      {inactiveMembers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-muted-foreground">Inactive Members</CardTitle>
            <CardDescription>
              {inactiveMembers.length} deactivated member{inactiveMembers.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team Member</TableHead>
                  <TableHead>Former Role</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {inactiveMembers.map((member) => (
                  <TableRow key={member.id} className="opacity-60">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs">
                            {member.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium text-sm line-through">{member.full_name}</p>
                          <p className="text-xs text-muted-foreground">{member.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs opacity-50">
                        {ROLE_LABELS[member.role as PracticeRole] || member.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog */}
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

// ── Stat Card ──────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  gradient,
  iconColor,
}: {
  label: string
  value: number
  icon: React.ElementType
  gradient: string
  iconColor: string
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br', gradient)}>
            <Icon className={cn('h-5 w-5', iconColor)} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Member Row ──────────────────────────────────────────────────

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
  const canModify = !isCurrentUser && isAdminRole(member.role)

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="text-xs font-medium">{initials}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-sm">
              {member.full_name}
              {isCurrentUser && (
                <span className="text-xs text-muted-foreground ml-2">(you)</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{member.email}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn('gap-1 text-xs font-medium', ROLE_COLORS[role])}
        >
          <RoleIcon className="h-3 w-3" />
          {ROLE_LABELS[role] || role}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="text-sm text-muted-foreground">
          {member.job_title || '—'}
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span className="text-sm text-muted-foreground">
          {member.specialty || '—'}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <div className="flex items-center gap-1.5">
          {member.is_active ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              <span className="text-xs text-emerald-600 dark:text-emerald-400">Active</span>
            </>
          ) : (
            <>
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs text-red-600 dark:text-red-400">Inactive</span>
            </>
          )}
        </div>
      </TableCell>
      <TableCell>
        {!isCurrentUser && (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent cursor-pointer">
                <MoreHorizontal className="h-4 w-4" />
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
      </TableCell>
    </TableRow>
  )
}

// ── Invite Dialog ───────────────────────────────────────────────

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

      toast.success(`${form.full_name} has been added to your team!`)
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
          <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
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

// ── Edit Member Dialog ──────────────────────────────────────────

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
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
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

// ── Role Description Helper ─────────────────────────────────────

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
    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
      {descriptions[role]}
    </p>
  )
}
