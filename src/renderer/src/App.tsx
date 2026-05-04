import { useCallback, useEffect, useRef, useState } from 'react'
import { Recorder } from './components/Recorder'
import { LiveTranscript } from './components/LiveTranscript'
import { History } from './components/History'
import { startCapture, type CaptureHandle, type ChunkMessage } from './audio-capture'
import type { Segment, TranscriptListItem, WorkerStatus } from '../../preload/index'

type View = 'live' | 'history'

export function App(): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const [pendingChunks, setPendingChunks] = useState(0)
  const [view, setView] = useState<View>('live')
  const [history, setHistory] = useState<TranscriptListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [viewingFile, setViewingFile] = useState<{ name: string; body: string } | null>(null)
  const captureRef = useRef<CaptureHandle | null>(null)

  // Stable elapsed-seconds offset per chunk so segment timestamps line up across chunks
  const chunkOffsetRef = useRef<Record<number, number>>({})
  const chunkSecondsRef = useRef(28) // 30s chunk - 2s overlap

  const refreshHistory = useCallback(async () => {
    setHistory(await window.api.listTranscripts())
  }, [])

  useEffect(() => {
    window.api.workerStatus().then(setStatus).catch(() => setStatus(null))
    refreshHistory()
  }, [refreshHistory])

  const handleChunk = useCallback(async (chunk: ChunkMessage) => {
    setPendingChunks((n) => n + 1)
    // Record the absolute time offset for this chunk (in elapsed seconds since recording started)
    chunkOffsetRef.current[chunk.id] = chunk.id * chunkSecondsRef.current
    try {
      const segs = await window.api.transcribeChunk(chunk.id, chunk.pcm, chunk.sampleRate)
      const offset = chunkOffsetRef.current[chunk.id] ?? 0
      const adjusted = segs.map((s) => ({ ...s, t0: s.t0 + offset, t1: s.t1 + offset }))
      setSegments((prev) => mergeSegments(prev, adjusted))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setPendingChunks((n) => n - 1)
    }
  }, [])

  const handleStart = useCallback(async () => {
    setError(null)
    setSegments([])
    chunkOffsetRef.current = {}

    // Verify whisper assets exist before we start capturing — easier to surface the issue
    const s = await window.api.workerStatus()
    setStatus(s)
    if (!s.binary) {
      setError(`whisper binary not found.\n\nRun: npm run fetch-whisper\n\nExpected at: ${s.binaryPath}`)
      return
    }
    if (!s.model) {
      setError(`Model not found.\n\nRun: npm run fetch-model\n\nExpected at: ${s.modelPath}`)
      return
    }

    try {
      captureRef.current = await startCapture(handleChunk)
      setRecording(true)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }, [handleChunk])

  const handleStop = useCallback(async () => {
    const handle = captureRef.current
    if (!handle) return
    await handle.stop()
    captureRef.current = null
    setRecording(false)
    // Wait a tick for any in-flight chunks before saving
    setTimeout(async () => {
      const final = segmentsRef.current
      if (final.length > 0) {
        try {
          await window.api.saveTranscript(handle.startedAt.toISOString(), final)
          await refreshHistory()
        } catch (err) {
          console.error('Failed to save transcript', err)
        }
      }
    }, 200)
  }, [refreshHistory])

  // Track latest segments in a ref so the save callback sees the up-to-date list
  const segmentsRef = useRef<Segment[]>([])
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold tracking-tight">Transcribe</span>
          <span className="text-xs text-zinc-500">Local · No cloud</span>
        </div>
        <nav className="flex gap-1 rounded-md bg-zinc-900 p-1 text-xs">
          <button
            className={`rounded px-3 py-1 ${view === 'live' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            onClick={() => { setView('live'); setViewingFile(null) }}
          >
            Live
          </button>
          <button
            className={`rounded px-3 py-1 ${view === 'history' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            onClick={() => { setView('history'); refreshHistory() }}
          >
            History
          </button>
        </nav>
      </header>

      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-5 py-3 text-sm text-red-200 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {view === 'live' ? (
        <div className="flex flex-1 flex-col">
          <Recorder
            recording={recording}
            pendingChunks={pendingChunks}
            onStart={handleStart}
            onStop={handleStop}
            status={status}
          />
          <LiveTranscript segments={segments} />
        </div>
      ) : (
        <History
          items={history}
          onRefresh={refreshHistory}
          onOpen={async (file) => {
            const body = await window.api.readTranscript(file.file)
            setViewingFile({ name: file.name, body })
          }}
          onOpenFolder={() => window.api.openTranscriptsFolder()}
          viewing={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}
    </div>
  )
}

/**
 * Merge new segments from a chunk into the running list.
 * Because consecutive chunks overlap by ~2s, we de-dup by checking if a new
 * segment's text already appears at the tail of the existing list.
 */
function mergeSegments(prev: Segment[], next: Segment[]): Segment[] {
  if (prev.length === 0) return next
  if (next.length === 0) return prev
  const tailWindow = prev.slice(-3).map((s) => s.text.trim()).join(' ')
  const filtered = next.filter((s) => !tailWindow.includes(s.text.trim()))
  return [...prev, ...filtered]
}
