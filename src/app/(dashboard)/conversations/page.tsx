import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { MessageSquare } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function ConversationsPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: conversations } = await supabase
    .from('conversations')
    .select(`
      *,
      lead:leads(id, first_name, last_name, phone, email, ai_score, ai_qualification)
    `)
    .eq('organization_id', orgId)
    .order('last_message_at', { ascending: false })
    .limit(100)

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Messaging</p>
        <h1 className="aurea-display text-[36px] text-aurea-ink sm:text-[46px]">
          Conversations
        </h1>
        <p className="mt-4 text-[16px] leading-relaxed text-aurea-ink-2">
          All SMS and email conversations with leads
        </p>
      </header>

      {/* ── List ───────────────────────────────────────────── */}
      <div className="mt-6 space-y-1">
        {(!conversations || conversations.length === 0) ? (
          <div className="aurea-card flex flex-col items-center py-14">
            <MessageSquare className="h-8 w-8 text-aurea-ink-3 mb-3" strokeWidth={1.75} />
            <p className="text-[14px] font-medium text-aurea-ink">No conversations yet</p>
            <p className="mt-1 text-[13px] text-aurea-ink-3">
              Conversations will appear here when leads respond to SMS or email
            </p>
          </div>
        ) : (
          conversations.map((convo) => (
            <Link key={convo.id} href={`/conversations/${convo.id}`}>
              <div className="aurea-card flex cursor-pointer items-center justify-between px-5 py-3.5 transition-colors hover:bg-aurea-surface-2">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-aurea-ink-3">
                      {convo.channel}
                    </span>
                    {convo.unread_count > 0 && (
                      <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-aurea-rose px-1.5 text-[10px] font-semibold text-white">
                        {convo.unread_count}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-[14px] font-medium text-aurea-ink">
                      {convo.lead?.first_name} {convo.lead?.last_name}
                    </p>
                    <p className="max-w-md truncate text-[12px] text-aurea-ink-3">
                      {convo.last_message_preview || 'No messages yet'}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[12px] text-aurea-ink-3">
                    {convo.last_message_at
                      ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                      : ''}
                  </p>
                  {convo.ai_enabled && (
                    <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-aurea-primary">
                      <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
                      AI {convo.ai_mode}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
