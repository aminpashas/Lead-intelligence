'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export function NewLeadDialog() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    city: '',
    state: '',
    zip_code: '',
    dental_condition: '',
    dental_condition_details: '',
    current_dental_situation: '',
    has_dentures: false,
    has_dental_insurance: false,
    insurance_provider: '',
    financing_interest: '',
    budget_range: '',
    source_type: '',
    utm_source: '',
    utm_campaign: '',
    notes: '',
  })

  function updateField(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      const payload = {
        ...form,
        dental_condition: form.dental_condition || undefined,
        financing_interest: form.financing_interest || undefined,
        budget_range: form.budget_range || undefined,
        source_type: form.source_type || undefined,
        email: form.email || undefined,
      }

      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create lead')
      }

      const { lead } = await res.json()

      toast.success(`Lead created: ${lead.first_name} ${lead.last_name || ''}`)

      // Auto-score the new lead
      fetch(`/api/leads/${lead.id}/score`, { method: 'POST' }).catch((err: unknown) => console.warn('[new-lead] Auto-score failed:', err))

      setOpen(false)
      setForm({
        first_name: '', last_name: '', email: '', phone: '',
        city: '', state: '', zip_code: '',
        dental_condition: '', dental_condition_details: '',
        current_dental_situation: '', has_dentures: false,
        has_dental_insurance: false, insurance_provider: '',
        financing_interest: '', budget_range: '',
        source_type: '', utm_source: '', utm_campaign: '', notes: '',
      })
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create lead')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <span className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
          <Plus className="h-4 w-4" />
          Add Lead
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Lead</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <Tabs defaultValue="contact" className="mt-4">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="contact">Contact</TabsTrigger>
              <TabsTrigger value="dental">Dental</TabsTrigger>
              <TabsTrigger value="financial">Financial</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
            </TabsList>

            {/* Contact Info */}
            <TabsContent value="contact" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="first_name">First Name *</Label>
                  <Input
                    id="first_name"
                    value={form.first_name}
                    onChange={(e) => updateField('first_name', e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last_name">Last Name</Label>
                  <Input
                    id="last_name"
                    value={form.last_name}
                    onChange={(e) => updateField('last_name', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => updateField('email', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={form.phone}
                    onChange={(e) => updateField('phone', e.target.value)}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={form.city}
                    onChange={(e) => updateField('city', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input
                    id="state"
                    value={form.state}
                    onChange={(e) => updateField('state', e.target.value)}
                    placeholder="CA"
                    maxLength={2}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zip_code">ZIP</Label>
                  <Input
                    id="zip_code"
                    value={form.zip_code}
                    onChange={(e) => updateField('zip_code', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => updateField('notes', e.target.value)}
                  rows={3}
                  placeholder="Any additional notes about this lead..."
                />
              </div>
            </TabsContent>

            {/* Dental Info */}
            <TabsContent value="dental" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Dental Condition</Label>
                <Select
                  value={form.dental_condition}
                  onValueChange={(v) => v && updateField('dental_condition', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select condition" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="missing_all_upper">Missing All Upper Teeth</SelectItem>
                    <SelectItem value="missing_all_lower">Missing All Lower Teeth</SelectItem>
                    <SelectItem value="missing_all_both">Missing All Teeth (Both)</SelectItem>
                    <SelectItem value="missing_multiple">Missing Multiple Teeth</SelectItem>
                    <SelectItem value="failing_teeth">Failing/Decaying Teeth</SelectItem>
                    <SelectItem value="denture_problems">Denture Problems</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Condition Details</Label>
                <Textarea
                  value={form.dental_condition_details}
                  onChange={(e) => updateField('dental_condition_details', e.target.value)}
                  rows={2}
                  placeholder="Specific details about the dental condition..."
                />
              </div>

              <div className="space-y-2">
                <Label>Current Dental Situation</Label>
                <Textarea
                  value={form.current_dental_situation}
                  onChange={(e) => updateField('current_dental_situation', e.target.value)}
                  rows={2}
                  placeholder="Describe their current situation..."
                />
              </div>

              <div className="flex items-center justify-between">
                <Label>Has Dentures</Label>
                <Switch
                  checked={form.has_dentures}
                  onCheckedChange={(v) => updateField('has_dentures', v)}
                />
              </div>
            </TabsContent>

            {/* Financial */}
            <TabsContent value="financial" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <Label>Has Dental Insurance</Label>
                <Switch
                  checked={form.has_dental_insurance}
                  onCheckedChange={(v) => updateField('has_dental_insurance', v)}
                />
              </div>

              {form.has_dental_insurance && (
                <div className="space-y-2">
                  <Label>Insurance Provider</Label>
                  <Input
                    value={form.insurance_provider}
                    onChange={(e) => updateField('insurance_provider', e.target.value)}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>Financing Interest</Label>
                <Select
                  value={form.financing_interest}
                  onValueChange={(v) => v && updateField('financing_interest', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select preference" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash_pay">Cash Pay</SelectItem>
                    <SelectItem value="financing_needed">Needs Financing</SelectItem>
                    <SelectItem value="insurance_only">Insurance Only</SelectItem>
                    <SelectItem value="undecided">Undecided</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Budget Range</Label>
                <Select
                  value={form.budget_range}
                  onValueChange={(v) => v && updateField('budget_range', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select range" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="under_10k">Under $10,000</SelectItem>
                    <SelectItem value="10k_15k">$10,000 - $15,000</SelectItem>
                    <SelectItem value="15k_20k">$15,000 - $20,000</SelectItem>
                    <SelectItem value="20k_25k">$20,000 - $25,000</SelectItem>
                    <SelectItem value="25k_30k">$25,000 - $30,000</SelectItem>
                    <SelectItem value="over_30k">Over $30,000</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </TabsContent>

            {/* Source */}
            <TabsContent value="source" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Lead Source</Label>
                <Select
                  value={form.source_type}
                  onValueChange={(v) => v && updateField('source_type', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="How did they find you?" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="google_ads">Google Ads</SelectItem>
                    <SelectItem value="meta_ads">Meta / Facebook Ads</SelectItem>
                    <SelectItem value="website_form">Website Form</SelectItem>
                    <SelectItem value="landing_page">Landing Page</SelectItem>
                    <SelectItem value="referral">Patient Referral</SelectItem>
                    <SelectItem value="walk_in">Walk-In</SelectItem>
                    <SelectItem value="phone">Phone Call</SelectItem>
                    <SelectItem value="email_campaign">Email Campaign</SelectItem>
                    <SelectItem value="sms_campaign">SMS Campaign</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>UTM Source</Label>
                  <Input
                    value={form.utm_source}
                    onChange={(e) => updateField('utm_source', e.target.value)}
                    placeholder="google, facebook, etc."
                  />
                </div>
                <div className="space-y-2">
                  <Label>UTM Campaign</Label>
                  <Input
                    value={form.utm_campaign}
                    onChange={(e) => updateField('utm_campaign', e.target.value)}
                    placeholder="all-on-4-spring-2024"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !form.first_name}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Create Lead
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
