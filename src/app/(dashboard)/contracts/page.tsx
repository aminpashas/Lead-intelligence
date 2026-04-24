'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

const STATUS_STYLES: Record<string, string> = {
  pending_review: 'bg-amber-100 text-amber-800',
  changes_requested: 'bg-orange-100 text-orange-800',
  approved: 'bg-blue-100 text-blue-800',
  sent: 'bg-indigo-100 text-indigo-800',
  viewed: 'bg-purple-100 text-purple-800',
  signed: 'bg-emerald-100 text-emerald-800',
  executed: 'bg-green-100 text-green-900',
  voided: 'bg-slate-100 text-slate-600',
  expired: 'bg-slate-100 text-slate-500',
  declined: 'bg-red-100 text-red-700',
  draft: 'bg-slate-100 text-slate-600',
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
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileSignature className="h-6 w-6" />
            Contracts
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            AI-drafted treatment agreements for patient review and e-signature.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
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

      <Card>
        <CardHeader>
          <CardTitle>
            {rows.length} contract{rows.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">
              No contracts yet. Approve a treatment plan on a case to auto-generate one.
            </div>
          ) : (
            <div className="divide-y">
              {rows.map((row) => (
                <Link
                  href={`/contracts/${row.id}`}
                  key={row.id}
                  className="flex items-center justify-between py-3 hover:bg-slate-50 -mx-2 px-2 rounded"
                >
                  <div className="flex items-center gap-3">
                    <Badge className={STATUS_STYLES[row.status] ?? ''}>{row.status}</Badge>
                    {row.needs_manual_draft && (
                      <Badge variant="outline" className="text-amber-700 border-amber-300">
                        Needs manual draft
                      </Badge>
                    )}
                    <div>
                      <div className="font-medium text-sm">
                        {row.case?.patient_name ?? 'Unknown patient'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.case?.case_number} • v{row.template_version} • updated{' '}
                        {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
                      </div>
                    </div>
                  </div>
                  <div className="text-sm text-slate-700">
                    {formatCurrency(row.contract_amount)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
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
