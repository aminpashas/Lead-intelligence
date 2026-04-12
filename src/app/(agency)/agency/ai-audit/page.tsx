import { createClient } from '@/lib/supabase/server'
import { Shield, Star, ThumbsUp, ThumbsDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata = {
  title: 'AI Audit | Agency | Lead Intelligence',
}

export default async function AgencyAiAuditPage() {
  const supabase = await createClient()

  const { data: ratings } = await supabase
    .from('ai_audit_ratings')
    .select(`
      id, rating, feedback, created_at, organization_id,
      organizations(name),
      messages(content, role)
    `)
    .order('created_at', { ascending: false })
    .limit(30)

  const positiveCount = ratings?.filter((r) => r.rating === 'positive').length ?? 0
  const negativeCount = ratings?.filter((r) => r.rating === 'negative').length ?? 0
  const total = ratings?.length ?? 0
  const score = total > 0 ? Math.round((positiveCount / total) * 100) : null

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">AI Audit</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Quality ratings and feedback on AI responses across all practices.
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Overall Score</p>
                <p className="text-3xl font-bold text-white">
                  {score !== null ? `${score}%` : '—'}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">positive ratings</p>
              </div>
              <Star className="h-8 w-8 text-amber-400/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Positive</p>
                <p className="text-3xl font-bold text-emerald-400">{positiveCount}</p>
                <p className="text-xs text-slate-500 mt-0.5">of {total} rated</p>
              </div>
              <ThumbsUp className="h-8 w-8 text-emerald-400/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-500 mb-1">Needs Improvement</p>
                <p className="text-3xl font-bold text-red-400">{negativeCount}</p>
                <p className="text-xs text-slate-500 mt-0.5">of {total} rated</p>
              </div>
              <ThumbsDown className="h-8 w-8 text-red-400/30" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Audit Feed */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-base">Recent Audit Events</CardTitle>
          <CardDescription className="text-slate-500 text-xs">
            Staff ratings of AI message quality across all practices
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ratings && ratings.length > 0 ? (
            ratings.map((r) => {
              const org = r.organizations as unknown as { name: string } | null
              return (
                <div
                  key={r.id}
                  className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      {org?.name ?? 'Unknown'}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={`text-[10px] h-4 px-1.5 ${
                          r.rating === 'positive'
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20'
                            : 'bg-red-500/20 text-red-300 border-red-500/20'
                        }`}
                      >
                        {r.rating}
                      </Badge>
                      <span className="text-[10px] text-slate-500">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  {r.feedback && (
                    <p className="text-xs text-slate-400 italic">&quot;{r.feedback}&quot;</p>
                  )}
                </div>
              )
            })
          ) : (
            <p className="text-sm text-slate-500 py-4 text-center">
              No audit ratings yet. Staff can rate AI responses from the conversation view.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
