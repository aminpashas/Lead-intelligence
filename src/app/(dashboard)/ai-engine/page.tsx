import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, Zap, MessageSquare, Target, Shield, TrendingUp } from 'lucide-react'

export default function AIEnginePage() {
  const features = [
    {
      icon: Target,
      title: 'Lead Scoring',
      description: 'AI evaluates leads across 6 dimensions: dental condition, financial readiness, urgency, engagement, demographics, and source quality.',
      status: 'active',
    },
    {
      icon: MessageSquare,
      title: 'AI Conversations',
      description: 'Automated SMS and email responses that educate leads about All-on-4 implants, handle objections, and guide toward consultations.',
      status: 'active',
    },
    {
      icon: Brain,
      title: 'Smart Qualification',
      description: 'Automatically categorize leads as Hot, Warm, Cold, or Unqualified based on AI scoring to prioritize your team\'s time.',
      status: 'active',
    },
    {
      icon: Shield,
      title: 'Auto-Disqualification',
      description: 'Automatically remove unresponsive leads, no-shows, and poor-fit prospects from active pipeline.',
      status: 'coming_soon',
    },
    {
      icon: Zap,
      title: 'Objection Handling',
      description: 'AI detects and addresses common concerns: cost, pain, recovery time, and dental anxiety with empathetic, factual responses.',
      status: 'active',
    },
    {
      icon: TrendingUp,
      title: 'Predictive Analytics',
      description: 'ML-powered predictions for conversion probability, optimal contact times, and campaign performance.',
      status: 'coming_soon',
    },
  ]

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">AI Engine</h1>
        <p className="text-muted-foreground">
          Powered by Claude &mdash; your AI treatment coordinator
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {features.map((feature) => (
          <Card key={feature.title}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <feature.icon className="h-8 w-8 text-primary" />
                <Badge variant={feature.status === 'active' ? 'default' : 'secondary'}>
                  {feature.status === 'active' ? 'Active' : 'Coming Soon'}
                </Badge>
              </div>
              <CardTitle className="text-lg mt-3">{feature.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
