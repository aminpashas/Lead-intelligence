import { createClient } from '@/lib/supabase/server'
import { FlaskConical, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { LearnedRulesList } from './rules-client'
import type { AgencyAiRule, LearningRun } from '@/types/database'

export const metadata = {
  title: 'AI Learning | Agency | Lead Intelligence',
}

// The human gate of the outcome learning loop. The weekly distillation cron
// contrasts won vs lost journeys and writes candidate rules; nothing goes live
// until it is approved here.
export default async function AgencyAiLearningPage() {
  const supabase = await createClient()

  const [{ data: rulesRaw }, { data: runsRaw }] = await Promise.all([
    supabase
      .from('agency_ai_rules')
      .select('*')
      .eq('source', 'auto_learning')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('learning_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  const rules = (rulesRaw || []) as AgencyAiRule[]
  const lastRun = ((runsRaw || []) as LearningRun[])[0] || null

  const pending = rules.filter((r) => r.review_status === 'pending')
  const live = rules.filter((r) => r.is_enabled)
  const flagged = rules.filter((r) => r.review_status === 'retire_flagged')

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical className="h-5 w-5 text-aurea-primary" />
          <h1 className="text-2xl font-bold text-aurea-ink">AI Learning</h1>
        </div>
        <p className="text-aurea-ink-2 text-sm">
          Rules the engine learned from real outcomes (booked, showed, closed). Candidates are
          statistically verified in code, written by AI, and go live only after your approval.
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Awaiting Review</p>
                <p className="text-3xl font-bold text-aurea-ink">{pending.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">candidate rules</p>
              </div>
              <Sparkles className="h-8 w-8 text-aurea-amber/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Live Learned Rules</p>
                <p className="text-3xl font-bold text-aurea-primary">{live.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">in every practice&apos;s prompt</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-aurea-primary/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Flagged for Retirement</p>
                <p className="text-3xl font-bold text-aurea-rose">{flagged.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">underperforming cohorts</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-aurea-rose/30" />
            </div>
          </CardContent>
        </Card>
      </div>

      {lastRun && (
        <p className="text-xs text-aurea-ink-3">
          Last distillation: {new Date(lastRun.created_at).toLocaleString()} —{' '}
          {lastRun.error
            ? `failed (${lastRun.error})`
            : `${lastRun.episode_count} episodes, ${lastRun.candidates_created} candidates, ${lastRun.rules_flagged} flagged`}
        </p>
      )}

      <LearnedRulesList rules={rules} />
    </div>
  )
}
