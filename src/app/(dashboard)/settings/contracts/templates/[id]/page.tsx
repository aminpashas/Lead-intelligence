'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { ContractTemplateSection } from '@/types/database'

type TemplateData = {
  id: string
  name: string
  slug: string
  version: number
  status: string
  sections: ContractTemplateSection[]
  required_variables: string[]
}

const TEMPLATE_STATUS_STYLES: Record<string, string> = {
  published: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  draft: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  archived: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

function TemplateEditorContent({ id }: { id: string }) {
  const router = useRouter()
  const [tpl, setTpl] = useState<TemplateData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/contract-templates/${id}`)
      if (res.ok) setTpl((await res.json()).template)
      setLoading(false)
    })()
  }, [id])

  const save = async () => {
    if (!tpl) return
    setSaving(true)
    const res = await fetch(`/api/contract-templates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tpl.name,
        sections: tpl.sections,
        required_variables: tpl.required_variables,
      }),
    })
    setSaving(false)
    if (res.ok) toast.success('Template saved')
    else toast.error('Save failed')
  }

  const publish = async () => {
    setPublishing(true)
    const res = await fetch(`/api/contract-templates/${id}/publish`, { method: 'POST' })
    setPublishing(false)
    if (res.ok) {
      toast.success('Template published')
      router.push('/settings/contracts/templates')
    } else {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Publish failed')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
      </div>
    )
  }
  if (!tpl) return <div className="text-[13px] text-aurea-ink-3">Not found.</div>

  const editable = tpl.status === 'draft'

  const updateSection = (idx: number, updates: Partial<ContractTemplateSection>) => {
    const sections = tpl.sections.map((s, i) => (i === idx ? { ...s, ...updates } : s))
    setTpl({ ...tpl, sections })
  }

  return (
    <div className="animate-in fade-in-0 duration-500 max-w-4xl space-y-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">Settings / Contract Templates</p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="aurea-display text-[32px] text-aurea-ink">{tpl.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] text-aurea-ink-3">{tpl.slug}</span>
              <span className="text-aurea-ink-3">&middot;</span>
              <span className="font-mono text-[12px] text-aurea-ink-3">v{tpl.version}</span>
              <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${TEMPLATE_STATUS_STYLES[tpl.status] ?? 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'}`}>
                {tpl.status}
              </span>
            </div>
          </div>
          {editable && (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save draft
              </Button>
              <Button size="sm" variant="default" onClick={publish} disabled={publishing}>
                {publishing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Publish
              </Button>
            </div>
          )}
        </div>
      </header>

      {/* ── Template metadata ──────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[18px] text-aurea-ink">Template metadata</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-2">
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Name</Label>
            <Input
              value={tpl.name}
              onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
              disabled={!editable}
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Slug (read-only)</Label>
            <Input value={tpl.slug} disabled className="mt-1 font-mono" />
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Sections ───────────────────────────────────────── */}
      {tpl.sections.map((s, idx) => (
        <section key={s.id} className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink flex-1">{s.title}</h2>
            <span className="inline-flex items-center rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-aurea-ink-3">
              {s.kind}
            </span>
            {s.consent_key && (
              <span className="inline-flex items-center rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-aurea-ink-3">
                consent:{s.consent_key}
              </span>
            )}
          </div>
          <div className="space-y-3 px-5 py-4">
            {(s.kind === 'boilerplate' || s.kind === 'consent' || s.kind === 'signature') && (
              <div>
                <Label className="text-[12px] text-aurea-ink-3">
                  Body (may include {'{{'}{'}}'} tokens)
                </Label>
                <Textarea
                  value={s.body ?? ''}
                  rows={6}
                  onChange={(e) => updateSection(idx, { body: e.target.value })}
                  disabled={!editable}
                  className="mt-1 text-[13px]"
                />
              </div>
            )}
            {s.kind === 'ai_narrative' && (
              <>
                <div>
                  <Label className="text-[12px] text-aurea-ink-3">AI instruction</Label>
                  <Textarea
                    value={s.ai_prompt ?? ''}
                    rows={4}
                    onChange={(e) => updateSection(idx, { ai_prompt: e.target.value })}
                    disabled={!editable}
                    className="mt-1 text-[13px]"
                  />
                </div>
                <div>
                  <Label className="text-[12px] text-aurea-ink-3">Max words</Label>
                  <Input
                    type="number"
                    value={s.max_ai_words ?? 200}
                    onChange={(e) => updateSection(idx, { max_ai_words: Number(e.target.value) })}
                    disabled={!editable}
                    className="mt-1 w-32 font-mono"
                  />
                </div>
              </>
            )}
            {s.kind === 'data_table' && (
              <p className="text-[12px] text-aurea-ink-3">
                Renders from server-side data ({s.data_source ?? '—'}). No body editing.
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function TemplateEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <RoleGuard requiredPermission="contract_templates:manage">
      <TemplateEditorContent id={id} />
    </RoleGuard>
  )
}
