'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  identity: <User className="h-3 w-3" />,
  location: <MapPin className="h-3 w-3" />,
  clinical: <Heart className="h-3 w-3" />,
  pipeline: <BarChart3 className="h-3 w-3" />,
  source: <Globe className="h-3 w-3" />,
  financial: <DollarSign className="h-3 w-3" />,
  scheduling: <Calendar className="h-3 w-3" />,
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
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer">
          <BracesIcon className="h-3 w-3" />
          {label}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-3 border-b">
          <p className="text-sm font-medium">Personalization Variables</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Click a variable to insert it into your message
          </p>
        </div>

        {/* Category tabs */}
        <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/30">
          {VARIABLE_CATEGORIES.map((cat) => (
            <Button
              key={cat.id}
              variant={activeCategory === cat.id ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-6 text-[10px] px-2 gap-1',
                activeCategory === cat.id && 'font-semibold'
              )}
              onClick={() => setActiveCategory(cat.id)}
            >
              {CATEGORY_ICONS[cat.id]}
              {cat.label}
            </Button>
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
              className="w-full flex items-center justify-between p-2 rounded-md hover:bg-accent/50 transition-colors text-left"
            >
              <div>
                <p className="text-xs font-medium">{v.label}</p>
                <code className="text-[10px] text-muted-foreground font-mono">{v.var}</code>
              </div>
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 shrink-0">
                {v.example}
              </Badge>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
