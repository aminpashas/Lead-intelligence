import { createClient } from '@/lib/supabase/server'
import { Brain } from 'lucide-react'
import { AgencyConfigClient } from './agency-config-client'

export const metadata = {
  title: 'AI Configuration | Agency | Lead Intelligence',
}

export default async function AgencyAiConfigPage() {
  const supabase = await createClient()

  const { data: settings } = await supabase
    .from('agency_settings')
    .select('key, value')
    .in('key', ['ai_persona', 'ai_model'])

  const personaRaw = settings?.find((s) => s.key === 'ai_persona')?.value as Record<string, string> | undefined
  const modelRaw = settings?.find((s) => s.key === 'ai_model')?.value as Record<string, string | number> | undefined

  const initialPersona = {
    name: personaRaw?.name ?? 'Aria',
    tone: personaRaw?.tone ?? 'warm',
    systemPromptSuffix: personaRaw?.systemPromptSuffix ?? '',
  }

  const initialModel = {
    model: String(modelRaw?.model ?? 'claude-3-5-sonnet-20241022'),
    max_tokens: Number(modelRaw?.max_tokens ?? 1024),
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Brain className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">AI Configuration</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Platform-wide AI settings. These apply to all practices and are your intellectual property.
        </p>
      </div>

      <AgencyConfigClient
        initialPersona={initialPersona}
        initialModel={initialModel}
      />
    </div>
  )
}
