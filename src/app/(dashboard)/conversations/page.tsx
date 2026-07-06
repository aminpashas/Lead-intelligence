import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { MessageSquare, Search } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII, searchHash } from '@/lib/encryption'

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  // Accept ?q= (this page's box) or ?search= (so the topbar can deep-link here).
  const q = (params.q || params.search || '').trim()
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // When searching, inner-join the lead so threads whose lead doesn't match are
  // dropped; otherwise a plain (nullable) embed keeps every conversation.
  let query = supabase
    .from('conversations')
    .select(`
      *,
      lead:leads${q ? '!inner' : ''}(id, first_name, last_name, phone, email, ai_score, ai_qualification)
    `)
    .eq('organization_id', orgId)
    .order('last_message_at', { ascending: false })
    .limit(100)

  if (q) {
    // Mirror the leads search: name via ilike, encrypted email/phone via hash,
    // plus full-name matching across first+last in either order. Filters apply
    // to the embedded lead (referencedTable), sanitized against .or() grammar.
    const hash = searchHash(q)
    const safe = q.replace(/[(),\\]/g, ' ').trim()
    const conds = [
      `first_name.ilike.%${safe}%`,
      `last_name.ilike.%${safe}%`,
      `email_hash.eq.${hash}`,
      `phone_hash.eq.${hash}`,
    ]
    const words = safe.split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      const [first, ...rest] = words
      const last = rest.join(' ')
      conds.push(`and(first_name.ilike.%${first}%,last_name.ilike.%${last}%)`)
      conds.push(`and(first_name.ilike.%${last}%,last_name.ilike.%${first}%)`)
    }
    query = query.or(conds.join(','), { referencedTable: 'lead' })
  }

  const { data: convoRows } = await query

  // Lead PII is encrypted at rest — decrypt server-side before rendering.
  const conversations = (convoRows || []).map((c) => ({
    ...c,
    lead: c.lead ? decryptLeadPII(c.lead as Record<string, unknown>) : c.lead,
  }))

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

      {/* ── Search ─────────────────────────────────────────── */}
      <form action="/conversations" method="get" className="mt-6">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-aurea-ink-3" strokeWidth={1.75} />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by name, email, or phone..."
            className="h-9 w-full rounded-md border border-aurea-border bg-aurea-surface pl-9 pr-3 text-[13px] text-aurea-ink placeholder:text-aurea-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aurea-primary/30"
          />
        </div>
      </form>

      {/* ── List ───────────────────────────────────────────── */}
      <div className="mt-4 space-y-1">
        {(!conversations || conversations.length === 0) ? (
          <div className="aurea-card flex flex-col items-center py-14">
            <MessageSquare className="h-8 w-8 text-aurea-ink-3 mb-3" strokeWidth={1.75} />
            {q ? (
              <>
                <p className="text-[14px] font-medium text-aurea-ink">No conversations match “{q}”</p>
                <p className="mt-1 text-[13px] text-aurea-ink-3">
                  Try a different name, email, or phone number — or{' '}
                  <Link href="/conversations" className="text-aurea-primary hover:underline">clear the search</Link>.
                </p>
              </>
            ) : (
              <>
                <p className="text-[14px] font-medium text-aurea-ink">No conversations yet</p>
                <p className="mt-1 text-[13px] text-aurea-ink-3">
                  Conversations will appear here when leads respond to SMS or email
                </p>
              </>
            )}
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
