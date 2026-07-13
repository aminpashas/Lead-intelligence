import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const CONVO = 'fe43feea-d282-40a9-b8ed-fd1a72942709'
async function check() {
  const { data } = await s.from('messages').select('direction,sender_type,body,created_at')
    .eq('conversation_id', CONVO).order('created_at', { ascending: true })
  const inbound = (data||[]).filter(m => m.direction === 'inbound')
  return { total: (data||[]).length, inbound: inbound.length, msgs: data||[] }
}
;(async () => {
  for (let i = 0; i < 40; i++) {          // ~10 min max (40 * 15s)
    const r = await check()
    if (r.inbound > 0) {
      console.log('REPLY_DETECTED')
      for (const m of r.msgs) console.log(`[${m.direction}/${m.sender_type}] ${m.body}`)
      process.exit(0)
    }
    await new Promise(res => setTimeout(res, 15000))
  }
  console.log('TIMEOUT_NO_REPLY')
  process.exit(3)
})()
