import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, Zap, MessageSquare, Target, Shield, TrendingUp, Heart, Eye, Lock } from 'lucide-react'

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
      icon: Heart,
      title: 'Patient Psychology Agent',
      description: 'Analyzes every conversation to build deep patient profiles — personality type, pain points, desires, trust level, negotiation style. Creates personalized follow-ups that build genuine connection.',
      status: 'active',
      isNew: true,
    },
    {
      icon: Eye,
      title: 'Conversation Analyst',
      description: 'Rates every conversation on emotional intelligence, tone, sales pressure, engagement signals, and staff coaching opportunities. Identifies red flags and buying signals in real-time.',
      status: 'active',
      isNew: true,
    },
    {
      icon: Lock,
      title: 'HIPAA Compliance Agent',
      description: 'Monitors all AI operations for HIPAA compliance. Scrubs PHI before AI processing, audits data access, checks response compliance, and maintains full audit trail.',
      status: 'active',
      isNew: true,
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
      description: 'Automatically remove unresponsive leads (14+ days no reply), repeat no-shows, and low-score prospects from the active pipeline. Runs daily.',
      status: 'active',
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
          Powered by Claude &mdash; your AI treatment coordinator with patient psychology, conversation analysis, and HIPAA compliance
        </p>
      </div>

      {/* Agent Architecture Overview */}
      <Card className="mb-6 border-primary/20 bg-primary/5">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-pink-100 dark:bg-pink-900/30 flex items-center justify-center mb-2">
                <Heart className="h-6 w-6 text-pink-600" />
              </div>
              <h3 className="font-semibold text-sm">Sales Psychology Agent</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Builds deep patient profiles with memory. Learns personality, pain points, desires, and creates tailored follow-ups that build genuine connection.
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-2">
                <Eye className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="font-semibold text-sm">Conversation Analyst</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Rates tone, emotion, sales pressure, and engagement. Coaches staff with specific feedback. Flags red flags and buying signals.
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-2">
                <Lock className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="font-semibold text-sm">HIPAA Compliance</h3>
              <p className="text-xs text-muted-foreground mt-1">
                PHI detection and scrubbing before AI processing. Audit logging. Response compliance checking. Full data access trail.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {features.map((feature) => (
          <Card key={feature.title} className={feature.isNew ? 'border-primary/30' : ''}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <feature.icon className="h-8 w-8 text-primary" />
                <div className="flex items-center gap-2">
                  {feature.isNew && (
                    <Badge variant="outline" className="border-primary text-primary text-xs">
                      New
                    </Badge>
                  )}
                  <Badge variant={feature.status === 'active' ? 'default' : 'secondary'}>
                    {feature.status === 'active' ? 'Active' : 'Coming Soon'}
                  </Badge>
                </div>
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
