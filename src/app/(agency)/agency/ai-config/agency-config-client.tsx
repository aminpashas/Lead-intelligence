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
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Recommended)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Fast)' },
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
      <Card className="bg-aurea-surface border-aurea-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-aurea-primary" />
            <CardTitle className="text-aurea-ink">AI Agent Persona</CardTitle>
          </div>
          <CardDescription className="text-aurea-ink-3">
            This is the AI personality that all practices share. It represents your brand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-aurea-ink-2">Agent Name</Label>
            <Input
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
              placeholder="e.g. Aria"
              className="bg-aurea-surface-2 border-aurea-border text-aurea-ink placeholder:text-aurea-ink-3 focus:border-aurea-primary"
            />
            <p className="text-xs text-aurea-ink-3">
              The name the AI uses to introduce itself to patients (e.g. &quot;Hi, I&apos;m Aria from…&quot;)
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-aurea-ink-2">Communication Tone</Label>
            <Select value={tone} onValueChange={(v) => v && setTone(v)}>
              <SelectTrigger className="bg-aurea-surface-2 border-aurea-border text-aurea-ink focus:ring-aurea-primary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="aurea bg-aurea-surface border-aurea-border text-aurea-ink-2">
                {TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value} className="hover:bg-aurea-surface-2">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-aurea-ink-2">
              Custom System Prompt Addendum{' '}
              <Badge className="ml-2 text-[10px] bg-aurea-surface-2 text-aurea-ink-3">Optional</Badge>
            </Label>
            <Textarea
              value={promptSuffix}
              onChange={(e) => setPromptSuffix(e.target.value)}
              placeholder="Additional instructions appended to every AI system prompt across all practices…"
              rows={4}
              className="bg-aurea-surface-2 border-aurea-border text-aurea-ink placeholder:text-aurea-ink-3 resize-none focus:border-aurea-primary"
            />
            <p className="text-xs text-aurea-ink-3">
              These instructions are appended to every AI conversation. Use for compliance rules, disclaimers, or universal behavior rules.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* AI Model */}
      <Card className="bg-aurea-surface border-aurea-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-aurea-primary" />
            <CardTitle className="text-aurea-ink">Model Configuration</CardTitle>
          </div>
          <CardDescription className="text-aurea-ink-3">
            Select the Anthropic model used for all AI interactions. This is a platform-wide setting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-aurea-ink-2">Model</Label>
            <Select value={model} onValueChange={(v) => v && setModel(v)}>
              <SelectTrigger className="bg-aurea-surface-2 border-aurea-border text-aurea-ink focus:ring-aurea-primary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="aurea bg-aurea-surface border-aurea-border text-aurea-ink-2">
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="hover:bg-aurea-surface-2">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-aurea-ink-2">Max Tokens per Response</Label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              min={256}
              max={4096}
              className="bg-aurea-surface-2 border-aurea-border text-aurea-ink focus:border-aurea-primary"
            />
            <p className="text-xs text-aurea-ink-3">
              Higher values allow longer AI responses but increase cost. Recommended: 1024.
            </p>
          </div>
        </CardContent>
      </Card>

      <Separator className="bg-aurea-border" />

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="bg-aurea-primary hover:bg-aurea-primary/90 text-white"
        >
          {saving ? (
            'Saving…'
          ) : saved ? (
            <>
              <CheckCircle2 className="mr-2 h-4 w-4 text-aurea-primary" /> Saved
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" /> Save Configuration
            </>
          )}
        </Button>
        <p className="text-xs text-aurea-ink-3">
          Changes take effect on the next AI interaction.
        </p>
      </div>
    </div>
  )
}
