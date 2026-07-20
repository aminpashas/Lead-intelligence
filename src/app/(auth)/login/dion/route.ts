import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { postLoginPath } from '@/lib/auth/post-login-path'

/**
 * Dion SSO receiver — the product side of the hub's launch handoff.
 *
 * The Dion console gates a launch on a live session + entitlement, mints a
 * short-lived token, and sends the operator here:
 *
 *   /login/dion?dion_launch=<token>&next=/leads
 *
 * We verify that token with the hub, then mint OUR OWN Supabase session from
 * the verified email — so the operator lands signed in instead of hitting this
 * app's login a second time. The hub never sends us its own session cookie;
 * only this short-lived, single-purpose token ever travels in a URL.
 *
 * This route MUST run before a session exists, so it must not be auth-gated.
 * It already isn't: `/login` is a PUBLIC_PREFIX and `isPublicPath` matches by
 * prefix, which is exactly why the receiver lives under /login rather than
 * somewhere that would need a new middleware exception.
 */

/** Our id in the hub's suite catalog (@dion/ui SUITE_PRODUCTS). */
const PRODUCT_ID = 'lead-intelligence'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token = searchParams.get('dion_launch')

  // Only same-origin absolute paths, and never a protocol-relative `//host`,
  // so a caller-supplied `next` can't become an open redirect behind a freshly
  // minted session.
  const nextParam = searchParams.get('next')
  const dest =
    nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : null

  const hub = process.env.DION_HUB_URL?.replace(/\/$/, '')
  if (!token || !hub) {
    return NextResponse.redirect(`${origin}/login`)
  }

  // Verified server-side: doing this in the browser would expose the token to
  // page scripts, and it is already the most exposed part of the flow since it
  // rides in a URL (Referer, history, access logs).
  //
  // `product` is REQUIRED — it is the audience the token must have been minted
  // for, and it is what stops a token captured from another Dion app being
  // replayed against this one.
  let identity: { valid?: boolean; email?: string } = {}
  try {
    const res = await fetch(
      `${hub}/api/launch/verify?token=${encodeURIComponent(token)}&product=${PRODUCT_ID}`,
      { cache: 'no-store' }
    )
    identity = (await res.json()) as typeof identity
  } catch {
    // Hub unreachable → fall back to our own login rather than failing open.
    return NextResponse.redirect(`${origin}/login?error=dion_unreachable`)
  }

  const email = identity.valid ? identity.email?.toLowerCase() : undefined
  if (!email) {
    return NextResponse.redirect(`${origin}/login?error=dion_invalid`)
  }

  // Mint our own session keyed on the verified email — the cross-product
  // identity key; the hub's dionStaffId means nothing in this database.
  //
  // `generateLink` with type 'magiclink' requires the user to ALREADY EXIST,
  // and that is the behavior we want: a valid token proves the hub
  // authenticated someone, not that they should have an account in this org's
  // CRM. An unknown email falls through to the normal login rather than being
  // provisioned. (Resolving via admin.listUsers() first would also be wrong —
  // it is paginated at 50 and silently misses users past the first page.)
  //
  // No magic-link email is sent: we exchange the hashed token immediately
  // server-side, so it never reaches the browser.
  const admin = createServiceClient()
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError || !link?.properties?.hashed_token) {
    // "No such user" and genuine failures share one reason on purpose: telling
    // an unauthenticated caller which emails have accounts here is an
    // enumeration oracle.
    return NextResponse.redirect(`${origin}/login?error=dion_no_session`)
  }

  const supabase = await createClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'email',
    token_hash: link.properties.hashed_token,
  })
  if (verifyError) {
    return NextResponse.redirect(`${origin}/login?error=dion_no_session`)
  }

  // With no explicit `next`, land where a normal login would. Shared with the
  // OAuth callback via postLoginPath() so the two entry points can't drift:
  // an agency_admin who hasn't entered a client belongs in the Agency Console,
  // not on an empty practice dashboard.
  let destination = dest ?? '/dashboard'
  if (!dest) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()

      let actingAsClient = false
      if (profile?.role === 'agency_admin') {
        const { data: active } = await supabase
          .from('agency_active_org')
          .select('active_org_id')
          .maybeSingle()
        actingAsClient = !!active?.active_org_id
      }

      destination = postLoginPath({ role: profile?.role, actingAsClient })
    }
  }

  // Land on a CLEAN path so the launch token does not linger in history or get
  // forwarded in a Referer.
  return NextResponse.redirect(`${origin}${destination}`)
}
