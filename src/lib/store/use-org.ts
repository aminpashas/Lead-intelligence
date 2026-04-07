import { create } from 'zustand'
import type { Organization, UserProfile } from '@/types/database'

type OrgStore = {
  organization: Organization | null
  userProfile: UserProfile | null
  setOrganization: (org: Organization) => void
  setUserProfile: (profile: UserProfile) => void
  reset: () => void
}

export const useOrgStore = create<OrgStore>((set) => ({
  organization: null,
  userProfile: null,
  setOrganization: (org) => set({ organization: org }),
  setUserProfile: (profile) => set({ userProfile: profile }),
  reset: () => set({ organization: null, userProfile: null }),
}))
