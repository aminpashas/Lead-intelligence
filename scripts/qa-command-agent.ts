/**
 * QA: exercise the dashboard command agent end-to-end against real org data.
 *
 * READ-ONLY by construction — the agent's only mutating capability is emitting
 * PROPOSALS (never sends), and this script just prints them. Nothing is texted
 * or emailed.
 *
 * Usage: npx tsx scripts/qa-command-agent.ts "<prompt>"
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { runCommandAgent } = await import('../src/lib/ai/command-agent')

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Pick the org with the most leads (the live practice) for a realistic run.
  const { data: orgs } = await supabase.from('organizations').select('id, name').limit(10)
  if (!orgs?.length) throw new Error('no orgs')
  let best = { id: orgs[0].id, name: orgs[0].name, count: -1 }
  for (const o of orgs) {
    const { count } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', o.id)
    if ((count || 0) > best.count) best = { id: o.id, name: o.name, count: count || 0 }
  }
  console.log(`org: ${best.name} (${best.count} leads)`)

  const prompt =
    process.argv[2] ||
    'How many hot leads do we have that we haven\'t contacted in the last 3 days? Draft a friendly follow-up text for them.'

  const result = await runCommandAgent({
    supabase,
    orgId: best.id,
    userName: 'QA',
    history: [{ role: 'user', content: prompt }],
  })

  console.log('\n--- REPLY ---\n' + result.reply)
  console.log('\n--- PROPOSALS ---')
  for (const p of result.proposals) {
    console.log(
      JSON.stringify(
        { ...p, lead_ids: `[${p.lead_ids.length} ids]` },
        null,
        2
      )
    )
  }
  if (result.proposals.length === 0) console.log('(none)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
