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
  const pendingLabel = `you:${pendingChunks.you} others:${pendingChunks.others}`

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
            {recording
              ? 'Recording…'
              : ready
                ? 'Ready'
                : downloading
                  ? `Downloading ${status?.modelName ?? ''} model… ${downloadPct}%`
                  : modelMissing
                    ? 'Model needed'
                    : 'Setup needed'}
          </div>
          <div className="text-xs text-zinc-500">
            {recording
              ? `${formatElapsed(elapsed)} · ${pendingLabel}`
              : ready
                ? 'Captures system audio + your mic. Transcripts stay on your machine.'
                : downloading
                  ? 'One-time download. The model is stored locally and never re-downloaded.'
                  : modelMissing
                    ? `The ${status?.modelName} speech model (~500 MB) is required for transcription.`
                    : 'Run npm run fetch-whisper to install the whisper binary.'}
          </div>
          {downloading && (
            <div className="mt-2 h-1.5 w-64 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                style={{ width: `${downloadPct}%` }}
              />
            </div>
          )}
        </div>
      </div>
      {!recording && modelMissing && !downloading && (
        <button
          onClick={onDownloadModel}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Download model
        </button>
      )}
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
