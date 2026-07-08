/**
 * Content Assets API — CRUD for practice content
 *
 * GET  — List assets for the caller's org (optionally filtered by type)
 * POST — Create a new content asset in the caller's org
 * PATCH/DELETE — Mutate an asset, scoped to the caller's org
 *
 * Auth: every handler derives the effective org from the session (agency admins
 * resolve to their entered client). These routes were previously unauthenticated
 * and trusted a request-supplied `organization_id`; PATCH/DELETE mutated by `id`
 * with no org scoping at all (global IDOR). Never trust a caller-supplied org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { createAsset, getAssetsByType, updateAsset, deactivateAsset } from '@/lib/content/practice-assets'
import type { ContentAssetType } from '@/types/database'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/** Resolve the caller's effective org, or null when unauthenticated. */
async function requireOrg(): Promise<string | null> {
  const authed = await createServerClient()
  const { orgId } = await resolveActiveOrg(authed)
  return orgId
}

/** True when `assetId` exists and belongs to `orgId`. */
async function assetBelongsToOrg(
  supabase: ReturnType<typeof getServiceClient>,
  assetId: string,
  orgId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('practice_content_assets')
    .select('organization_id')
    .eq('id', assetId)
    .maybeSingle()
  return data?.organization_id === orgId
}

export async function GET(request: NextRequest) {
  const orgId = await requireOrg()
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') as ContentAssetType | null

  const supabase = getServiceClient()

  if (type) {
    const assets = await getAssetsByType(supabase, orgId, type)
    return NextResponse.json({ assets })
  }

  // Get all active assets for the org
  const { data: assets } = await supabase
    .from('practice_content_assets')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .order('type')
    .order('usage_count', { ascending: false })

  return NextResponse.json({ assets: assets || [] })
}

export async function POST(request: NextRequest) {
  const orgId = await requireOrg()
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  const { type, title, description, content, media_urls, tags, created_by } = body

  if (!type || !title) {
    return NextResponse.json(
      { error: 'type and title are required' },
      { status: 400 }
    )
  }

  const validTypes: ContentAssetType[] = [
    'testimonial_video',
    'before_after_photo',
    'practice_info',
    'appointment_details',
    'financing_info',
    'procedure_info',
  ]

  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 }
    )
  }

  const supabase = getServiceClient()

  const asset = await createAsset(supabase, {
    organization_id: orgId,
    type,
    title,
    description,
    content: content || {},
    media_urls: media_urls || [],
    tags: tags || [],
    created_by,
  })

  if (!asset) {
    return NextResponse.json({ error: 'Failed to create asset' }, { status: 500 })
  }

  return NextResponse.json({ asset }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const orgId = await requireOrg()
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { id, organization_id: _ignored, ...updates } = body

  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // Ownership check — never mutate an asset outside the caller's org.
  if (!(await assetBelongsToOrg(supabase, id, orgId))) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  }

  const asset = await updateAsset(supabase, id, updates)
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found or update failed' }, { status: 404 })
  }

  return NextResponse.json({ asset })
}

export async function DELETE(request: NextRequest) {
  const orgId = await requireOrg()
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // Ownership check — never deactivate an asset outside the caller's org.
  if (!(await assetBelongsToOrg(supabase, id, orgId))) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  }

  await deactivateAsset(supabase, id)

  return NextResponse.json({ success: true })
}
