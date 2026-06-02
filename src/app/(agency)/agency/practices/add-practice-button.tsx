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
 * Onboards a new client practice from the agency portal. Creates the org via
 * /api/agency/practices (which seeds default pipeline stages), then refreshes
 * so the new practice appears in the picker.
 */
export function AddPracticeButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  async function create() {
    if (!name.trim()) {
      toast.error('Practice name is required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/agency/practices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Could not create practice')
        return
      }
      toast.success(`${name.trim()} added`)
      setOpen(false)
      setName('')
      setEmail('')
      setPhone('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add practice
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a client practice</DialogTitle>
          <DialogDescription>
            Creates a new practice account. You can enter it immediately and set up
            its pipeline, connectors, and team.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="practice-name">
              Practice name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="practice-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dion Health Los Angeles"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="practice-email">Email (optional)</Label>
            <Input
              id="practice-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="hello@practice.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="practice-phone">Phone (optional)</Label>
            <Input
              id="practice-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Create practice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
