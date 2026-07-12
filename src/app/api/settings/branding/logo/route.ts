import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export const runtime = 'nodejs'

const BUCKET = 'branding'
const MAX_BYTES = 2 * 1024 * 1024 // 2 MB — logos, not photography

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
}

/**
 * POST /api/settings/branding/logo — multipart upload of a brand logo.
 * Stores under branding/<orgId>/<slug>-<ts>.<ext> in a public bucket and
 * returns the public URL; the client then saves it as the brand's logoUrl
 * via the regular branding PATCH.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'branding:manage')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  const slug = String(form?.get('slug') ?? 'brand').replace(/[^a-z0-9_-]/gi, '') || 'brand'
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }
  const ext = EXT_BY_MIME[file.type]
  if (!ext) {
    return NextResponse.json({ error: 'Logo must be a PNG, JPEG, WebP, SVG, or GIF image' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Logo must be 2 MB or smaller' }, { status: 400 })
  }

  // Storage writes go through the service client: the bucket has no per-org
  // RLS policies, so the org scoping lives in the path prefix we control here.
  const admin = createServiceClient()
  const { data: buckets } = await admin.storage.listBuckets()
  if (!buckets?.some((b: { name: string }) => b.name === BUCKET)) {
    const { error: bucketError } = await admin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_BYTES,
    })
    if (bucketError && !/already exists/i.test(bucketError.message)) {
      return NextResponse.json({ error: bucketError.message }, { status: 500 })
    }
  }

  const path = `${orgId}/${slug}-${Date.now()}.${ext}`
  const bytes = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  })
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(path)
  return NextResponse.json({ ok: true, url: urlData.publicUrl })
}
