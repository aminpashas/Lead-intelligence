'use client'

import { cn } from '@/lib/utils'
import { Bot, User, Star, ThumbsUp, ThumbsDown, MessageSquarePlus, Stethoscope, Headset } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useState } from 'react'
import type { AIRolePlayMessage, RolePlayRole } from '@/types/database'

type RolePlayMessageProps = {
  message: AIRolePlayMessage
  index: number
  onToggleGolden: (index: number) => void
  onRate: (index: number, rating: 'good' | 'bad' | null) => void
  onAddNote: (index: number, note: string) => void
}

export function RolePlayMessage({
  message,
  index,
  onToggleGolden,
  onRate,
  onAddNote,
}: RolePlayMessageProps) {
  const [noteText, setNoteText] = useState(message.coaching_note || '')
  const [noteOpen, setNoteOpen] = useState(false)
  const isUser = message.role === 'user'
  const isPatient = message.acting_as === 'patient'

  return (
    <div className={cn('flex gap-3 mb-5 group', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all shadow-sm',
          isPatient
            ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white'
            : 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white'
        )}
      >
        {isPatient ? <User className="h-4 w-4" /> : <Headset className="h-4 w-4" />}
      </div>

      {/* Message content */}
      <div className={cn('max-w-[75%] space-y-1.5', isUser && 'items-end')}>
        {/* Role label */}
        <div className={cn('flex items-center gap-2', isUser && 'flex-row-reverse')}>
          <span className={cn(
            'text-xs font-semibold uppercase tracking-wide',
            isPatient ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'
          )}>
            {isPatient ? '🧑 Patient' : '💼 Treatment Coordinator'}
          </span>
          {message.is_golden_example && (
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
          )}
          {message.rating === 'good' && (
            <ThumbsUp className="h-3.5 w-3.5 text-green-500 fill-green-500" />
          )}
          {message.rating === 'bad' && (
            <ThumbsDown className="h-3.5 w-3.5 text-red-500 fill-red-500" />
          )}
        </div>

        {/* Bubble */}
        <div
          className={cn(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
            isPatient
              ? 'bg-blue-50 text-blue-950 dark:bg-blue-950/40 dark:text-blue-100 border border-blue-100 dark:border-blue-900/40'
              : 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100 border border-emerald-100 dark:border-emerald-900/40',
            message.is_golden_example && 'ring-2 ring-amber-400/50 ring-offset-1 dark:ring-offset-background'
          )}
        >
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>

        {/* Coaching note display */}
        {message.coaching_note && (
          <div className="flex items-start gap-1.5 px-2">
            <MessageSquarePlus className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400 italic">
              {message.coaching_note}
            </p>
          </div>
        )}

        {/* Timestamp */}
        <div className={cn('px-2 text-xs text-muted-foreground', isUser && 'text-right')}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>

        {/* Training Controls — appear on hover */}
        <div className={cn(
          'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity px-1',
          isUser && 'flex-row-reverse'
        )}>
          {/* Star as golden example */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 w-7 p-0',
              message.is_golden_example && 'text-amber-500 hover:text-amber-600'
            )}
            onClick={() => onToggleGolden(index)}
            title={message.is_golden_example ? 'Unmark golden example' : 'Mark as golden example'}
          >
            <Star className={cn('h-3.5 w-3.5', message.is_golden_example && 'fill-current')} />
          </Button>

          {/* Thumbs up */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 w-7 p-0',
              message.rating === 'good' && 'text-green-500 hover:text-green-600'
            )}
            onClick={() => onRate(index, message.rating === 'good' ? null : 'good')}
            title="Good response"
          >
            <ThumbsUp className={cn('h-3.5 w-3.5', message.rating === 'good' && 'fill-current')} />
          </Button>

          {/* Thumbs down */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 w-7 p-0',
              message.rating === 'bad' && 'text-red-500 hover:text-red-600'
            )}
            onClick={() => onRate(index, message.rating === 'bad' ? null : 'bad')}
            title="Bad response"
          >
            <ThumbsDown className={cn('h-3.5 w-3.5', message.rating === 'bad' && 'fill-current')} />
          </Button>

          {/* Add coaching note */}
          <Popover open={noteOpen} onOpenChange={setNoteOpen}>
            <PopoverTrigger
              className={cn(
                'inline-flex items-center justify-center h-7 w-7 p-0 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer',
                message.coaching_note && 'text-amber-500 hover:text-amber-600'
              )}
              title="Add coaching note"
            >
              <MessageSquarePlus className={cn('h-3.5 w-3.5', message.coaching_note && 'fill-current')} />
            </PopoverTrigger>
            <PopoverContent className="w-72" side="top">
              <div className="space-y-2">
                <p className="text-xs font-medium">Coaching Note</p>
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note about this exchange..."
                  rows={3}
                  className="text-xs resize-none"
                />
                <div className="flex gap-2 justify-end">
                  {message.coaching_note && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => {
                        onAddNote(index, '')
                        setNoteText('')
                        setNoteOpen(false)
                      }}
                    >
                      Remove
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => {
                      if (noteText.trim()) {
                        onAddNote(index, noteText.trim())
                      }
                      setNoteOpen(false)
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
