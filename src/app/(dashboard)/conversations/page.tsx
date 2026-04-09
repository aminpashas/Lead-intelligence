import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MessageSquare } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'

export default async function ConversationsPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const { data: conversations } = await supabase
    .from('conversations')
    .select(`
      *,
      lead:leads(id, first_name, last_name, phone, email, ai_score, ai_qualification)
    `)
    .eq('organization_id', profile.organization_id)
    .order('last_message_at', { ascending: false })
    .limit(100)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Conversations</h1>
        <p className="text-muted-foreground">
          All SMS and email conversations with leads
        </p>
      </div>

      <div className="space-y-2">
        {(!conversations || conversations.length === 0) ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12">
              <MessageSquare className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">No conversations yet</p>
              <p className="text-sm text-muted-foreground">
                Conversations will appear here when leads respond to SMS or email
              </p>
            </CardContent>
          </Card>
        ) : (
          conversations.map((convo) => (
            <Link key={convo.id} href={`/conversations/${convo.id}`}>
              <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                <CardContent className="py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{convo.channel}</Badge>
                      {convo.unread_count > 0 && (
                        <Badge variant="destructive" className="text-xs">
                          {convo.unread_count}
                        </Badge>
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-sm">
                        {convo.lead?.first_name} {convo.lead?.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate max-w-md">
                        {convo.last_message_preview || 'No messages yet'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground">
                      {convo.last_message_at
                        ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                        : ''}
                    </p>
                    {convo.ai_enabled && (
                      <Badge variant="secondary" className="text-xs mt-1">
                        AI {convo.ai_mode}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
