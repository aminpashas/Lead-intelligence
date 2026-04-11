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
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const NOTIFICATION_ICONS: Record<NotificationType, { icon: React.ElementType; color: string }> = {
  new_lead: { icon: UserPlus, color: 'text-green-500' },
  hot_lead: { icon: Flame, color: 'text-red-500' },
  lead_cold: { icon: Snowflake, color: 'text-blue-400' },
  appointment_booked: { icon: Calendar, color: 'text-orange-500' },
  inbound_message: { icon: MessageSquare, color: 'text-purple-500' },
  campaign_completed: { icon: Megaphone, color: 'text-amber-500' },
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
        <span className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent cursor-pointer">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground flex items-center justify-center px-0.5">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={(e) => {
                e.stopPropagation()
                markAllRead()
              }}
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification List */}
        <ScrollArea className="max-h-80">
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Bell className="h-8 w-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
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
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-accent cursor-pointer transition-colors border-b last:border-0 ${
                      !notification.read ? 'bg-primary/5' : ''
                    }`}
                    onClick={() => handleClick(notification.id, notification.actionUrl)}
                  >
                    {/* Icon */}
                    <div className={`mt-0.5 shrink-0 ${config.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {!notification.read && (
                          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                        )}
                        <p className="text-sm font-medium truncate">{notification.title}</p>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {notification.description}
                      </p>
                      <p className="text-xs text-muted-foreground/70 mt-1">
                        {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                      </p>
                    </div>

                    {/* Dismiss */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismiss(notification.id)
                      }}
                    >
                      <X className="h-3 w-3" />
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
