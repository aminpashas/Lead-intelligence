'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6" /> Contract Templates
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Edit the narrative prompts, boilerplate, and consents that drive every AI-drafted contract.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Templates</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-500" /></div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-slate-500">No templates yet.</div>
          ) : (
            <div className="divide-y">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-slate-500">
                      {r.slug} • v{r.version} • {r.sections.length} sections
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{r.status}</Badge>
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
              ))}
            </div>
          )}
        </CardContent>
      </Card>
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
