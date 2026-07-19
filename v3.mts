import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { serviceLineOrFilter, SERVICE_LINES } from './src/lib/leads/service-line.js'
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()])) as Record<string,string>
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}})
const {data:orgs}=await sb.from('organizations').select('id,name'); const org=(orgs as any[]).find(o=>o.name==='SF Dentistry')
const {data:stages}=await sb.from('pipeline_stages').select('*').eq('organization_id',org.id)
const POST=['contract-signed','scheduled','completed'],OFF=['existing-patient','junk'],OPS=['no-communication','dnd-sms','nurturing']
const board=(stages as any[]).filter(s=>!POST.includes(s.slug)&&!OFF.includes(s.slug))
const ids=board.map(s=>s.id), opIds=board.filter(s=>OPS.includes(s.slug)).map(s=>s.id)
const POP=`stage_id.in.(${opIds.join(',')}),status.not.in.(disqualified,lost)`
const chip=async(or:string|null)=>{let q=sb.from('leads').select('id',{count:'exact',head:true}).eq('organization_id',org.id).in('stage_id',ids).or(POP); if(or) q=q.or(or); const{count,error}=await q; if(error)throw new Error(JSON.stringify(error)); return count!}
console.log('All chip / list total:', (await chip(null)).toLocaleString())
for(const {key,label} of SERVICE_LINES){
  const or=serviceLineOrFilter(key)!
  const c=await chip(or)
  // page-1 of the list under the same predicate
  const {data,error}=await sb.from('leads').select('id').eq('organization_id',org.id).in('stage_id',ids).or(POP).or(or).order('created_at',{ascending:false,nullsFirst:false}).order('id',{ascending:true}).range(0,49)
  console.log(`${label.padEnd(12)} chip=${String(c).padStart(6)}  page1rows=${error?'ERR '+JSON.stringify(error):data!.length}`)
}
