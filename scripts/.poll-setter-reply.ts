import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const CONVO = 'fe43feea-d282-40a9-b8ed-fd1a72942709'
const LEAD = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b'
;(async () => {
  for (let i = 0; i < 20; i++) {   // ~5 min
    const { data } = await s.from('messages').select('direction,sender_type,body,created_at,metadata')
      .eq('conversation_id', CONVO).order('created_at', { ascending: true })
    const msgs = data || []
    // outbound AI message AFTER the inbound "I need implants"
    const inboundIdx = msgs.findIndex(m => m.direction === 'inbound')
    const laterOut = inboundIdx >= 0 ? msgs.slice(inboundIdx+1).filter(m => m.direction === 'outbound') : []
    if (laterOut.length > 0) {
      console.log('SETTER_REPLIED')
      for (const m of msgs) console.log(`[${m.direction}/${m.sender_type}] ${m.body}`)
      // also surface escalations + activities to catch a blocked/escalated reply
      const { data: esc } = await s.from('lead_activities').select('activity_type,title,description,created_at')
        .eq('lead_id', LEAD).order('created_at',{ascending:false}).limit(6)
      console.log('--- recent lead_activities ---')
      for (const e of (esc||[])) console.log(`{${e.activity_type}} ${e.title} :: ${(e.description||'').slice(0,140)}`)
      process.exit(0)
    }
    await new Promise(r => setTimeout(r, 15000))
  }
  console.log('NO_SETTER_REPLY_YET')
  // dump activities to diagnose a silent block/escalation
  const { data: esc } = await s.from('lead_activities').select('activity_type,title,description,created_at')
    .eq('lead','62e839ba-90ea-4e77-bcb8-68d5172a2e6b').order('created_at',{ascending:false}).limit(8)
  process.exit(3)
})()
