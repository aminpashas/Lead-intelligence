'use client'

import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  User, MapPin, Heart, BarChart3, Globe, DollarSign, Calendar, BracesIcon,
} from 'lucide-react'
import { TEMPLATE_VARIABLES, VARIABLE_CATEGORIES } from '@/lib/campaigns/personalization'
import { cn } from '@/lib/utils'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  identity: <User className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  location: <MapPin className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  clinical: <Heart className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  pipeline: <BarChart3 className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  source: <Globe className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  financial: <DollarSign className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
  scheduling: <Calendar className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />,
}

interface VariablePickerProps {
  onInsert: (variable: string) => void
  /** Label shown on the trigger button */
  label?: string
}

export function VariablePicker({ onInsert, label = 'Insert Variable' }: VariablePickerProps) {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string>('identity')

  const filteredVars = TEMPLATE_VARIABLES.filter((v) => v.category === activeCategory)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 text-[11px] font-medium rounded-md border border-aurea-border bg-aurea-surface text-aurea-ink-2 hover:bg-aurea-surface-2 hover:text-aurea-ink transition-colors cursor-pointer">
          <BracesIcon className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
          {label}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-3 border-b border-aurea-border">
          <p className="text-[13px] font-medium text-aurea-ink">Personalization Variables</p>
          <p className="text-[11px] text-aurea-ink-3 mt-0.5">
            Click a variable to insert it into your message
          </p>
        </div>

        {/* Category tabs */}
        <div className="flex flex-wrap gap-1 p-2 border-b border-aurea-border bg-aurea-surface-2">
          {VARIABLE_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              className={cn(
                'inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded transition-colors',
                activeCategory === cat.id
                  ? 'bg-aurea-surface border border-aurea-border-strong text-aurea-ink font-semibold'
                  : 'text-aurea-ink-3 hover:text-aurea-ink-2 hover:bg-aurea-surface'
              )}
              onClick={() => setActiveCategory(cat.id)}
            >
              {CATEGORY_ICONS[cat.id]}
              {cat.label}
            </button>
          ))}
        </div>

        {/* Variables list */}
        <div className="p-2 max-h-52 overflow-y-auto space-y-1">
          {filteredVars.map((v) => (
            <button
              key={v.var}
              onClick={() => {
                onInsert(v.var)
                setOpen(false)
              }}
              className="w-full flex items-center justify-between p-2 rounded-md hover:bg-aurea-surface-2 transition-colors text-left"
            >
              <div>
                <p className="text-[12px] font-medium text-aurea-ink">{v.label}</p>
                <code className="text-[10px] text-aurea-ink-3 font-mono">{v.var}</code>
              </div>
              <span className="font-mono text-[9px] tabular-nums text-aurea-ink-3 border border-aurea-border rounded px-1.5 py-0.5 shrink-0">
                {v.example}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
