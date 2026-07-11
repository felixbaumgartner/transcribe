import { useEffect, useState } from 'react'
import type { QueuedChunks, WorkerStatus } from '../../../preload/index'

interface Props {
  recording: boolean
  pendingChunks: QueuedChunks
  onStart: () => void
  onStop: () => void
  status: WorkerStatus | null
  /** Whole-percent progress of an in-flight model download, or null when idle. */
  downloadPct: number | null
  onDownloadModel: () => void
}

export function Recorder({
  recording,
  pendingChunks,
  onStart,
  onStop,
  status,
  downloadPct,
  onDownloadModel
}: Props): JSX.Element {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!recording) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(t)
  }, [recording])

  const ready = status?.binary && status?.model
  const modelMissing = status !== null && status.binary && !status.model
  const downloading = downloadPct !== null
  const queued = pendingChunks.you + pendingChunks.others

  return (
    <div className="flex items-center justify-between border-b border-zinc-800/70 px-6 py-5">
      <div className="flex items-center gap-5">
        {/* Record / stop button */}
        <div className="relative flex h-16 w-16 items-center justify-center">
          {recording ? (
            <>
              <span className="absolute inline-flex h-14 w-14 animate-ping rounded-full bg-red-500/25" />
              <button
                onClick={onStop}
                aria-label="Stop recording"
                className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-b from-red-500 to-red-600 shadow-lg shadow-red-950/60 ring-1 ring-red-400/40 transition-transform hover:scale-105 active:scale-95"
              >
                <span className="block h-4.5 w-4.5 rounded-[4px] bg-white" />
              </button>
            </>
          ) : (
            <>
              {ready && <span className="record-glow absolute inline-flex h-14 w-14 rounded-full bg-emerald-500/20 blur-md" />}
              <button
                onClick={onStart}
                disabled={!ready}
                aria-label="Start recording"
                className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-950/60 ring-1 ring-emerald-300/40 transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
              >
                <MicIcon />
              </button>
            </>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-semibold tracking-tight">
              {recording
                ? formatElapsed(elapsed)
                : ready
                  ? 'Ready to record'
                  : downloading
                    ? `Downloading model… ${downloadPct}%`
                    : modelMissing
                      ? 'Speech model needed'
                      : 'Setup needed'}
            </span>
            {status && (
              <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {status.modelName}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {recording
              ? queued > 0
                ? `Transcribing · ${queued} chunk${queued === 1 ? '' : 's'} in flight`
                : 'Listening — system audio + microphone'
              : ready
                ? 'Captures the meeting and your mic. Everything stays on this machine.'
                : downloading
                  ? 'One-time download, stored locally and reused.'
                  : modelMissing
                    ? `Whisper needs the ${status?.modelName} model (~500 MB) to transcribe.`
                    : 'Run npm run fetch-whisper to install the whisper binary.'}
          </div>
          {downloading && (
            <div className="mt-2 h-1.5 w-72 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-300"
                style={{ width: `${downloadPct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {recording ? (
        <div className="flex items-center gap-3 rounded-full border border-red-900/40 bg-red-950/30 px-4 py-2">
          <Equalizer />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-red-300">Live</span>
        </div>
      ) : (
        modelMissing &&
        !downloading && (
          <button
            onClick={onDownloadModel}
            className="rounded-lg bg-gradient-to-b from-emerald-400 to-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-950/50 ring-1 ring-emerald-300/40 transition-transform hover:scale-[1.03] active:scale-95"
          >
            Download model
          </button>
        )
      )}
    </div>
  )
}

function Equalizer(): JSX.Element {
  const bars = [
    { delay: '0ms', duration: '820ms' },
    { delay: '160ms', duration: '640ms' },
    { delay: '60ms', duration: '980ms' },
    { delay: '300ms', duration: '720ms' },
    { delay: '220ms', duration: '880ms' }
  ]
  return (
    <div className="flex h-4 items-end gap-[3px]" aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="eq-bar h-full w-[3px] rounded-full bg-red-400"
          style={{ animationDelay: b.delay, animationDuration: b.duration }}
        />
      ))}
    </div>
  )
}

function MicIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  )
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}
