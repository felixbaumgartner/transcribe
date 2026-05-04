import { useEffect, useState } from 'react'
import type { WorkerStatus } from '../../../preload/index'

interface Props {
  recording: boolean
  pendingChunks: number
  onStart: () => void
  onStop: () => void
  status: WorkerStatus | null
}

export function Recorder({ recording, pendingChunks, onStart, onStop, status }: Props): JSX.Element {
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

  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-5">
      <div className="flex items-center gap-4">
        {recording ? (
          <button
            onClick={onStop}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500"
            aria-label="Stop"
          >
            <span className="block h-4 w-4 rounded-sm bg-white" />
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={!ready}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Start recording"
          >
            <span className="block h-4 w-4 rounded-full bg-white" />
          </button>
        )}
        <div>
          <div className="text-sm font-medium">
            {recording ? 'Recording…' : ready ? 'Ready' : 'Setup needed'}
          </div>
          <div className="text-xs text-zinc-500">
            {recording
              ? `${formatElapsed(elapsed)} · ${pendingChunks} chunks pending`
              : ready
                ? 'Captures system audio + your mic. Transcripts stay on your machine.'
                : 'Run npm run fetch-whisper && npm run fetch-model'}
          </div>
        </div>
      </div>
      {recording && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          live
        </div>
      )}
    </div>
  )
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}
