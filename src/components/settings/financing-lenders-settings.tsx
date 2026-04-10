'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { GripVertical, ChevronDown, ChevronUp, Save, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'

type LenderConfig = {
  id: string
  lender_slug: string
  display_name: string
  is_active: boolean
  priority_order: number
  config: Record<string, unknown>
  integration_type: string
  has_credentials: boolean
  info: {
    name: string
    description: string
    integrationType: string
    features: string[]
    credentialFields: Array<{ key: string; label: string; type: string }>
    configFields: Array<{ key: string; label: string; type: string; placeholder?: string }>
  } | null
}

export function FinancingLendersSettings() {
  const [lenders, setLenders] = useState<LenderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({})
  const [configUpdates, setConfigUpdates] = useState<Record<string, Record<string, string>>>({})

  useEffect(() => {
    loadLenders()
  }, [])

  async function loadLenders() {
    try {
      const res = await fetch('/api/financing/lenders')
      if (res.ok) {
        const data = await res.json()
        setLenders(data.lenders || [])
        // Init config state
        const configs: Record<string, Record<string, string>> = {}
        for (const l of data.lenders || []) {
          configs[l.lender_slug] = {}
          if (l.info?.configFields) {
            for (const field of l.info.configFields) {
              configs[l.lender_slug][field.key] = (l.config as Record<string, string>)?.[field.key] || ''
            }
          }
        }
        setConfigUpdates(configs)
      }
    } catch { setError('Failed to load lender settings') }
    finally { setLoading(false) }
  }

  function toggleActive(slug: string) {
    setLenders(prev => prev.map(l => l.lender_slug === slug ? { ...l, is_active: !l.is_active } : l))
  }

  function movePriority(slug: string, direction: 'up' | 'down') {
    setLenders(prev => {
      const sorted = [...prev].sort((a, b) => a.priority_order - b.priority_order)
      const idx = sorted.findIndex(l => l.lender_slug === slug)
      if (direction === 'up' && idx > 0) {
        const temp = sorted[idx - 1].priority_order
        sorted[idx - 1].priority_order = sorted[idx].priority_order
        sorted[idx].priority_order = temp
      }
      if (direction === 'down' && idx < sorted.length - 1) {
        const temp = sorted[idx + 1].priority_order
        sorted[idx + 1].priority_order = sorted[idx].priority_order
        sorted[idx].priority_order = temp
      }
      return sorted.sort((a, b) => a.priority_order - b.priority_order)
    })
  }

  function updateCredential(slug: string, key: string, value: string) {
    setCredentials(prev => ({
      ...prev,
      [slug]: { ...(prev[slug] || {}), [key]: value },
    }))
  }

  function updateConfig(slug: string, key: string, value: string) {
    setConfigUpdates(prev => ({
      ...prev,
      [slug]: { ...(prev[slug] || {}), [key]: value },
    }))
  }

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const payload = {
        lenders: lenders.map((l, i) => ({
          lender_slug: l.lender_slug,
          is_active: l.is_active,
          priority_order: i + 1,
          credentials: credentials[l.lender_slug] && Object.values(credentials[l.lender_slug]).some(v => v)
            ? credentials[l.lender_slug]
            : undefined,
          config: configUpdates[l.lender_slug] || undefined,
        })),
      }

      const res = await fetch('/api/financing/lenders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Save failed')
      }

      setSaved(true)
      setCredentials({}) // Clear credential inputs after save
      await loadLenders()
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          💳 Financing Lenders
        </CardTitle>
        <CardDescription>
          Configure your financing waterfall. Lenders are tried in order — top to bottom. First approval wins.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {lenders.sort((a, b) => a.priority_order - b.priority_order).map((lender, idx) => (
          <div key={lender.lender_slug} className="rounded-lg border">
            {/* Lender header */}
            <div className="flex items-center gap-3 p-3">
              <div className="flex flex-col gap-0.5">
                <button type="button" onClick={() => movePriority(lender.lender_slug, 'up')} disabled={idx === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed">
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => movePriority(lender.lender_slug, 'down')} disabled={idx === lenders.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed">
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-bold">
                {idx + 1}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{lender.info?.name || lender.display_name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {lender.info?.integrationType || lender.integration_type}
                  </Badge>
                  {lender.has_credentials && (
                    <Badge variant="secondary" className="text-[10px]">
                      <CheckCircle2 className="h-3 w-3 mr-0.5" /> Keys Set
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{lender.info?.description}</p>
              </div>

              <Switch
                checked={lender.is_active}
                onCheckedChange={() => toggleActive(lender.lender_slug)}
              />

              <button
                type="button"
                onClick={() => setExpanded(expanded === lender.lender_slug ? null : lender.lender_slug)}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                {expanded === lender.lender_slug ? 'Close' : 'Config'}
              </button>
            </div>

            {/* Expanded config */}
            {expanded === lender.lender_slug && (
              <div className="border-t bg-muted/30 p-4 space-y-4">
                {/* Features */}
                {lender.info?.features && (
                  <div>
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">Features</Label>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {lender.info.features.map((f) => (
                        <Badge key={f} variant="outline" className="text-xs font-normal">{f}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Credential fields */}
                {lender.info?.credentialFields && lender.info.credentialFields.length > 0 && (
                  <div className="space-y-3">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">API Credentials</Label>
                    {lender.info.credentialFields.map((field) => (
                      <div key={field.key} className="space-y-1">
                        <Label className="text-xs">{field.label}</Label>
                        <Input
                          type={field.type === 'password' ? 'password' : 'text'}
                          placeholder={lender.has_credentials ? '••••••••  (saved)' : `Enter ${field.label.toLowerCase()}`}
                          value={credentials[lender.lender_slug]?.[field.key] || ''}
                          onChange={(e) => updateCredential(lender.lender_slug, field.key, e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Config fields */}
                {lender.info?.configFields && lender.info.configFields.length > 0 && (
                  <div className="space-y-3">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">Configuration</Label>
                    {lender.info.configFields.map((field) => (
                      <div key={field.key} className="space-y-1">
                        <Label className="text-xs">{field.label}</Label>
                        <Input
                          type="text"
                          placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
                          value={configUpdates[lender.lender_slug]?.[field.key] || ''}
                          onChange={(e) => updateConfig(lender.lender_slug, field.key, e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <Separator />

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {lenders.filter(l => l.is_active).length} of {lenders.length} lenders active
          </p>
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : saved ? <CheckCircle2 className="h-4 w-4 mr-1.5" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
