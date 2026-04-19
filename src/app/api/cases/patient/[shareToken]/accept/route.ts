import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/cases/patient/[shareToken]/accept — Patient acknowledges the treatment plan
 */

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const supabase = getServiceSupabase()

  const { data: caseData, error } = await supabase
    .from('clinical_cases')
    .select('id')
    .eq('share_token', shareToken)
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await supabase
    .from('clinical_cases')
    .update({
      patient_accepted_at: new Date().toISOString(),
      status: 'completed',
    })
    .eq('id', caseData.id)

  return NextResponse.json({ success: true })
}
