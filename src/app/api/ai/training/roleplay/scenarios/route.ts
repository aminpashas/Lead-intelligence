import { NextResponse } from 'next/server'
import { BUILT_IN_SCENARIOS } from '@/lib/ai/roleplay-engine'

// GET — List available role-play scenarios
export async function GET() {
  return NextResponse.json({ scenarios: BUILT_IN_SCENARIOS })
}
