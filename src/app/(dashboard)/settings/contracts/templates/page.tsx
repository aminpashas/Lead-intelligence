'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import { Loader2, FileText } from 'lucide-react'
import { toast } from 'sonner'

type TemplateRow = {
  id: string
  name: string
  slug: string
  version: number
  status: string
  sections: Array<{ id: string; title: string; kind: string }>
  updated_at: string
}

const TEMPLATE_STATUS_STYLES: Record<string, string> = {
  published: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  draft: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  archived: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

function TemplatesContent() {
  const [rows, setRows] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/contract-templates')
    const data = res.ok ? await res.json() : { templates: [] }
    setRows(data.templates ?? [])
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  const createDraftFrom = async (row: TemplateRow) => {
    const res = await fetch('/api/contract-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: row.slug,
        name: row.name,
        sections: row.sections,
      }),
    })
    if (res.ok) {
      toast.success('New draft created')
      await load()
    } else {
      toast.error('Failed to create draft')
    }
  }

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Settings / Contracts</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px] flex items-center gap-3">
          <FileText className="h-9 w-9 text-aurea-ink-3" strokeWidth={1.75} />
          Contract Templates
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Edit the narrative prompts, boilerplate, and consents that drive every AI-drafted contract.
        </p>
      </header>

      {/* ── Templates list ─────────────────────────────────── */}
      <section className="mt-8 aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Templates</h2>
        </div>
        <div className="px-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-aurea-ink-3">No templates yet.</p>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                className="-mx-5 flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-3.5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-aurea-ink">{r.name}</p>
                  <p className="font-mono text-[11px] text-aurea-ink-3">
                    {r.slug} &middot; v{r.version} &middot; {r.sections.length} sections
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${TEMPLATE_STATUS_STYLES[r.status] ?? 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'}`}>
                    {r.status}
                  </span>
                  <Link href={`/settings/contracts/templates/${r.id}`}>
                    <Button size="sm" variant="outline">Open</Button>
                  </Link>
                  {r.status === 'published' && (
                    <Button size="sm" variant="outline" onClick={() => createDraftFrom(r)}>
                      New version
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export default function TemplatesPage() {
  return (
    <RoleGuard requiredPermission="contract_templates:manage">
      <TemplatesContent />
    </RoleGuard>
  )
}
