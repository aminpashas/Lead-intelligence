'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Creates an enterprise (DSO umbrella) from the agency portal via
 * /api/agency/enterprises, then refreshes so it appears in the list. Locations
 * are attached later from the Practices onboarding form or the enterprise detail.
 */
export function AddEnterpriseButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  async function create() {
    if (!name.trim()) {
      toast.error('Enterprise name is required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/agency/enterprises', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Could not create enterprise')
        return
      }
      toast.success(`${name.trim()} created`)
      setOpen(false)
      setName('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1.5" />
        New enterprise
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an enterprise account</DialogTitle>
          <DialogDescription>
            An umbrella for a multi-location customer (e.g. a DSO). Add its
            locations afterward from the Practices page or here on the detail view.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="enterprise-name">
              Enterprise name <span className="text-aurea-rose">*</span>
            </Label>
            <Input
              id="enterprise-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bright Smiles DSO"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Create enterprise
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
