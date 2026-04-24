'use client'

import { use, useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { RoleGuard } from '@/components/auth/role-guard'
import { useOrgStore } from '@/lib/store/use-org'
import { hasPermission, type PracticeRole } from '@/lib/auth/permissions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Send, XCircle } from 'lucide-react'
import type { PatientContract, RenderedContractSection, ContractEvent } from '@/types/database'

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
    setApproving(true)
    const approve = await fetch(`/api/contracts/${id}/approve`, { method: 'POST' })
    setApproving(false)
    if (!approve.ok) {
      const err = await approve.json().catch(() => ({}))
      toast.error(err.error ?? 'Approve failed')
      return
    }
    setSending(true)
    const send = await fetch(`/api/contracts/${id}/send`, { method: 'POST' })
    setSending(false)
    if (!send.ok) {
      const err = await send.json().catch(() => ({}))
      toast.error(err.error ?? 'Send failed')
      return
    }
    toast.success('Contract approved and sent to patient')
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
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
      </div>
    )
  }
  if (!contract || !data) {
    return <div className="p-6 text-sm text-slate-500">Not found.</div>
  }

  const editable = ['draft', 'pending_review', 'changes_requested'].includes(contract.status)
  const terminal = ['sent', 'viewed', 'signed', 'executed', 'voided', 'expired', 'declined'].includes(
    contract.status
  )

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left: sections */}
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">
              Contract for {data.case?.patient_name}
            </h1>
            <div className="text-xs text-slate-500 mt-1">
              {data.case?.case_number} • template v{contract.template_version} •{' '}
              <Badge variant="outline" className="ml-1">{contract.status}</Badge>
              {contract.needs_manual_draft && (
                <Badge variant="outline" className="ml-2 text-amber-700 border-amber-300">
                  <AlertTriangle className="h-3 w-3 mr-1 inline" />
                  Needs manual draft
                </Badge>
              )}
            </div>
          </div>
        </div>

        {contract.needs_manual_draft && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="pt-4 pb-4 text-sm text-amber-900">
              The AI assistant was unable to produce a clean draft automatically. Please fill in each
              narrative section manually, then click Approve & Send.
            </CardContent>
          </Card>
        )}

        {sections.map((s) => (
          <Card key={s.section_id}>
            <CardHeader className="flex-row flex items-center justify-between pb-2">
              <CardTitle className="text-base">{s.title}</CardTitle>
              {s.ai_generated && <Badge variant="outline" className="text-violet-700 border-violet-300 text-xs">AI draft</Badge>}
              {s.kind === 'data_table' && <Badge variant="outline" className="text-xs">Data</Badge>}
            </CardHeader>
            <CardContent>
              {s.kind === 'data_table' ? (
                <div
                  className="prose prose-sm max-w-none text-slate-700"
                  dangerouslySetInnerHTML={{ __html: s.rendered_html }}
                />
              ) : editable && (s.kind === 'ai_narrative' || s.kind === 'boilerplate') ? (
                <Textarea
                  value={edits[s.section_id] ?? s.rendered_text}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [s.section_id]: e.target.value }))}
                  rows={Math.max(4, Math.min(16, Math.ceil((s.rendered_text || '').length / 80)))}
                  className="text-sm"
                />
              ) : (
                <div className="whitespace-pre-wrap text-sm text-slate-700">
                  {s.rendered_text}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {editable && Object.keys(edits).length > 0 && (
          <div className="sticky bottom-4 bg-white border rounded-lg p-3 flex items-center justify-between shadow-lg">
            <div className="text-sm text-slate-600">
              {Object.keys(edits).length} section{Object.keys(edits).length === 1 ? '' : 's'} edited
            </div>
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
        <Card>
          <CardHeader><CardTitle className="text-base">Financials</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Total</span><span className="font-medium">{formatCurrency(contract.contract_amount)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Deposit</span><span className="font-medium">{formatCurrency(contract.deposit_amount)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Financing</span><span className="font-medium">{contract.financing_type ?? '—'}</span></div>
            {contract.financing_monthly_payment != null && (
              <div className="flex justify-between"><span className="text-slate-500">Monthly</span><span className="font-medium">{formatCurrency(contract.financing_monthly_payment)}</span></div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Actions</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {canApprove && ['pending_review', 'changes_requested'].includes(contract.status) && (
              <Button onClick={approveAndSend} disabled={approving || sending} className="w-full">
                {approving || sending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                Approve &amp; Send
              </Button>
            )}
            {canApprove && ['sent', 'viewed'].includes(contract.status) && (
              <Button onClick={approveAndSend} variant="outline" disabled={sending} className="w-full">
                {sending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
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
                {regenerating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Regenerate draft
              </Button>
            )}
            {canVoid && !['signed', 'executed', 'voided'].includes(contract.status) && (
              <Button onClick={voidContract} variant="outline" className="w-full text-red-700 border-red-300">
                <XCircle className="h-4 w-4 mr-2" /> Void contract
              </Button>
            )}
            {contract.status === 'executed' && (
              <div className="text-sm text-emerald-700 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Executed
              </div>
            )}
            {terminal && contract.status !== 'executed' && (
              <div className="text-sm text-slate-500">No actions available for status <strong>{contract.status}</strong>.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {data.events.length === 0 ? (
              <div className="text-slate-500">No events.</div>
            ) : (
              data.events.map((e) => (
                <div key={e.id} className="flex justify-between">
                  <span className="font-medium">{e.event_type}</span>
                  <span className="text-slate-500">{new Date(e.created_at).toLocaleString()}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        <Separator />
        <div className="text-xs text-slate-400">
          AI model: {contract.ai_model ?? '—'} • in {contract.ai_tokens_in ?? 0}tk • out {contract.ai_tokens_out ?? 0}tk
        </div>
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
