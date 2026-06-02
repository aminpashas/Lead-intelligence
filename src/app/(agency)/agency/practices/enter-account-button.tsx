'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { LogIn, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Drops the agency admin into a client account. Sets the active-account row
 * (which redirects get_user_org_id() at the DB layer), then hard-navigates to
 * the practice dashboard so every server query re-resolves to this client.
 */
export function EnterAccountButton({
  orgId,
  orgName,
  isCurrent,
}: {
  orgId: string
  orgName: string
  isCurrent: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function enter() {
    setLoading(true)
    try {
      const res = await fetch('/api/agency/active-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Could not enter account')
        return
      }
      toast.success(`Now managing ${orgName}`)
      router.push('/pipeline')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      size="sm"
      variant={isCurrent ? 'secondary' : 'default'}
      className="w-full mt-1"
      onClick={enter}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
      ) : (
        <LogIn className="h-3.5 w-3.5 mr-1.5" />
      )}
      {isCurrent ? 'Resume account' : 'Enter account'}
    </Button>
  )
}
