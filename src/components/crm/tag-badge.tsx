'use client'

import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import type { Tag } from '@/types/database'

interface TagBadgeProps {
  tag: Tag
  onRemove?: () => void
  compact?: boolean
  className?: string
}

export function TagBadge({ tag, onRemove, compact, className }: TagBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        'bg-aurea-surface border-aurea-border text-aurea-ink-2 hover:bg-aurea-surface-2',
        className
      )}
    >
      <span
        className={cn('rounded-full shrink-0', compact ? 'h-1.5 w-1.5' : 'h-2 w-2')}
        style={{ backgroundColor: tag.color }}
      />
      <span className="truncate max-w-[120px]">{tag.name}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 rounded-full p-0.5 hover:bg-aurea-rose/10 hover:text-aurea-rose transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

// Renders a list of tag badges with overflow handling
export function TagBadgeList({
  tags,
  maxVisible = 3,
  compact,
  onRemove,
}: {
  tags: Tag[]
  maxVisible?: number
  compact?: boolean
  onRemove?: (tagId: string) => void
}) {
  const visible = tags.slice(0, maxVisible)
  const overflow = tags.length - maxVisible

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((tag) => (
        <TagBadge
          key={tag.id}
          tag={tag}
          compact={compact}
          onRemove={onRemove ? () => onRemove(tag.id) : undefined}
        />
      ))}
      {overflow > 0 && (
        <span className={cn(
          'inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface-2 font-medium text-aurea-ink-3',
          compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
        )}>
          +{overflow}
        </span>
      )}
    </div>
  )
}
