'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  UserPlus,
  AlertTriangle,
  PhoneOff,
  Target,
  RotateCcw,
  Sparkles,
  Pencil,
} from 'lucide-react'
import type { RolePlayScenario, RolePlayRole, RolePlayAgentTarget, AIRolePlaySession } from '@/types/database'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  new_patient: <UserPlus className="h-5 w-5" />,
  objection: <AlertTriangle className="h-5 w-5" />,
  follow_up: <RotateCcw className="h-5 w-5" />,
  closing: <Target className="h-5 w-5" />,
  re_engagement: <PhoneOff className="h-5 w-5" />,
  custom: <Pencil className="h-5 w-5" />,
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  hard: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

const AGENT_LABELS: Record<RolePlayAgentTarget, string> = {
  setter: 'Setter Agent',
  closer: 'Closer Agent',
}

type ScenarioPickerProps = {
  onStart: (config: {
    title: string
    user_role: RolePlayRole
    agent_target: RolePlayAgentTarget
    scenario_id: string | null
    scenario_description: string | null
    patient_persona: AIRolePlaySession['patient_persona'] | null
  }) => void
}

export function RolePlayScenarioPicker({ onStart }: ScenarioPickerProps) {
  const [scenarios, setScenarios] = useState<RolePlayScenario[]>([])
  const [userRole, setUserRole] = useState<RolePlayRole>('treatment_coordinator')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [customDialogOpen, setCustomDialogOpen] = useState(false)

  // Custom scenario form state
  const [customName, setCustomName] = useState('')
  const [customDescription, setCustomDescription] = useState('')
  const [customAgentTarget, setCustomAgentTarget] = useState<RolePlayAgentTarget>('setter')
  const [customPatientName, setCustomPatientName] = useState('')
  const [customPersonality, setCustomPersonality] = useState('friendly')
  const [customCondition, setCustomCondition] = useState('')
  const [customEmotional, setCustomEmotional] = useState('curious')
  const [customObjections, setCustomObjections] = useState('')
  const [customBudget, setCustomBudget] = useState('')
  const [customNotes, setCustomNotes] = useState('')

  useEffect(() => {
    async function fetchScenarios() {
      try {
        const res = await fetch('/api/ai/training/roleplay/scenarios')
        const data = await res.json()
        setScenarios(data.scenarios || [])
      } catch {
        // Silently fail — built-in scenarios will show as empty
      }
    }
    fetchScenarios()
  }, [])

  const filteredScenarios = scenarios.filter(
    (s) => agentFilter === 'all' || s.agent_target === agentFilter
  )

  function handleSelectScenario(scenario: RolePlayScenario) {
    onStart({
      title: `${scenario.name} — ${userRole === 'patient' ? 'As Patient' : 'As TC'}`,
      user_role: userRole,
      agent_target: scenario.agent_target,
      scenario_id: scenario.id,
      scenario_description: scenario.description,
      patient_persona: scenario.patient_persona,
    })
  }

  function handleCustomStart() {
    const persona = {
      name: customPatientName || 'Patient',
      personality_type: customPersonality,
      dental_condition: customCondition || 'Considering dental implants',
      emotional_state: customEmotional,
      objections: customObjections.split('\n').filter(Boolean),
      budget_concern: customBudget || 'Wants to understand costs',
      custom_notes: customNotes,
    }

    onStart({
      title: customName || `Custom Session — ${userRole === 'patient' ? 'As Patient' : 'As TC'}`,
      user_role: userRole,
      agent_target: customAgentTarget,
      scenario_id: null,
      scenario_description: customDescription || null,
      patient_persona: persona,
    })
    setCustomDialogOpen(false)
  }

  return (
    <div className="space-y-6">
      {/* Role Selector */}
      <div className="text-center space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Choose Your Role</h3>
          <p className="text-sm text-muted-foreground">
            Pick who you want to play — the AI will play the other role
          </p>
        </div>
        <div className="flex justify-center gap-3">
          <Button
            variant={userRole === 'treatment_coordinator' ? 'default' : 'outline'}
            size="lg"
            className="gap-2 min-w-[200px]"
            onClick={() => setUserRole('treatment_coordinator')}
          >
            <span className="text-lg">💼</span>
            I&apos;m the TC
          </Button>
          <Button
            variant={userRole === 'patient' ? 'default' : 'outline'}
            size="lg"
            className="gap-2 min-w-[200px]"
            onClick={() => setUserRole('patient')}
          >
            <span className="text-lg">🧑</span>
            I&apos;m the Patient
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {userRole === 'treatment_coordinator'
            ? '→ You practice your sales & communication skills. AI plays a realistic patient.'
            : '→ You test the AI agent by acting as a patient. Teach it your preferred responses.'}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Choose a Scenario</h3>
        <div className="flex items-center gap-2">
          <Select value={agentFilter} onValueChange={(v) => v && setAgentFilter(v)}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <SelectValue>
                {agentFilter === 'all' ? 'All Agents' : AGENT_LABELS[agentFilter as RolePlayAgentTarget]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              <SelectItem value="setter">Setter Agent</SelectItem>
              <SelectItem value="closer">Closer Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Scenario Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredScenarios.map((scenario) => (
          <Card
            key={scenario.id}
            className="cursor-pointer hover:border-primary/50 hover:shadow-md transition-all duration-200 group"
            onClick={() => handleSelectScenario(scenario)}
          >
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors">
                    {CATEGORY_ICONS[scenario.category] || <Sparkles className="h-5 w-5" />}
                  </div>
                  <div>
                    <h4 className="font-medium text-sm leading-tight">{scenario.name}</h4>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="secondary" className="text-[10px] px-1.5 h-4">
                        {AGENT_LABELS[scenario.agent_target]}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 h-4 ${DIFFICULTY_COLORS[scenario.difficulty]}`}
                      >
                        {scenario.difficulty}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{scenario.description}</p>
              {scenario.patient_persona && (
                <div className="text-xs text-muted-foreground/80 flex items-center gap-1.5">
                  <span className="font-medium">{scenario.patient_persona.name}</span>
                  <span>·</span>
                  <span>{scenario.patient_persona.personality_type}</span>
                  <span>·</span>
                  <span>{scenario.patient_persona.emotional_state}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {/* Custom Scenario Card */}
        <Card
          className="cursor-pointer border-dashed border-2 hover:border-primary/50 hover:shadow-md transition-all group"
          onClick={() => setCustomDialogOpen(true)}
        >
          <CardContent className="p-4 flex flex-col items-center justify-center h-full min-h-[140px] text-center">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-2 group-hover:bg-primary/20 transition-colors">
              <Pencil className="h-5 w-5" />
            </div>
            <h4 className="font-medium text-sm">Custom Scenario</h4>
            <p className="text-xs text-muted-foreground mt-1">
              Create your own patient persona and situation
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Custom Scenario Dialog */}
      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Custom Role Play Scenario</DialogTitle>
            <DialogDescription>
              Design a specific patient persona and situation to practice with.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Session Name</Label>
                <Input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g., Tough price negotiation"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Agent to Train</Label>
                <Select value={customAgentTarget} onValueChange={(v) => v && setCustomAgentTarget(v as RolePlayAgentTarget)}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="setter">Setter Agent</SelectItem>
                    <SelectItem value="closer">Closer Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Scenario Description</Label>
              <Textarea
                value={customDescription}
                onChange={(e) => setCustomDescription(e.target.value)}
                placeholder="Describe the situation..."
                rows={2}
                className="text-sm resize-none"
              />
            </div>

            <hr className="my-2" />
            <p className="text-xs font-medium text-muted-foreground">Patient Persona</p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Patient Name</Label>
                <Input
                  value={customPatientName}
                  onChange={(e) => setCustomPatientName(e.target.value)}
                  placeholder="Sarah"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Personality</Label>
                <Select value={customPersonality} onValueChange={(v) => v && setCustomPersonality(v)}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="analytical">Analytical (data-driven)</SelectItem>
                    <SelectItem value="driver">Driver (direct, results)</SelectItem>
                    <SelectItem value="expressive">Expressive (emotional)</SelectItem>
                    <SelectItem value="amiable">Amiable (warm, avoidant)</SelectItem>
                    <SelectItem value="friendly">Friendly (open)</SelectItem>
                    <SelectItem value="skeptical">Skeptical (distrusting)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Dental Condition</Label>
                <Input
                  value={customCondition}
                  onChange={(e) => setCustomCondition(e.target.value)}
                  placeholder="Missing upper teeth"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Emotional State</Label>
                <Select value={customEmotional} onValueChange={(v) => v && setCustomEmotional(v)}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="curious">Curious</SelectItem>
                    <SelectItem value="anxious">Anxious</SelectItem>
                    <SelectItem value="frustrated">Frustrated</SelectItem>
                    <SelectItem value="excited">Excited</SelectItem>
                    <SelectItem value="skeptical">Skeptical</SelectItem>
                    <SelectItem value="desperate">Desperate</SelectItem>
                    <SelectItem value="indifferent">Indifferent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Objections (one per line)</Label>
              <Textarea
                value={customObjections}
                onChange={(e) => setCustomObjections(e.target.value)}
                placeholder={"It's too expensive\nI'm scared of surgery\nI need to ask my spouse"}
                rows={3}
                className="text-sm resize-none"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Budget Concern</Label>
              <Input
                value={customBudget}
                onChange={(e) => setCustomBudget(e.target.value)}
                placeholder="On a tight budget, interested in financing"
                className="text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Additional Notes</Label>
              <Textarea
                value={customNotes}
                onChange={(e) => setCustomNotes(e.target.value)}
                placeholder="Any additional backstory or context..."
                rows={2}
                className="text-sm resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCustomStart}>
              <Sparkles className="h-4 w-4 mr-1" />
              Start Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
