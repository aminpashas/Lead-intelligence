import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type NotificationType =
  | 'new_lead'
  | 'hot_lead'
  | 'lead_cold'
  | 'appointment_booked'
  | 'inbound_message'
  | 'campaign_completed'
  | 'agent_status_down'
  | 'agent_probation'

export type Notification = {
  id: string
  type: NotificationType
  title: string
  description: string
  actionUrl?: string
  read: boolean
  timestamp: string
}

type NotificationStore = {
  notifications: Notification[]
  unreadCount: number
  addNotification: (n: Omit<Notification, 'id' | 'read' | 'timestamp'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  dismiss: (id: string) => void
  clearAll: () => void
}

const MAX_NOTIFICATIONS = 50

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      notifications: [],
      unreadCount: 0,

      addNotification: (n) =>
        set((state) => {
          const notification: Notification = {
            ...n,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            read: false,
            timestamp: new Date().toISOString(),
          }
          const updated = [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS)
          return {
            notifications: updated,
            unreadCount: state.unreadCount + 1,
          }
        }),

      markRead: (id) =>
        set((state) => {
          const notifications = state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          )
          return {
            notifications,
            unreadCount: notifications.filter((n) => !n.read).length,
          }
        }),

      markAllRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
          unreadCount: 0,
        })),

      dismiss: (id) =>
        set((state) => {
          const notifications = state.notifications.filter((n) => n.id !== id)
          return {
            notifications,
            unreadCount: notifications.filter((n) => !n.read).length,
          }
        }),

      clearAll: () => set({ notifications: [], unreadCount: 0 }),
    }),
    {
      name: 'lead-intelligence-notifications',
    }
  )
)
