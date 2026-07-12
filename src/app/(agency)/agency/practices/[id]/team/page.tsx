'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserPlus, MoreHorizontal, Loader2, ArrowLeft, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { UserProfile } from '@/types/database'

const ROLE_ITEMS: Record<string, string> = Object.fromEntries(
  ASSIGNABLE_ROLES.map((r) => [r, ROLE_LABELS[r]])
)

export default function PracticeTeamPage() {
  const params = useParams<{ id: string }>()
  const practiceId = params.id

  const [members, setMembers] = useState<UserProfile[]>([])
  const [practiceName, setPracticeName] = useState('')
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editMember, setEditMember] = useState<UserProfile | null>(null)

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/agency/practices/${practiceId}/team`)
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load practice team')
        return
      }
      setMembers(data.members || [])
      setPracticeName(data.practice?.name || 'Practice')
      setCanManage(!!data.canManage)
    } catch {
      toast.error('Failed to load practice team')
    } finally {
      setLoading(false)
    }
  }, [practiceId])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  const activeMembers = members.filter((m) => m.is_active)
  const inactiveMembers = members.filter((m) => !m.is_active)

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        href="/agency/practices"
        className="inline-flex items-center gap-1.5 text-xs text-aurea-ink-3 hover:text-aurea-ink transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All practices
      </Link>

      <header className="flex flex-col gap-4 border-b border-aurea-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-2">Practice Team</p>
          <h1 className="text-2xl font-bold text-aurea-ink">{practiceName || '—'}</h1>
          <p className="text-aurea-ink-2 text-sm mt-1">Manage this practice&apos;s staff, roles, and access.</p>
        </div>
        {canManage && (
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger>
              <span className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
                <UserPlus className="h-4 w-4" />
                Invite Member
              </span>
            </DialogTrigger>
            <InviteDialog
              practiceId={practiceId}
              onClose={() => setInviteOpen(false)}
              onSuccess={() => {
                setInviteOpen(false)
                fetchMembers()
              }}
            />
          </Dialog>
        )}
      </header>

      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="text-base font-semibold text-aurea-ink">Active Members</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">{activeMembers.length} active</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
          </div>
        ) : activeMembers.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-aurea-ink-3">No team members yet.</p>
        ) : (
          <div className="px-5">
            {activeMembers.map((m) => (
              <Row
                key={m.id}
                member={m}
                canManage={canManage}
                onEdit={() => setEditMember(m)}
                onDeactivate={async () => {
                  const res = await fetch(`/api/agency/practices/${practiceId}/team/${m.id}`, { method: 'DELETE' })
                  if (!res.ok) {
                    const d = await res.json().catch(() => ({}))
                    toast.error(d.error || 'Failed to deactivate')
                    return
                  }
                  fetchMembers()
                  toast.success(`${m.full_name} deactivated`)
                }}
              />
            ))}
          </div>
        )}
      </section>

      {inactiveMembers.length > 0 && (
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="text-base font-semibold text-aurea-ink-3">Inactive Members</h2>
          </div>
          <div className="px-5">
            {inactiveMembers.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-4 border-b border-aurea-border py-3.5 last:border-0 opacity-50">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-aurea-ink line-through">{m.full_name}</p>
                  <p className="truncate font-mono text-[11px] text-aurea-ink-3">{m.email}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[12px]"
                    onClick={async () => {
                      await fetch(`/api/agency/practices/${practiceId}/team/${m.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_active: true }),
                      })
                      fetchMembers()
                      toast.success(`${m.full_name} reactivated`)
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
          practiceId={practiceId}
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

function Row({
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
  const role = member.role as PracticeRole
  const initials = member.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
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
      <div className="hidden sm:flex shrink-0 items-center gap-3">
        <Badge variant="outline" className={cn('text-xs font-medium', ROLE_COLORS[role])}>
          {ROLE_LABELS[role] || role}
        </Badge>
        {member.is_active ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={2} />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={2} />
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
              <DropdownMenuItem onClick={onEdit}>Edit Member</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDeactivate} className="text-destructive">Deactivate</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

function InviteDialog({
  practiceId,
  onClose,
  onSuccess,
}: {
  practiceId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({ full_name: '', email: '', role: '', job_title: '', phone: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/agency/practices/${practiceId}/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to invite')
        return
      }
      toast.success(`${form.full_name} added to the practice`)
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
        <DialogTitle>Invite Practice Member</DialogTitle>
        <DialogDescription>Add a staff member to this practice.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="pt-name">Full Name *</Label>
            <Input id="pt-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pt-email">Email *</Label>
            <Input id="pt-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pt-role">Role *</Label>
          <Select items={ROLE_ITEMS} value={form.role} onValueChange={(v) => v && setForm({ ...form, role: v })}>
            <SelectTrigger id="pt-role">
              <SelectValue placeholder="Select a role..." />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="pt-title">Job Title</Label>
            <Input id="pt-title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pt-phone">Phone</Label>
            <Input id="pt-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
        </div>
        {error && <p className="text-[13px] text-aurea-rose bg-aurea-rose/10 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting || !form.role} className="gap-2">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Inviting...</> : <><UserPlus className="h-4 w-4" />Send Invitation</>}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function EditDialog({
  practiceId,
  member,
  open,
  onClose,
  onSuccess,
}: {
  practiceId: string
  member: UserProfile
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({ role: member.role, full_name: member.full_name, job_title: member.job_title || '', phone: member.phone || '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/agency/practices/${practiceId}/team/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to update')
        return
      }
      toast.success(`${form.full_name} updated`)
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
          <DialogTitle>Edit Practice Member</DialogTitle>
          <DialogDescription>Update {member.full_name}&apos;s role and details.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pte-name">Full Name</Label>
            <Input id="pte-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pte-role">Role</Label>
            <Select items={ROLE_ITEMS} value={form.role} onValueChange={(v) => v && setForm({ ...form, role: v })}>
              <SelectTrigger id="pte-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pte-title">Job Title</Label>
              <Input id="pte-title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pte-phone">Phone</Label>
              <Input id="pte-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
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
