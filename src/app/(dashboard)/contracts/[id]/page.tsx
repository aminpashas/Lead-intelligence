'use client'

import { use, useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { RoleGuard } from '@/components/auth/role-guard'
import { useOrgStore } from '@/lib/store/use-org'
import { hasPermission, type PracticeRole } from '@/lib/auth/permissions'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, Mail, MessageSquare, RefreshCw, Send, XCircle } from 'lucide-react'
import type { PatientContract, RenderedContractSection, ContractEvent } from '@/types/database'

type Channel = 'email' | 'sms'

type Payload = {
  contract: PatientContract
  case: { id: string; case_number: string; patient_name: string; patient_email: string | null; patient_phone: string | null; chief_complaint: string } | null
  events: ContractEvent[]
}

function formatCurrency(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function ContractReviewContent({ id }: { id: string }) {
  const router = useRouter()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole
  const canApprove = hasPermission(role, 'contracts:approve')
  const canVoid = hasPermission(role, 'contracts:void')

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingEdits, setSavingEdits] = useState(false)
  const [approving, setApproving] = useState(false)
  const [sending, setSending] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [channels, setChannels] = useState<Channel[]>(['email'])

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${id}`)
    if (!res.ok) {
      toast.error('Failed to load contract')
      return
    }
    setData(await res.json())
  }, [id])

  useEffect(() => {
    void (async () => {
      await load()
      setLoading(false)
    })()
  }, [load])

  const contract = data?.contract
  const sections = (contract?.generated_content ?? []) as RenderedContractSection[]

  const saveEdits = async () => {
    const section_edits = Object.entries(edits).map(([section_id, rendered_text]) => ({ section_id, rendered_text }))
    if (section_edits.length === 0) return
    setSavingEdits(true)
    const res = await fetch(`/api/contracts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_edits }),
    })
    setSavingEdits(false)
    if (res.ok) {
      toast.success('Edits saved')
      setEdits({})
      await load()
    } else {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Save failed')
    }
  }

  const approveAndSend = async () => {
    if (!contract) return
    if (channels.length === 0) {
      toast.error('Select at least one channel')
      return
    }
    const needsApproval = ['pending_review', 'changes_requested'].includes(contract.status)
    if (needsApproval) {
      setApproving(true)
      const approve = await fetch(`/api/contracts/${id}/approve`, { method: 'POST' })
      setApproving(false)
      if (!approve.ok) {
        const err = await approve.json().catch(() => ({}))
        toast.error(err.error ?? 'Approve failed')
        return
      }
    }
    setSending(true)
    const send = await fetch(`/api/contracts/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels }),
    })
    setSending(false)
    const result = await send.json().catch(() => ({}))
    if (!send.ok) {
      toast.error(result.error ?? 'Send failed')
      return
    }
    // Partial success: some channels delivered, others were refused (e.g. no SMS consent).
    const delivered: Channel[] = result.sent ?? channels
    const label = delivered.map((c: Channel) => (c === 'sms' ? 'text' : 'email')).join(' + ')
    toast.success(`Contract sent to patient via ${label}`)
    const failed = Object.entries((result.errors ?? {}) as Record<string, string>)
    for (const [ch, msg] of failed) {
      toast.warning(`${ch === 'sms' ? 'Text' : 'Email'}: ${msg}`)
    }
    await load()
  }

  const regenerate = async () => {
    setRegenerating(true)
    const res = await fetch(`/api/contracts/${id}/regenerate`, { method: 'POST' })
    setRegenerating(false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Regenerate failed')
      return
    }
    const body = await res.json()
    toast.success('New draft generated')
    router.push(`/contracts/${body.contract_id}`)
  }

  const voidContract = async () => {
    if (!confirm('Void this contract? This cannot be undone.')) return
    const res = await fetch(`/api/contracts/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Void failed')
      return
    }
    toast.success('Contract voided')
    router.push('/contracts')
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
      </div>
    )
  }
  if (!contract || !data) {
    return <div className="text-[13px] text-aurea-ink-3">Not found.</div>
  }

  const editable = ['draft', 'pending_review', 'changes_requested'].includes(contract.status)
  const terminal = ['sent', 'viewed', 'signed', 'executed', 'voided', 'expired', 'declined'].includes(
    contract.status
  )

  // contract/signature status pill styles
  const STATUS_STYLES: Record<string, string> = {
    pending_review: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
    changes_requested: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
    approved: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    sent: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    viewed: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    signed: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    executed: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    voided: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
    expired: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
    declined: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
    draft: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  }

  return (
    <div className="animate-in fade-in-0 duration-500 grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Left: sections */}
      <div className="space-y-5 lg:col-span-2">
        {/* Page header */}
        <header className="border-b border-aurea-border pb-6">
          <p className="aurea-eyebrow mb-2">Patient Agreement</p>
          <h1 className="aurea-display text-[32px] text-aurea-ink">
            Contract for {data.case?.patient_name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-aurea-ink-3">{data.case?.case_number}</span>
            <span className="text-aurea-ink-3">&middot;</span>
            <span className="font-mono text-[12px] text-aurea-ink-3">template v{contract.template_version}</span>
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[contract.status] ?? 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'}`}>
              {contract.status.replace(/_/g, ' ')}
            </span>
            {contract.needs_manual_draft && (
              <span className="inline-flex items-center gap-1 rounded-md border border-aurea-amber/20 bg-aurea-amber/10 px-2 py-0.5 text-[11px] font-medium text-aurea-amber">
                <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                Needs manual draft
              </span>
            )}
          </div>
        </header>

        {contract.needs_manual_draft && (
          <div className="rounded-lg border border-aurea-amber/30 bg-aurea-amber/5 p-4 text-[13px] text-aurea-ink-2">
            The AI assistant was unable to produce a clean draft automatically. Please fill in each
            narrative section manually, then click Approve &amp; Send.
          </div>
        )}

        {sections.map((s) => (
          <section key={s.section_id} className="aurea-card overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-ink">{s.title}</h2>
              <div className="flex items-center gap-2">
                {s.ai_generated && (
                  <span className="inline-flex items-center rounded-md border border-aurea-primary/20 bg-aurea-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-aurea-primary">
                    AI draft
                  </span>
                )}
                {s.kind === 'data_table' && (
                  <span className="inline-flex items-center rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-aurea-ink-3">
                    Data
                  </span>
                )}
              </div>
            </div>
            <div className="px-5 py-4">
              {s.kind === 'data_table' ? (
                <div
                  className="prose prose-sm max-w-none text-aurea-ink-2"
                  dangerouslySetInnerHTML={{ __html: s.rendered_html }}
                />
              ) : editable && (s.kind === 'ai_narrative' || s.kind === 'boilerplate') ? (
                <Textarea
                  value={edits[s.section_id] ?? s.rendered_text}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [s.section_id]: e.target.value }))}
                  rows={Math.max(4, Math.min(16, Math.ceil((s.rendered_text || '').length / 80)))}
                  className="text-[13px]"
                />
              ) : (
                <div className="whitespace-pre-wrap text-[13px] text-aurea-ink-2">
                  {s.rendered_text}
                </div>
              )}
            </div>
          </section>
        ))}

        {editable && Object.keys(edits).length > 0 && (
          <div className="sticky bottom-4 flex items-center justify-between rounded-lg border border-aurea-border-strong bg-aurea-surface p-3">
            <p className="text-[13px] text-aurea-ink-2">
              {Object.keys(edits).length} section{Object.keys(edits).length === 1 ? '' : 's'} edited
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEdits({})}>Discard</Button>
              <Button size="sm" onClick={saveEdits} disabled={savingEdits}>
                {savingEdits ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Right: metadata + actions */}
      <div className="space-y-4">
        {/* Financials */}
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Financials</h2>
          </div>
          <div className="px-5">
            <div className="flex items-center justify-between border-b border-aurea-border py-3">
              <span className="text-[13px] text-aurea-ink-3">Total</span>
              <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{formatCurrency(contract.contract_amount)}</span>
            </div>
            <div className="flex items-center justify-between border-b border-aurea-border py-3">
              <span className="text-[13px] text-aurea-ink-3">Deposit</span>
              <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{formatCurrency(contract.deposit_amount)}</span>
            </div>
            <div className={`flex items-center justify-between py-3 ${contract.financing_monthly_payment != null ? 'border-b border-aurea-border' : ''}`}>
              <span className="text-[13px] text-aurea-ink-3">Financing</span>
              <span className="font-mono text-[13px] text-aurea-ink">{contract.financing_type ?? '—'}</span>
            </div>
            {contract.financing_monthly_payment != null && (
              <div className="flex items-center justify-between py-3">
                <span className="text-[13px] text-aurea-ink-3">Monthly</span>
                <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{formatCurrency(contract.financing_monthly_payment)}</span>
              </div>
            )}
          </div>
        </section>

        {/* Actions */}
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Actions</h2>
          </div>
          <div className="space-y-2 px-5 py-4">
            {canApprove && ['pending_review', 'changes_requested', 'sent', 'viewed'].includes(contract.status) && (
              (() => {
                const hasEmail = !!data.case?.patient_email
                const hasPhone = !!data.case?.patient_phone
                const toggle = (ch: Channel) =>
                  setChannels((prev) =>
                    prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
                  )
                const chip = (ch: Channel, enabled: boolean, Icon: typeof Mail, text: string) => (
                  <button
                    type="button"
                    disabled={!enabled}
                    onClick={() => toggle(ch)}
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                      channels.includes(ch)
                        ? 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary'
                        : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3 hover:text-aurea-ink-2'
                    } ${enabled ? '' : 'cursor-not-allowed opacity-40'}`}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} /> {text}
                  </button>
                )
                return (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-ink-3">
                      Deliver via
                    </p>
                    <div className="flex gap-2">
                      {chip('email', hasEmail, Mail, 'Email')}
                      {chip('sms', hasPhone, MessageSquare, 'Text')}
                    </div>
                    {!hasPhone && (
                      <p className="mt-1.5 text-[11px] text-aurea-ink-3">No phone on file for texting.</p>
                    )}
                  </div>
                )
              })()
            )}
            {canApprove && ['pending_review', 'changes_requested'].includes(contract.status) && (
              <Button onClick={approveAndSend} disabled={approving || sending || channels.length === 0} className="w-full">
                {approving || sending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" strokeWidth={1.75} />}
                Approve &amp; Send
              </Button>
            )}
            {canApprove && ['sent', 'viewed'].includes(contract.status) && (
              <Button onClick={approveAndSend} variant="outline" disabled={sending || channels.length === 0} className="w-full">
                {sending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" strokeWidth={1.75} />}
                Resend link
              </Button>
            )}
            {editable && (
              <Button
                onClick={regenerate}
                variant="outline"
                className="w-full"
                disabled={regenerating}
              >
                {regenerating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" strokeWidth={1.75} />}
                Regenerate draft
              </Button>
            )}
            {canVoid && !['signed', 'executed', 'voided'].includes(contract.status) && (
              <Button onClick={voidContract} variant="outline" className="w-full text-aurea-rose border-aurea-rose/30 hover:bg-aurea-rose/5">
                <XCircle className="h-4 w-4 mr-2" strokeWidth={1.75} /> Void contract
              </Button>
            )}
            {contract.status === 'executed' && (
              <div className="flex items-center gap-2 text-[13px] text-aurea-primary">
                <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> Executed
              </div>
            )}
            {terminal && contract.status !== 'executed' && (
              <p className="text-[13px] text-aurea-ink-3">
                No actions available for status <strong className="text-aurea-ink">{contract.status}</strong>.
              </p>
            )}
          </div>
        </section>

        {/* Timeline */}
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Timeline</h2>
          </div>
          <div className="px-5">
            {data.events.length === 0 ? (
              <p className="py-6 text-[13px] text-aurea-ink-3">No events.</p>
            ) : (
              data.events.map((e) => (
                <div key={e.id} className="flex items-center justify-between border-b border-aurea-border py-3 last:border-0">
                  <span className="text-[12px] font-medium text-aurea-ink">{e.event_type}</span>
                  <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <Separator />
        <p className="font-mono text-[11px] text-aurea-ink-3">
          AI model: {contract.ai_model ?? '—'} &middot; in {contract.ai_tokens_in ?? 0}tk &middot; out {contract.ai_tokens_out ?? 0}tk
        </p>
      </div>
    </div>
  )
}

export default function ContractReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <RoleGuard requiredPermission="contracts:read">
      <ContractReviewContent id={id} />
    </RoleGuard>
  )
}
