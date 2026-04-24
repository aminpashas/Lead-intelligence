'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
    return <div className="p-6 flex items-center justify-center min-h-[60vh]"><Loader2 className="h-5 w-5 animate-spin" /></div>
  }
  if (!tpl) return <div className="p-6 text-sm text-slate-500">Not found.</div>

  const editable = tpl.status === 'draft'

  const updateSection = (idx: number, updates: Partial<ContractTemplateSection>) => {
    const sections = tpl.sections.map((s, i) => (i === idx ? { ...s, ...updates } : s))
    setTpl({ ...tpl, sections })
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{tpl.name}</h1>
          <div className="text-xs text-slate-500 mt-1">
            {tpl.slug} • v{tpl.version} • <Badge variant="outline">{tpl.status}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          {editable && (
            <>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save draft
              </Button>
              <Button size="sm" variant="default" onClick={publish} disabled={publishing}>
                {publishing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Publish
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Template metadata</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>Name</Label>
            <Input
              value={tpl.name}
              onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
              disabled={!editable}
            />
          </div>
          <div>
            <Label>Slug (read-only)</Label>
            <Input value={tpl.slug} disabled />
          </div>
        </CardContent>
      </Card>

      <Separator />

      {tpl.sections.map((s, idx) => (
        <Card key={s.id}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {s.title}
              <Badge variant="outline" className="text-xs">{s.kind}</Badge>
              {s.consent_key && (
                <Badge variant="outline" className="text-xs">consent:{s.consent_key}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(s.kind === 'boilerplate' || s.kind === 'consent' || s.kind === 'signature') && (
              <div>
                <Label className="text-xs">Body (may include {'{{'}variable{'}}'}  tokens)</Label>
                <Textarea
                  value={s.body ?? ''}
                  rows={6}
                  onChange={(e) => updateSection(idx, { body: e.target.value })}
                  disabled={!editable}
                />
              </div>
            )}
            {s.kind === 'ai_narrative' && (
              <>
                <div>
                  <Label className="text-xs">AI instruction</Label>
                  <Textarea
                    value={s.ai_prompt ?? ''}
                    rows={4}
                    onChange={(e) => updateSection(idx, { ai_prompt: e.target.value })}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label className="text-xs">Max words</Label>
                  <Input
                    type="number"
                    value={s.max_ai_words ?? 200}
                    onChange={(e) => updateSection(idx, { max_ai_words: Number(e.target.value) })}
                    disabled={!editable}
                  />
                </div>
              </>
            )}
            {s.kind === 'data_table' && (
              <div className="text-xs text-slate-500">
                Renders from server-side data ({s.data_source ?? '—'}). No body editing.
              </div>
            )}
          </CardContent>
        </Card>
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
