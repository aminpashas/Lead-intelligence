'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, FileSignature } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

type ContractRow = {
  id: string
  status: string
  created_at: string
  updated_at: string
  sent_at: string | null
  signed_at: string | null
  contract_amount: number | null
  deposit_amount: number | null
  financing_type: string | null
  template_version: number
  needs_manual_draft: boolean
  clinical_case_id: string
  case: { case_number: string; patient_name: string } | null
}

// contract/signature status semantics:
//   active/signed/executed → emerald (aurea-primary)
//   pending/changes → amber
//   approved/sent/viewed → primary (emerald tint)
//   error/declined → rose
//   neutral/draft/expired/voided → muted ink
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

function formatCurrency(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function ContractsContent() {
  const [rows, setRows] = useState<ContractRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('')

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const res = await fetch(`/api/contracts${filter ? `?status=${filter}` : ''}`)
      const data = res.ok ? await res.json() : { contracts: [] }
      setRows(data.contracts ?? [])
      setLoading(false)
    })()
  }, [filter])

  const FILTERS: Array<{ label: string; value: string }> = [
    { label: 'All', value: '' },
    { label: 'Pending Review', value: 'pending_review' },
    { label: 'Approved', value: 'approved' },
    { label: 'Sent', value: 'sent' },
    { label: 'Signed', value: 'signed' },
    { label: 'Executed', value: 'executed' },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Patient Agreements</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px] flex items-center gap-3">
          <FileSignature className="h-9 w-9 text-aurea-ink-3" strokeWidth={1.75} />
          Contracts
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          AI-drafted treatment agreements for patient review and e-signature.
        </p>
      </header>

      {/* ── Filters ────────────────────────────────────────── */}
      <div className="mt-8 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.value || 'all'}
            size="sm"
            variant={filter === f.value ? 'default' : 'outline'}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* ── Contracts list ─────────────────────────────────── */}
      <section className="mt-5 aurea-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">
            {rows.length} contract{rows.length === 1 ? '' : 's'}
          </h2>
        </div>
        <div className="px-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-aurea-ink-3">
              No contracts yet. Approve a treatment plan on a case to auto-generate one.
            </p>
          ) : (
            rows.map((row) => (
              <Link
                href={`/contracts/${row.id}`}
                key={row.id}
                className="-mx-5 flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-3.5 transition-colors last:border-0 hover:bg-aurea-surface-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[row.status] ?? 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'}`}>
                    {row.status.replace(/_/g, ' ')}
                  </span>
                  {row.needs_manual_draft && (
                    <span className="inline-flex items-center rounded-md border border-aurea-amber/20 bg-aurea-amber/10 px-2 py-0.5 text-[11px] font-medium text-aurea-amber">
                      Needs manual draft
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-aurea-ink">
                      {row.case?.patient_name ?? 'Unknown patient'}
                    </p>
                    <p className="truncate font-mono text-[11px] text-aurea-ink-3">
                      {row.case?.case_number} &middot; v{row.template_version} &middot; updated{' '}
                      {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[14px] tabular-nums text-aurea-ink">
                  {formatCurrency(row.contract_amount)}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export default function ContractsPage() {
  return (
    <RoleGuard requiredPermission="contracts:read">
      <ContractsContent />
    </RoleGuard>
  )
}
