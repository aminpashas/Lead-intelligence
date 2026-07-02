import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

// Regression: `user_profiles`' SELECT policy is org-scoped ("Users can view
// profiles in their organization"), NOT self-scoped. resolveActiveOrg (and
// dozens of API routes) used a bare `.single()`, which sees every staff
// profile in the org — so for any org with 2+ members the query failed with
// PGRST116, the profile resolved to null, and every page/route treated the
// caller as unauthenticated (blank /campaigns, 401s). Confirmed live
// 2026-07-02 with a test member in the two-profile Dion Growth Studio org.
// Own-profile reads must always filter by the auth user's id.

type Row = Record<string, unknown>

/**
 * Minimal PostgREST-ish mock that mimics the failure mode: the visible row
 * set starts as EVERYTHING the org-scoped RLS policy exposes, and only an
 * explicit .eq() narrows it. single()/maybeSingle() behave like PostgREST
 * (PGRST116 + null data when the filter set has more than one row).
 */
function mockSupabase({
  uid,
  tables,
}: {
  uid: string | null
  tables: Record<string, Row[]>
}): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({ data: { user: uid ? { id: uid } : null } }),
    },
    from(table: string) {
      let rows = tables[table] ?? []
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          rows = rows.filter((r) => r[column] === value)
          return builder
        },
        single: async () =>
          rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: { code: 'PGRST116' } },
        maybeSingle: async () =>
          rows.length <= 1
            ? { data: rows[0] ?? null, error: null }
            : { data: null, error: { code: 'PGRST116' } },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const ORG = 'org-uuid'
const TWO_STAFF_ORG = [
  { id: 'user-a', organization_id: ORG, role: 'member', full_name: 'A' },
  { id: 'user-b', organization_id: ORG, role: 'owner', full_name: 'B' },
]

describe('resolveActiveOrg', () => {
  it('resolves the caller in an org with MULTIPLE staff profiles', async () => {
    const supabase = mockSupabase({
      uid: 'user-a',
      tables: { user_profiles: TWO_STAFF_ORG },
    })
    expect(await resolveActiveOrg(supabase)).toEqual({
      orgId: ORG,
      role: 'member',
      actingAsClient: false,
      homeOrgId: ORG,
    })
  })

  it('returns nulls when unauthenticated', async () => {
    const supabase = mockSupabase({
      uid: null,
      tables: { user_profiles: TWO_STAFF_ORG },
    })
    expect(await resolveActiveOrg(supabase)).toEqual({
      orgId: null,
      role: null,
      actingAsClient: false,
      homeOrgId: null,
    })
  })

  it('agency_admin inside a client resolves to that client org', async () => {
    const supabase = mockSupabase({
      uid: 'admin-1',
      tables: {
        user_profiles: [
          ...TWO_STAFF_ORG,
          { id: 'admin-1', organization_id: 'agency-org', role: 'agency_admin' },
        ],
        agency_active_org: [
          { user_id: 'admin-1', active_org_id: 'client-org' },
        ],
      },
    })
    expect(await resolveActiveOrg(supabase)).toEqual({
      orgId: 'client-org',
      role: 'agency_admin',
      actingAsClient: true,
      homeOrgId: 'agency-org',
    })
  })
})

describe('getOwnProfile', () => {
  it("returns the caller's OWN row even when org-mates are visible", async () => {
    const supabase = mockSupabase({
      uid: 'user-b',
      tables: { user_profiles: TWO_STAFF_ORG },
    })
    const { data } = await getOwnProfile(supabase, 'id, organization_id')
    expect(data?.id).toBe('user-b')
  })

  it('returns null data when unauthenticated', async () => {
    const supabase = mockSupabase({
      uid: null,
      tables: { user_profiles: TWO_STAFF_ORG },
    })
    expect((await getOwnProfile(supabase, 'id')).data).toBeNull()
  })
})

describe('no unfiltered user_profiles single-row queries in src/', () => {
  // Static guard for the whole codebase: a `.from('user_profiles')` whose
  // .select() is IMMEDIATELY terminated by .single()/.maybeSingle() has no
  // .eq('id', ...) filter and will break for every org with 2+ staff. Fetch
  // own-profile rows via getOwnProfile() (or filter by the auth user id).
  const BARE_QUERY = new RegExp(
    String.raw`\.from\(['"]user_profiles['"]\)\s*\.select\([^)]*\)\s*\.(?:single|maybeSingle)\(\)`,
    'g'
  )

  it('every user_profiles single-row query filters by id', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !full.includes('__tests__')) {
          const source = fs.readFileSync(full, 'utf8')
          for (const match of source.matchAll(BARE_QUERY)) {
            const line = source.slice(0, match.index).split('\n').length
            offenders.push(`${full}:${line}`)
          }
        }
      }
    }
    walk(path.join(__dirname, '..', '..'))
    expect(offenders).toEqual([])
  })
})
