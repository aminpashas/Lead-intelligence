import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { isPublicPath } from '@/lib/auth/public-paths'

/**
 * Allowed origin for CORS — restrict API access to the configured app URL.
 * Falls back to '' which means CORS headers won't be set if unconfigured.
 */
const ALLOWED_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || ''

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
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        return NextResponse.redirect(url)
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
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
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

    // Refresh session
    await supabase.auth.getUser()
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
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
    }
  } catch {
    // If auth check fails, redirect to login
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
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

