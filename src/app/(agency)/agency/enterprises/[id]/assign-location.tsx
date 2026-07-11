'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Attaches a standalone location (organization) to this enterprise via
 * PATCH /api/agency/enterprises/[id] { assign_org }. The list is standalone orgs
 * (enterprise_account_id IS NULL) passed from the server page.
 */
export function AssignLocation({
  enterpriseId,
  options,
}: {
  enterpriseId: string
  options: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [orgId, setOrgId] = useState('')
  const [saving, setSaving] = useState(false)

  async function assign() {
    if (!orgId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/agency/enterprises/${enterpriseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assign_org: orgId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Could not attach location')
        return
      }
      toast.success('Location attached')
      setOrgId('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  if (options.length === 0) {
    return <p className="text-xs text-aurea-ink-3">No standalone locations to attach.</p>
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={orgId} onValueChange={(v) => v && setOrgId(v)}>
        <SelectTrigger className="w-[220px] h-9">
          <SelectValue placeholder="Attach a location…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" onClick={assign} disabled={!orgId || saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      </Button>
    </div>
  )
}
