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
      description: 'Statistical predictions for conversion probability, optimal contact times, no-show risk, and revenue forecasting — powered by your historical data.',
      status: 'active',
      isNew: true,
    },
  ]

  const agents = [
    {
      icon: Heart,
      title: 'Sales Psychology Agent',
      description: 'Builds deep patient profiles with memory. Learns personality, pain points, desires, and creates tailored follow-ups that build genuine connection.',
    },
    {
      icon: Eye,
      title: 'Conversation Analyst',
      description: 'Rates tone, emotion, sales pressure, and engagement. Coaches staff with specific feedback. Flags red flags and buying signals.',
    },
    {
      icon: Lock,
      title: 'HIPAA Compliance',
      description: 'PHI detection and scrubbing before AI processing. Audit logging. Response compliance checking. Full data access trail.',
    },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Powered by Claude</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">AI Engine</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Your AI treatment coordinator with patient psychology, conversation analysis, and HIPAA compliance.
        </p>
      </header>

      {/* ── Agent Architecture ─────────────────────────────── */}
      <section className="mt-10">
        <p className="aurea-eyebrow mb-5">Agent Architecture</p>
        <div className="aurea-card overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-aurea-border">
            {agents.map((agent) => (
              <div key={agent.title} className="flex flex-col items-center p-7 text-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-aurea-surface-2 ring-1 ring-aurea-border">
                  <agent.icon className="h-[18px] w-[18px] text-aurea-primary" strokeWidth={1.75} />
                </div>
                <div>
                  <h3 className="aurea-display text-[16px] text-aurea-ink">{agent.title}</h3>
                  <p className="mt-2 text-[12px] leading-relaxed text-aurea-ink-3">{agent.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Feature Grid ───────────────────────────────────── */}
      <section className="mt-10">
        <p className="aurea-eyebrow mb-5">Capabilities</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className={`aurea-card p-5 ${feature.isNew ? 'ring-1 ring-aurea-primary/20' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2">
                  <feature.icon className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
                </div>
                <div className="flex items-center gap-1.5">
                  {feature.isNew && (
                    <span className="inline-flex items-center rounded-md border border-aurea-primary/30 bg-aurea-primary/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-aurea-primary">
                      New
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
                    <span className="text-aurea-primary">Active</span>
                  </span>
                </div>
              </div>
              <h2 className="aurea-display text-[17px] text-aurea-ink mt-4">{feature.title}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-aurea-ink-2">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
