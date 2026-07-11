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
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/50 shadow-inner">
          <WaveIcon />
        </div>
        <div>
          <div className="text-sm font-medium text-zinc-300">Nothing here yet</div>
          <div className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-600">
            Hit record and the conversation will appear here, a few words behind the speakers.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="transcript-text flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {segments.map((s, i) => {
          const isYou = s.speaker === 'you'
          return (
            <div
              key={`${s.speaker ?? 'x'}-${s.t0.toFixed(2)}-${i}`}
              className={`seg-enter flex flex-col ${isYou ? 'items-end' : 'items-start'}`}
            >
              <div className="mb-1 flex items-baseline gap-2 px-1">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-widest ${
                    isYou ? 'text-emerald-400' : 'text-zinc-400'
                  }`}
                >
                  {isYou ? 'You' : s.speaker === 'others' ? 'Others' : ''}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">{fmt(s.t0)}</span>
              </div>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                  isYou
                    ? 'rounded-br-md bg-emerald-500/10 text-emerald-50 ring-1 ring-emerald-500/25'
                    : 'rounded-bl-md bg-zinc-800/70 text-zinc-100 ring-1 ring-zinc-700/60'
                }`}
              >
                {s.text.trim()}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WaveIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-zinc-600" aria-hidden>
      <line x1="4" y1="10" x2="4" y2="14" />
      <line x1="8" y1="7" x2="8" y2="17" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="16" y1="7" x2="16" y2="17" />
      <line x1="20" y1="10" x2="20" y2="14" />
    </svg>
  )
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
