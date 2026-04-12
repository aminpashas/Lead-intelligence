'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

interface SliderProps {
  className?: string
  value?: number[]
  defaultValue?: number[]
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onValueChange?: (value: number[]) => void
  onValueCommit?: (value: number[]) => void
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  ({ className, value: controlledValue, defaultValue = [50], min = 0, max = 100, step = 1, disabled, onValueChange, onValueCommit }, ref) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue)
    const value = controlledValue ?? internalValue
    const trackRef = React.useRef<HTMLDivElement>(null)
    const isDragging = React.useRef(false)

    const percentage = ((value[0] - min) / (max - min)) * 100

    function getValueFromPosition(clientX: number) {
      if (!trackRef.current) return value[0]
      const rect = trackRef.current.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const raw = min + pct * (max - min)
      return Math.round(raw / step) * step
    }

    function handlePointerDown(e: React.PointerEvent) {
      if (disabled) return
      e.preventDefault()
      isDragging.current = true
      const newVal = [getValueFromPosition(e.clientX)]
      setInternalValue(newVal)
      onValueChange?.(newVal)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }

    function handlePointerMove(e: React.PointerEvent) {
      if (!isDragging.current || disabled) return
      const newVal = [getValueFromPosition(e.clientX)]
      setInternalValue(newVal)
      onValueChange?.(newVal)
    }

    function handlePointerUp() {
      if (isDragging.current) {
        isDragging.current = false
        onValueCommit?.(controlledValue ?? internalValue)
      }
    }

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex w-full touch-none select-none items-center',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        <div
          ref={trackRef}
          className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary cursor-pointer"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div
            className="absolute h-full bg-primary rounded-full transition-[width] duration-75"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div
          className={cn(
            'absolute block h-5 w-5 rounded-full border-2 border-primary bg-background shadow-md ring-offset-background transition-[left] duration-75',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
          )}
          style={{ left: `calc(${percentage}% - 10px)` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          tabIndex={disabled ? -1 : 0}
          role="slider"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value[0]}
        />
      </div>
    )
  }
)
Slider.displayName = 'Slider'

export { Slider }
