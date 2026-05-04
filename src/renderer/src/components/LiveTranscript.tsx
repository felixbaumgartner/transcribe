import { useEffect, useRef } from 'react'
import type { Segment } from '../../../preload/index'

interface Props {
  segments: Segment[]
}

export function LiveTranscript({ segments }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Auto-scroll only if user is already near the bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [segments])

  if (segments.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
        Press record to start. Transcripts appear here.
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="transcript-text flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-3">
        {segments.map((s, i) => (
          <div key={i} className="leading-relaxed">
            <span className="mr-2 select-none font-mono text-xs text-zinc-600">
              {fmt(s.t0)}
            </span>
            <span className="text-zinc-100">{s.text.trim()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
