'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Brain, Sparkles, Save, CheckCircle2 } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'

const MODELS = [
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Recommended)' },
  { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Fast)' },
  { value: 'claude-opus-4-5', label: 'Claude Opus (Most Powerful)' },
]

const TONES = [
  { value: 'warm', label: 'Warm & Caring' },
  { value: 'professional', label: 'Professional & Formal' },
  { value: 'consultative', label: 'Consultative & Educational' },
  { value: 'friendly', label: 'Friendly & Casual' },
]

interface AgencyConfigClientProps {
  initialPersona: {
    name: string
    tone: string
    systemPromptSuffix?: string
  }
  initialModel: {
    model: string
    max_tokens: number
  }
}

export function AgencyConfigClient({ initialPersona, initialModel }: AgencyConfigClientProps) {
  const supabase = createClient()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [personaName, setPersonaName] = useState(initialPersona.name)
  const [tone, setTone] = useState(initialPersona.tone)
  const [promptSuffix, setPromptSuffix] = useState(initialPersona.systemPromptSuffix ?? '')
  const [model, setModel] = useState(initialModel.model)
  const [maxTokens, setMaxTokens] = useState(String(initialModel.max_tokens))

  async function handleSave() {
    setSaving(true)

    const updates = [
      {
        key: 'ai_persona',
        value: { name: personaName, tone, systemPromptSuffix: promptSuffix },
        description: 'AI agent persona configuration',
      },
      {
        key: 'ai_model',
        value: { provider: 'anthropic', model, max_tokens: parseInt(maxTokens) },
        description: 'AI model selection',
      },
    ]

    for (const update of updates) {
      await supabase
        .from('agency_settings')
        .upsert({ key: update.key, value: update.value, description: update.description })
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* AI Persona */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" />
            <CardTitle className="text-white">AI Agent Persona</CardTitle>
          </div>
          <CardDescription className="text-slate-500">
            This is the AI personality that all practices share. It represents your brand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-slate-300">Agent Name</Label>
            <Input
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
              placeholder="e.g. Aria"
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-violet-500"
            />
            <p className="text-xs text-slate-500">
              The name the AI uses to introduce itself to patients (e.g. &quot;Hi, I&apos;m Aria from…&quot;)
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-slate-300">Communication Tone</Label>
            <Select value={tone} onValueChange={(v) => v && setTone(v)}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white focus:ring-violet-500">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700 text-slate-200">
                {TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value} className="hover:bg-slate-800">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-slate-300">
              Custom System Prompt Addendum{' '}
              <Badge className="ml-2 text-[10px] bg-slate-700 text-slate-400">Optional</Badge>
            </Label>
            <Textarea
              value={promptSuffix}
              onChange={(e) => setPromptSuffix(e.target.value)}
              placeholder="Additional instructions appended to every AI system prompt across all practices…"
              rows={4}
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 resize-none focus:border-violet-500"
            />
            <p className="text-xs text-slate-500">
              These instructions are appended to every AI conversation. Use for compliance rules, disclaimers, or universal behavior rules.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* AI Model */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-violet-400" />
            <CardTitle className="text-white">Model Configuration</CardTitle>
          </div>
          <CardDescription className="text-slate-500">
            Select the Anthropic model used for all AI interactions. This is a platform-wide setting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-slate-300">Model</Label>
            <Select value={model} onValueChange={(v) => v && setModel(v)}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white focus:ring-violet-500">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700 text-slate-200">
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="hover:bg-slate-800">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-slate-300">Max Tokens per Response</Label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              min={256}
              max={4096}
              className="bg-slate-800 border-slate-700 text-white focus:border-violet-500"
            />
            <p className="text-xs text-slate-500">
              Higher values allow longer AI responses but increase cost. Recommended: 1024.
            </p>
          </div>
        </CardContent>
      </Card>

      <Separator className="bg-slate-800" />

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="bg-violet-600 hover:bg-violet-700 text-white"
        >
          {saving ? (
            'Saving…'
          ) : saved ? (
            <>
              <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-300" /> Saved
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" /> Save Configuration
            </>
          )}
        </Button>
        <p className="text-xs text-slate-500">
          Changes take effect on the next AI interaction.
        </p>
      </div>
    </div>
  )
}
