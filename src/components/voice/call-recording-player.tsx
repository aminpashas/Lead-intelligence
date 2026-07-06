'use client'

import { useRef, useState, useCallback } from 'react'
import { Play, Pause, Loader2, AlertCircle, Download } from 'lucide-react'

// ═══════════════════════════════════════════════════════════════
// CALL RECORDING PLAYER — inline audio transport for call recordings.
// Replaces the old "open recording in a new tab" link so staff can
// scrub and listen to a call without leaving the log.
//
// Retell recording URLs are directly fetchable by the browser (the
// old <a href> relied on the same fact), so <audio src> needs no
// proxy. If the media fails to load we fall back to a plain open-in-
// new-tab link so the recording is never unreachable.
// ═══════════════════════════════════════════════════════════════

const SPEEDS = [1, 1.5, 2] as const

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function CallRecordingPlayer({
  url,
  size = 'default',
}: {
  url: string
  /** `compact` for dense surfaces (lead timeline / call cards). */
  size?: 'default' | 'compact'
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(0)

  const compact = size === 'compact'

  const toggle = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      setLoading(true)
      el.play().then(() => setLoading(false)).catch(() => {
        setLoading(false)
        setErrored(true)
      })
    } else {
      el.pause()
    }
  }, [])

  const seek = useCallback((clientX: number, track: HTMLDivElement) => {
    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration)) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    el.currentTime = ratio * el.duration
    setCurrent(el.currentTime)
  }, [])

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]
  }, [speedIdx])

  // ── Error fallback — keep the recording reachable ──
  if (errored) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-aurea-border bg-aurea-surface px-3 py-1.5 text-xs font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2"
      >
        <AlertCircle className="h-3 w-3" strokeWidth={1.75} />
        Open recording
      </a>
    )
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0
  const btnSize = compact ? 'h-7 w-7' : 'h-9 w-9'
  const iconSize = compact ? 'h-3 w-3' : 'h-4 w-4'

  return (
    <div
      className={`flex items-center gap-3 rounded-full border border-aurea-border bg-aurea-surface ${
        compact ? 'px-2 py-1.5' : 'px-3 py-2'
      }`}
    >
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        onError={() => setErrored(true)}
      />

      {/* Play / pause */}
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className={`flex shrink-0 items-center justify-center rounded-full bg-aurea-ink text-aurea-canvas transition-opacity hover:opacity-90 ${btnSize}`}
      >
        {loading ? (
          <Loader2 className={`${iconSize} animate-spin`} strokeWidth={2} />
        ) : playing ? (
          <Pause className={iconSize} strokeWidth={2} fill="currentColor" />
        ) : (
          <Play className={`${iconSize} translate-x-[1px]`} strokeWidth={2} fill="currentColor" />
        )}
      </button>

      {/* Scrubber */}
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
        onClick={(e) => seek(e.clientX, e.currentTarget)}
        onKeyDown={(e) => {
          const el = audioRef.current
          if (!el || !Number.isFinite(el.duration)) return
          if (e.key === 'ArrowRight') el.currentTime = Math.min(el.duration, el.currentTime + 5)
          if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5)
        }}
        className="group relative h-1.5 min-w-[80px] flex-1 cursor-pointer rounded-full bg-aurea-surface-2"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-aurea-ink"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-aurea-ink opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>

      {/* Time */}
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-aurea-ink-3">
        {fmt(current)} / {fmt(duration)}
      </span>

      {/* Speed */}
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label="Playback speed"
        className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink-2"
      >
        {SPEEDS[speedIdx]}×
      </button>

      {/* Download */}
      {!compact && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download recording"
          className="shrink-0 text-aurea-ink-3 transition-colors hover:text-aurea-ink-2"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
        </a>
      )}
    </div>
  )
}
