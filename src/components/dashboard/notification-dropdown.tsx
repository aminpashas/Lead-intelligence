'use client'

import { useRouter } from 'next/navigation'
import { useNotificationStore, type NotificationType } from '@/lib/store/use-notifications'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Bell,
  UserPlus,
  Flame,
  Snowflake,
  Calendar,
  MessageSquare,
  Megaphone,
  CheckCheck,
  X,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const NOTIFICATION_ICONS: Record<NotificationType, { icon: React.ElementType; color: string }> = {
  new_lead: { icon: UserPlus, color: 'text-aurea-primary' },
  hot_lead: { icon: Flame, color: 'text-aurea-rose' },
  lead_cold: { icon: Snowflake, color: 'text-aurea-ink-3' },
  appointment_booked: { icon: Calendar, color: 'text-aurea-amber' },
  inbound_message: { icon: MessageSquare, color: 'text-aurea-ink-2' },
  campaign_completed: { icon: Megaphone, color: 'text-aurea-amber' },
  agent_status_down: { icon: AlertTriangle, color: 'text-aurea-amber' },
  agent_probation: { icon: ShieldAlert, color: 'text-aurea-rose' },
}

export function NotificationDropdown() {
  const router = useRouter()
  const { notifications, unreadCount, markRead, markAllRead, dismiss } = useNotificationStore()
  const recent = notifications.slice(0, 20)

  function handleClick(id: string, actionUrl?: string) {
    markRead(id)
    if (actionUrl) router.push(actionUrl)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <span className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-aurea-surface-2 cursor-pointer transition-colors">
          <Bell className="h-[17px] w-[17px] text-aurea-ink-2" strokeWidth={1.75} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-aurea-primary text-[10px] font-bold text-white flex items-center justify-center px-0.5 font-mono tabular-nums">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-0 bg-aurea-surface border-aurea-border"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-aurea-border">
          <h3 className="text-[13px] font-semibold text-aurea-ink">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1 text-aurea-ink-3 hover:text-aurea-ink hover:bg-aurea-surface-2"
              onClick={(e) => {
                e.stopPropagation()
                markAllRead()
              }}
            >
              <CheckCheck className="h-3 w-3" strokeWidth={1.75} />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification List */}
        <ScrollArea className="max-h-80">
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Bell className="h-8 w-8 text-aurea-ink-3/30 mb-2" strokeWidth={1.75} />
              <p className="text-sm text-aurea-ink-3">No notifications yet</p>
              <p className="text-xs text-aurea-ink-3 mt-0.5">
                You&apos;ll see alerts for hot leads, bookings, and messages here
              </p>
            </div>
          ) : (
            <div>
              {recent.map((notification) => {
                const config = NOTIFICATION_ICONS[notification.type]
                const Icon = config.icon
                return (
                  <div
                    key={notification.id}
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-aurea-surface-2 cursor-pointer transition-colors border-b border-aurea-border last:border-0 ${
                      !notification.read ? 'bg-aurea-primary/5' : ''
                    }`}
                    onClick={() => handleClick(notification.id, notification.actionUrl)}
                  >
                    {/* Icon */}
                    <div className={`mt-0.5 shrink-0 ${config.color}`}>
                      <Icon className="h-[17px] w-[17px]" strokeWidth={1.75} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {!notification.read && (
                          <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary shrink-0" />
                        )}
                        <p className="text-[13px] font-medium text-aurea-ink truncate">{notification.title}</p>
                      </div>
                      <p className="text-xs text-aurea-ink-3 truncate mt-0.5">
                        {notification.description}
                      </p>
                      <p className="text-[10px] text-aurea-ink-3/70 mt-1 font-mono tabular-nums">
                        {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                      </p>
                    </div>

                    {/* Dismiss */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100 text-aurea-ink-3 hover:text-aurea-ink hover:bg-aurea-surface-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismiss(notification.id)
                      }}
                    >
                      <X className="h-3 w-3" strokeWidth={1.75} />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
