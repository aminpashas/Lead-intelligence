'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { TagSelector } from './tag-selector'
import { Layers, Loader2, AlertTriangle, Phone } from 'lucide-react'
import { toast } from 'sonner'
import type { SmartList, PipelineStage, Tag } from '@/types/database'

type UserOption = { id: string; full_name: string }

/**
 * Bulk actions over every lead matching a Smart List — the UI activation of
 * the existing /api/leads/bulk and /api/leads/bulk/tags endpoints. Resolves
 * the full membership client-side (paged), then executes in endpoint-sized
 * batches with a progress readout.
 */

// Mirrors the mass-send audience cap; a bulk action should never silently
// operate on more leads than a broadcast could reach.
const AUDIENCE_CAP = 2000
// /api/leads/bulk caps lead_ids at 100 per call; tags endpoint at 500.
const BULK_BATCH = 100
const TAGS_BATCH = 500
// Re-scoring runs one LLM call per lead server-side — keep requests small so
// each stays well inside the function timeout, and cap the total.
const SCORE_BATCH = 10
const SCORE_CAP = 200
// Server (`/api/smart-lists/[id]/call-queue`) caps call-task creation per run;
// mirror it so the UI's affected count and copy match what actually happens.
const CALL_QUEUE_CAP = 500

const STATUS_OPTIONS = [
  'new', 'contacted', 'qualified', 'consultation_scheduled',
  'consultation_completed', 'treatment_presented', 'financing',
  'contract_sent', 'contract_signed', 'scheduled', 'in_treatment',
  'completed', 'lost', 'disqualified', 'no_show', 'unresponsive',
]

// value → trigger label map (Base UI Select renders the raw value otherwise)
const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  STATUS_OPTIONS.map((s) => [s, s.replace(/_/g, ' ')])
)

type BulkActionKind =
  | 'score' | 'change_status' | 'change_stage'
  | 'add_tags' | 'remove_tags' | 'enroll_campaign' | 'disqualify'
  | 'create_call_tasks'

const ACTION_LABELS: Record<BulkActionKind, string> = {
  create_call_tasks: 'Create call tasks',
  score: 'Re-score with AI',
  change_status: 'Change status',
  change_stage: 'Move to pipeline stage',
  add_tags: 'Add tags',
  remove_tags: 'Remove tags',
  enroll_campaign: 'Enroll in campaign',
  disqualify: 'Disqualify',
}

interface SmartListBulkActionsProps {
  smartList: SmartList
  total: number
  stages: PipelineStage[]
  tags: Tag[]
  onDone: () => void
}

export function SmartListBulkActions({ smartList, total, stages, tags, onDone }: SmartListBulkActionsProps) {
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<BulkActionKind>('change_status')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // Action params
  const [status, setStatus] = useState('contacted')
  const [stageId, setStageId] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [reason, setReason] = useState('')
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string; type: string }>>([])

  // Call-queue params
  const [assigneeMode, setAssigneeMode] = useState<'team' | 'user'>('team')
  const [assignedTo, setAssignedTo] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [includeWithoutPhone, setIncludeWithoutPhone] = useState(false)
  const [note, setNote] = useState('')
  const [teamMembers, setTeamMembers] = useState<UserOption[]>([])

  useEffect(() => {
    if (!open) return
    fetch('/api/campaigns?status=active')
      .then((r) => (r.ok ? r.json() : { campaigns: [] }))
      .then((d) => setCampaigns(
        (d.campaigns || []).filter((c: { type: string }) => c.type !== 'broadcast')
      ))
      .catch(() => setCampaigns([]))
    fetch('/api/team')
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setTeamMembers(
        (d.members || []).filter((m: { is_active?: boolean }) => m.is_active !== false)
      ))
      .catch(() => setTeamMembers([]))
  }, [open])

  /** Page through the smart list endpoint to collect every matching lead id. */
  async function resolveAllLeadIds(): Promise<string[]> {
    const ids: string[] = []
    let page = 1
    for (;;) {
      const res = await fetch(`/api/smart-lists/${smartList.id}/leads?page=${page}&per_page=100`)
      if (!res.ok) throw new Error('Failed to resolve Smart List members')
      const data = await res.json()
      for (const lead of data.leads as Array<{ id: string }>) ids.push(lead.id)
      if (page >= data.pagination.total_pages || ids.length >= AUDIENCE_CAP) break
      page++
    }
    return ids.slice(0, AUDIENCE_CAP)
  }

  function validParams(): string | null {
    if (action === 'change_stage' && !stageId) return 'Pick a pipeline stage'
    if ((action === 'add_tags' || action === 'remove_tags') && tagIds.length === 0) return 'Pick at least one tag'
    if (action === 'enroll_campaign' && !campaignId) return 'Pick a campaign'
    if (action === 'create_call_tasks' && assigneeMode === 'user' && !assignedTo) return 'Pick a person to assign'
    return null
  }

  /**
   * Call queue: the server resolves list membership and creates the tasks in one
   * request (dedupe + assignment live there), so — unlike the lead-mutating
   * actions below — we don't page member ids or batch client-side.
   */
  async function runCreateCallTasks() {
    const res = await fetch(`/api/smart-lists/${smartList.id}/call-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignee_mode: assigneeMode,
        ...(assigneeMode === 'user' ? { assigned_to: assignedTo } : {}),
        include_without_phone: includeWithoutPhone,
        ...(dueAt ? { due_at: new Date(dueAt).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to create call tasks')
    }
    const data = await res.json()
    if (data.created === 0 && data.deduped > 0) {
      toast.info(`Already queued — ${data.deduped.toLocaleString()} call task${data.deduped === 1 ? '' : 's'} already open for this list`)
    } else if (data.created === 0) {
      toast.error('No matching leads to call (try enabling "include leads without a phone")')
    } else {
      const extra = data.deduped > 0 ? `, ${data.deduped.toLocaleString()} already queued` : ''
      const capNote = data.capped ? ` (capped at ${CALL_QUEUE_CAP} — re-run for the rest)` : ''
      toast.success(`${data.created.toLocaleString()} call task${data.created === 1 ? '' : 's'} created${extra}${capNote}`)
    }
  }

  async function run() {
    const paramError = validParams()
    if (paramError) {
      toast.error(paramError)
      return
    }

    setRunning(true)
    setProgress(null)
    try {
      if (action === 'create_call_tasks') {
        await runCreateCallTasks()
        setOpen(false)
        onDone()
        return
      }

      let ids = await resolveAllLeadIds()
      if (ids.length === 0) {
        toast.error('No leads match this Smart List')
        return
      }
      if (action === 'score' && ids.length > SCORE_CAP) {
        ids = ids.slice(0, SCORE_CAP)
        toast.info(`Re-scoring is capped at ${SCORE_CAP} leads per run (newest first)`)
      }

      let success = 0
      let failed = 0

      if (action === 'add_tags' || action === 'remove_tags') {
        for (let i = 0; i < ids.length; i += TAGS_BATCH) {
          const batch = ids.slice(i, i + TAGS_BATCH)
          const res = await fetch('/api/leads/bulk/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lead_ids: batch,
              ...(action === 'add_tags' ? { add_tag_ids: tagIds } : { remove_tag_ids: tagIds }),
            }),
          })
          if (res.ok) success += batch.length
          else failed += batch.length
          setProgress({ done: Math.min(i + TAGS_BATCH, ids.length), total: ids.length })
        }
      } else {
        const batchSize = action === 'score' ? SCORE_BATCH : BULK_BATCH
        const payloadBase: Record<string, unknown> =
          action === 'change_status' ? { action, status }
          : action === 'change_stage' ? { action, stage_id: stageId }
          : action === 'enroll_campaign' ? { action, campaign_id: campaignId }
          : action === 'disqualify' ? { action, disqualified_reason: reason.trim() || undefined }
          : { action }

        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize)
          const res = await fetch('/api/leads/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payloadBase, lead_ids: batch }),
          })
          if (res.ok) {
            const data = await res.json()
            success += data.success ?? batch.length
            failed += data.failed ?? 0
          } else {
            failed += batch.length
          }
          setProgress({ done: Math.min(i + batchSize, ids.length), total: ids.length })
        }
      }

      if (failed === 0) {
        toast.success(`${ACTION_LABELS[action]}: ${success.toLocaleString()} leads updated`)
      } else {
        toast.warning(`${ACTION_LABELS[action]}: ${success.toLocaleString()} updated, ${failed.toLocaleString()} failed`)
      }
      setOpen(false)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk action failed')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const affected = Math.min(
    total,
    action === 'score' ? SCORE_CAP : action === 'create_call_tasks' ? CALL_QUEUE_CAP : AUDIENCE_CAP
  )

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Layers className="h-[15px] w-[15px]" strokeWidth={1.75} />
        Bulk Actions
      </Button>

      <Dialog open={open} onOpenChange={(v) => !running && setOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="aurea-display text-[18px] text-aurea-ink">
              Bulk action — {smartList.name}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-[13px]">Action</Label>
              <Select items={ACTION_LABELS} value={action} onValueChange={(v) => setAction(v as BulkActionKind)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACTION_LABELS) as BulkActionKind[]).map((k) => (
                    <SelectItem key={k} value={k}>{ACTION_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {action === 'change_status' && (
              <div className="space-y-2">
                <Label className="text-[13px]">New status</Label>
                <Select items={STATUS_LABELS} value={status} onValueChange={(v) => v && setStatus(v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {action === 'change_stage' && (
              <div className="space-y-2">
                <Label className="text-[13px]">Pipeline stage</Label>
                <Select value={stageId} onValueChange={(v) => v && setStageId(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a stage">
                      {(value) => stages.find((s) => s.id === value)?.name ?? 'Pick a stage'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {(action === 'add_tags' || action === 'remove_tags') && (
              <div className="space-y-2">
                <Label className="text-[13px]">Tags</Label>
                <TagSelector
                  selectedTagIds={tagIds}
                  onTagsChange={setTagIds}
                  availableTags={tags}
                />
              </div>
            )}

            {action === 'enroll_campaign' && (
              <div className="space-y-2">
                <Label className="text-[13px]">Campaign</Label>
                <Select value={campaignId} onValueChange={(v) => v && setCampaignId(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick an active campaign">
                      {(value) => campaigns.find((c) => c.id === value)?.name ?? 'Pick an active campaign'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.length === 0 ? (
                      <SelectItem value="__none__" disabled>No active campaigns</SelectItem>
                    ) : campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-aurea-ink-3">
                  Campaign sends still pass every consent and quiet-hours gate per lead.
                </p>
              </div>
            )}

            {action === 'disqualify' && (
              <div className="space-y-2">
                <Label className="text-[13px]">Reason</Label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Out of service area"
                />
              </div>
            )}

            {action === 'score' && (
              <p className="text-[12px] text-aurea-ink-3 leading-relaxed">
                Runs the AI scoring engine on each lead and refreshes score, qualification,
                and summary. Capped at {SCORE_CAP} leads per run.
              </p>
            )}

            {action === 'create_call_tasks' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-[13px]">Assign to</Label>
                  <Select
                    items={{ team: 'Team queue (anyone can claim)', user: 'A specific person' }}
                    value={assigneeMode}
                    onValueChange={(v) => v && setAssigneeMode(v as 'team' | 'user')}
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="team">Team queue (anyone can claim)</SelectItem>
                      <SelectItem value="user">A specific person</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {assigneeMode === 'user' && (
                  <div className="space-y-2">
                    <Label className="text-[13px]">Person</Label>
                    <Select value={assignedTo} onValueChange={(v) => v && setAssignedTo(v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Pick a team member">
                          {(value) => teamMembers.find((u) => u.id === value)?.full_name ?? 'Pick a team member'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {teamMembers.length === 0 ? (
                          <SelectItem value="__none__" disabled>No team members</SelectItem>
                        ) : teamMembers.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-[13px]">Due (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-[13px]">Note (optional)</Label>
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Context for whoever makes the call…"
                    rows={2}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label className="text-[13px]">Include leads without a phone</Label>
                    <p className="text-[11px] text-aurea-ink-3">
                      Off by default — a call task needs a number to dial.
                    </p>
                  </div>
                  <Switch checked={includeWithoutPhone} onCheckedChange={setIncludeWithoutPhone} />
                </div>
              </div>
            )}

            {action === 'create_call_tasks' ? (
              <div className="flex items-start gap-2 rounded-lg border border-aurea-border bg-aurea-surface-2 p-3">
                <Phone className="mt-0.5 h-[15px] w-[15px] shrink-0 text-aurea-ink-2" strokeWidth={1.75} />
                <p className="text-[12px] leading-relaxed text-aurea-ink-2">
                  Creates a call task for up to{' '}
                  <span className="font-mono tabular-nums font-medium">{affected.toLocaleString()}</span> lead{affected === 1 ? '' : 's'} in
                  this Smart List — they appear in your <span className="font-medium">Tasks</span> queue. Re-running is safe:
                  leads already queued aren&apos;t duplicated.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-aurea-amber/30 bg-aurea-amber/5 p-3">
                <AlertTriangle className="mt-0.5 h-[15px] w-[15px] shrink-0 text-aurea-amber" strokeWidth={1.75} />
                <p className="text-[12px] leading-relaxed text-aurea-ink-2">
                  This will apply <span className="font-medium">{ACTION_LABELS[action].toLowerCase()}</span> to{' '}
                  <span className="font-mono tabular-nums font-medium">{affected.toLocaleString()}</span> lead{affected === 1 ? '' : 's'} currently
                  matching this Smart List. It cannot be undone in one click.
                </p>
              </div>
            )}

            {progress && (
              <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()} processed…
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={running}>
                Cancel
              </Button>
              <Button onClick={run} disabled={running} className="gap-1.5">
                {running && <Loader2 className="h-4 w-4 animate-spin" />}
                {running
                  ? action === 'create_call_tasks' ? 'Creating…' : 'Applying…'
                  : action === 'create_call_tasks'
                    ? `Create up to ${affected.toLocaleString()} call tasks`
                    : `Apply to ${affected.toLocaleString()} leads`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
