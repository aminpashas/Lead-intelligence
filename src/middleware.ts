import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { isPublicPath } from '@/lib/auth/public-paths'
import { canAccessRoute } from '@/lib/auth/permissions'

/**
 * Allowed origin for CORS — restrict API access to the configured app URL.
 * Falls back to '' which means CORS headers won't be set if unconfigured.
 */
const ALLOWED_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || ''

/**
 * Redirect to /login, preserving the originally requested path (+ query) as
 * `?next=` so the login page can return the user there instead of the role
 * default. Only meaningful for GET page navigations — non-GET requests can't
 * be replayed by a redirect, so they get a bare /login.
 */
function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  if (request.method === 'GET') {
    url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
  }
  return NextResponse.redirect(url)
}

function setCorsHeaders(response: NextResponse, origin: string | null): NextResponse {
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    response.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-share-token')
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Max-Age', '86400')
  }
  return response
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const origin = request.headers.get('origin')

  // Handle CORS preflight for API routes
  if (request.method === 'OPTIONS' && pathname.startsWith('/api')) {
    const response = new NextResponse(null, { status: 204 })
    return setCorsHeaders(response, origin)
  }

  // Skip middleware for auth pages/handlers, public patient portals, API
  // webhooks, and static assets. NB: this includes /auth/callback — the OAuth
  // handler must run before a session exists, so it cannot be gated. See
  // src/lib/auth/public-paths.ts.
  if (isPublicPath(pathname)) {
    const response = NextResponse.next()
    // Add CORS headers to API responses even for bypassed routes
    if (pathname.startsWith('/api')) {
      return setCorsHeaders(response, origin)
    }
    return response
  }

  // ============================================
  // AGENCY ROUTES — require agency_admin role
  // ============================================
  if (pathname.startsWith('/agency')) {
    let supabaseResponse = NextResponse.next({ request })

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return request.cookies.getAll() },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    try {
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        return redirectToLogin(request)
      }

      // Check for agency_admin role
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!profile || profile.role !== 'agency_admin') {
        // Authenticated but not agency — send to practice dashboard
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    } catch {
      return redirectToLogin(request)
    }

    return supabaseResponse
  }

  // For API routes, add CORS headers to the response
  if (pathname.startsWith('/api')) {
    let supabaseResponse = NextResponse.next({ request })

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    // Refresh session + auth backstop. `isPublicPath` has already let webhooks,
    // cron, patient share-token portals, and service-key APIs (/api/v1, /api/voice)
    // through above, so anything reaching here is a session-scoped route. Reject
    // unauthenticated requests so a route that forgets its own `getUser()` check
    // is not exposed to the anonymous internet (defense-in-depth; each route still
    // authenticates itself). Requests bearing a share token or bearer/service key
    // pass through to self-authenticate.
    const { data: { user } } = await supabase.auth.getUser()
    const carriesToken =
      !!request.headers.get('x-share-token') || !!request.headers.get('authorization')
    if (!user && !carriesToken) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      return setCorsHeaders(res, origin)
    }
    return setCorsHeaders(supabaseResponse, origin)
  }

  // Dashboard routes — require auth
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()

    // Redirect unauthenticated users to login
    if (!user) {
      return redirectToLogin(request)
    }

    // ── Server-side role gating (defense-in-depth) ────────────────
    // The nav hides routes a role can't use; this closes the URL-bar hole so a
    // restricted role can't reach a gated page by typing its path. It layers on
    // top of each page's own gate — it is NOT the sole gate — so on any doubt it
    // fails OPEN (allow) rather than risk locking a legitimate user out.
    //
    // Scope: GET page navigations only. Non-GET requests (server actions POST to
    // the same route) must never be redirected. Public paths, /api, and /agency
    // are handled/returned above. /dashboard is skipped outright: it is the
    // redirect target below and every role can reach it (mapped dashboard:view +
    // allowlisted), so skipping it makes a redirect loop structurally impossible.
    if (request.method === 'GET' && pathname !== '/dashboard') {
      try {
        // Fetch the caller's OWN role. Must filter by user.id: user_profiles'
        // SELECT policy is org-scoped, so a bare .single() matches every profile
        // in the org and errors once the org has a second member (see
        // getOwnProfile in active-org.ts). This mirrors the /agency branch above.
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle()

        const role = profile?.role as string | undefined

        // agency_admin bypasses practice-route gating entirely: when acting as a
        // client they legitimately navigate every practice page, and the nav
        // shows them everything. Their raw role stays 'agency_admin' (they are
        // never downgraded to the client's role), matching what the sidebar
        // passes to canAccessRoute. All OTHER roles are gated by the RBAC map.
        //
        // FAIL OPEN: if the role is missing (DB hiccup / no profile), do not
        // block — a transient lookup failure must never lock the whole app out.
        if (role && role !== 'agency_admin' && !canAccessRoute(role, pathname)) {
          const url = request.nextUrl.clone()
          url.pathname = '/dashboard'
          url.search = ''
          return NextResponse.redirect(url)
        }
      } catch (err) {
        // Defense-in-depth only: a role-lookup failure must not strand the user.
        // Log and fall through to allow; page-level gates remain in force.
        console.error('[middleware] role gating lookup failed:', err)
      }
    }
  } catch {
    // If auth check fails, redirect to login
    return redirectToLogin(request)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all routes except static files
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js|css)$).*)',
  ],
}

