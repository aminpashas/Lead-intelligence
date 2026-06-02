import { create } from 'zustand'
import type { Organization, UserProfile } from '@/types/database'

type OrgStore = {
  organization: Organization | null
  userProfile: UserProfile | null
  /** True when an agency admin is currently acting inside a client account. */
  actingAsClient: boolean
  setOrganization: (org: Organization) => void
  setUserProfile: (profile: UserProfile) => void
  setActingAsClient: (acting: boolean) => void
  reset: () => void
}

export const useOrgStore = create<OrgStore>((set) => ({
  organization: null,
  userProfile: null,
  actingAsClient: false,
  setOrganization: (org) => set({ organization: org }),
  setUserProfile: (profile) => set({ userProfile: profile }),
  setActingAsClient: (acting) => set({ actingAsClient: acting }),
  reset: () => set({ organization: null, userProfile: null, actingAsClient: false }),
}))
