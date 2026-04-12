import { GraduationCap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata = {
  title: 'AI Training | Agency | Lead Intelligence',
}

// Lazy import of existing AI training component — it lives at the practice level
// but we surface it here in the agency so it's accessible from the agency panel.
import { createClient } from '@/lib/supabase/server'

export default async function AgencyAiTrainingPage() {
  const supabase = await createClient()

  // Fetch training sessions and roleplay data for all practices
  const { data: sessions } = await supabase
    .from('ai_training_examples')
    .select('id, scenario_type, created_at, organization_id, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(50)

  const { data: roleplaySessions } = await supabase
    .from('roleplay_sessions')
    .select('id, scenario_title, status, created_at, organization_id, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(20)

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <GraduationCap className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">AI Training</h1>
        </div>
        <p className="text-slate-400 text-sm">
          All AI training data, roleplay sessions, and example libraries across practices.
          This is agency IP — only you can see and manage this.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Training Examples */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle className="text-white text-base">Training Examples</CardTitle>
            <CardDescription className="text-slate-500 text-xs">
              {sessions?.length ?? 0} examples across all practices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions && sessions.length > 0 ? (
              sessions.slice(0, 8).map((session) => {
                const org = session.organizations as unknown as { name: string } | null
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0"
                  >
                    <div>
                      <p className="text-xs font-medium text-slate-300 capitalize">
                        {session.scenario_type?.replace(/_/g, ' ') ?? 'General'}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {org?.name ?? 'Unknown practice'}
                      </p>
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {new Date(session.created_at).toLocaleDateString()}
                    </span>
                  </div>
                )
              })
            ) : (
              <p className="text-sm text-slate-500 py-4 text-center">No training examples yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Roleplay Sessions */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle className="text-white text-base">Roleplay Sessions</CardTitle>
            <CardDescription className="text-slate-500 text-xs">
              {roleplaySessions?.length ?? 0} sessions across all practices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {roleplaySessions && roleplaySessions.length > 0 ? (
              roleplaySessions.map((session) => {
                const org = session.organizations as unknown as { name: string } | null
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0"
                  >
                    <div>
                      <p className="text-xs font-medium text-slate-300">
                        {session.scenario_title ?? 'Untitled'}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {org?.name ?? 'Unknown practice'}
                      </p>
                    </div>
                    <Badge
                      className={`text-[10px] h-4 px-1.5 ${
                        session.status === 'completed'
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20'
                          : 'bg-slate-700 text-slate-400'
                      }`}
                    >
                      {session.status}
                    </Badge>
                  </div>
                )
              })
            ) : (
              <p className="text-sm text-slate-500 py-4 text-center">No roleplay sessions yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="bg-violet-500/5 border-violet-500/20">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <GraduationCap className="h-5 w-5 text-violet-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-violet-300">Practice-Level Training</p>
              <p className="text-xs text-slate-400 mt-1">
                For detailed session-by-session roleplay training, log in to the practice dashboard
                and navigate to AI Training. The data is compiled here for your oversight.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
