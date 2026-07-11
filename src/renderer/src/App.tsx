import { useCallback, useEffect, useRef, useState } from 'react'
import { Recorder } from './components/Recorder'
import { LiveTranscript } from './components/LiveTranscript'
import { History } from './components/History'
import { startCapture, type CaptureHandle, type ChunkMessage } from './audio-capture'
import { buildPrompt, mergeSegments } from './segments'
import type { Segment, TranscriptListItem, WorkerStatus, QueuedChunks } from '../../preload/index'

type View = 'live' | 'history'

const EMPTY_PENDING: QueuedChunks = { you: 0, others: 0 }
const AUTOSAVE_DEBOUNCE_MS = 2500

export function App(): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const [pendingChunks, setPendingChunks] = useState<QueuedChunks>(EMPTY_PENDING)
  const [view, setView] = useState<View>('live')
  const [history, setHistory] = useState<TranscriptListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [viewingFile, setViewingFile] = useState<{ name: string; body: string } | null>(null)
  const [micAvailable, setMicAvailable] = useState(true)
  const captureRef = useRef<CaptureHandle | null>(null)
  const pendingChunksRef = useRef<QueuedChunks>({ ...EMPTY_PENDING })
  const sessionIdRef = useRef(0)
  const autosaveTimerRef = useRef<number | null>(null)

  const refreshHistory = useCallback(async () => {
    setHistory(await window.api.listTranscripts())
  }, [])

  useEffect(() => {
    window.api.workerStatus().then(setStatus).catch(() => setStatus(null))
    refreshHistory()
  }, [refreshHistory])

  // Post-stop refinement status chip: running → done (auto-hides) / error.
  const [refineState, setRefineState] = useState<'running' | 'done' | 'error' | null>(null)
  useEffect(
    () =>
      window.api.onRefineStatus((s) => {
        setRefineState(s.state)
        if (s.state === 'done') {
          refreshHistory()
          setTimeout(() => setRefineState((cur) => (cur === 'done' ? null : cur)), 6000)
        }
      }),
    [refreshHistory]
  )

  // In-app model download (packaged users have no npm to run fetch scripts).
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  useEffect(() => window.api.onModelDownloadProgress((p) => setDownloadPct(p.pct)), [])
  const handleDownloadModel = useCallback(async () => {
    setError(null)
    setDownloadPct(0)
    try {
      await window.api.downloadModel()
      setStatus(await window.api.workerStatus())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Model download failed: ${msg}`)
    } finally {
      setDownloadPct(null)
    }
  }, [])

  const handleChunk = useCallback(async (chunk: ChunkMessage, sessionId: number) => {
    if (sessionId !== sessionIdRef.current) return
    pendingChunksRef.current = {
      ...pendingChunksRef.current,
      [chunk.source]: pendingChunksRef.current[chunk.source] + 1
    }
    setPendingChunks((p) => ({ ...p, [chunk.source]: p[chunk.source] + 1 }))
    try {
      const { segments: segs } = await window.api.transcribeChunk(
        chunk.id,
        chunk.pcm,
        chunk.sampleRate,
        chunk.source,
        // Condition whisper on the conversation so far — better punctuation,
        // casing, and boundary words than decoding each chunk blind.
        buildPrompt(segmentsRef.current)
      )
      // Chunks are variable-length (cut at silence), so alignment uses the
      // chunk's absolute start time rather than id arithmetic.
      const offset = chunk.startSeconds
      const adjusted = segs.map((s) => ({
        ...s,
        t0: s.t0 + offset,
        t1: s.t1 + offset,
        speaker: s.speaker ?? chunk.source
      }))
      if (sessionId !== sessionIdRef.current) return
      setSegments((prev) => mergeSegments(prev, adjusted))
      // A backlog warning is transient — clear it once chunks flow again.
      setError((prev) => (prev && prev.includes('falling behind') ? null : prev))
    } catch (err: unknown) {
      if (sessionId !== sessionIdRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      if (sessionId !== sessionIdRef.current) return
      pendingChunksRef.current = {
        ...pendingChunksRef.current,
        [chunk.source]: Math.max(0, pendingChunksRef.current[chunk.source] - 1)
      }
      setPendingChunks((p) => ({ ...p, [chunk.source]: Math.max(0, p[chunk.source] - 1) }))
    }
  }, [])

  const handleStart = useCallback(async () => {
    const sessionId = sessionIdRef.current + 1
    sessionIdRef.current = sessionId
    setError(null)
    setSegments([])
    setPendingChunks(EMPTY_PENDING)
    pendingChunksRef.current = { ...EMPTY_PENDING }

    // Verify whisper assets exist before we start capturing — easier to surface the issue
    const s = await window.api.workerStatus()
    setStatus(s)
    if (!s.binary) {
      setError(`whisper binary not found.\n\nRun: npm run fetch-whisper\n\nExpected at: ${s.binaryPath}`)
      return
    }
    if (!s.model) {
      setError(`Model not found. Use the "Download model" button to fetch it.\n\nExpected at: ${s.modelPath}`)
      return
    }

    // Start loading the model now, while the user is in the screen picker —
    // otherwise the first ~10-15s of speech queues up behind the model load.
    window.api.warmupWhisper().catch(() => {})

    try {
      const handle = await startCapture(
        (chunk) => handleChunk(chunk, sessionId),
        // Raw session audio spools to disk for the post-stop refinement pass.
        (raw) => {
          window.api.appendSessionAudio(raw.startedAtIso, raw.source, raw.pcm).catch(() => {})
        }
      )
      if (sessionId !== sessionIdRef.current) {
        await handle.stop()
        return
      }
      captureRef.current = handle
      setMicAvailable(handle.micAvailable)
      setRecording(true)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }, [handleChunk])

  const handleStop = useCallback(async () => {
    const sessionId = sessionIdRef.current
    const handle = captureRef.current
    if (!handle) return
    // Cancel any pending autosave so it can't recreate the .partial file after
    // the final save deletes it.
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    await handle.stop()
    if (sessionId !== sessionIdRef.current) return
    captureRef.current = null
    setRecording(false)

    // Drain any in-flight chunks before saving, so the tail flushed at stop-time
    // makes it into the saved file. Uses a ref so we don't depend on stale React state.
    const t0 = Date.now()
    while (
      sessionId === sessionIdRef.current &&
      (pendingChunksRef.current.you > 0 || pendingChunksRef.current.others > 0) &&
      Date.now() - t0 < 60000
    ) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (sessionId !== sessionIdRef.current) return
    const stillPending = pendingChunksRef.current.you + pendingChunksRef.current.others
    if (stillPending > 0) {
      setError(`Stopped recording, but ${stillPending} chunk(s) are still transcribing. Try a smaller model if this keeps happening.`)
    }

    const startedAtIso = handle.startedAt.toISOString()
    await window.api.finalizeSession(startedAtIso).catch(() => {})

    const final = segmentsRef.current
    if (final.length === 0) {
      window.api.discardSession(startedAtIso).catch(() => {})
      setError('Recording stopped, but no transcribed segments were produced. Nothing to save.')
      return
    }
    try {
      await window.api.saveTranscript(startedAtIso, final)
      await refreshHistory()
      // Background pass re-transcribes the full audio with more context and a
      // more careful decode, then rewrites the file we just saved.
      window.api.refineTranscript(startedAtIso).catch(() => {})
    } catch (err) {
      window.api.discardSession(startedAtIso).catch(() => {})
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to save transcript: ${msg}`)
    }
  }, [refreshHistory])

  // Track latest segments in a ref so the save callback sees the up-to-date list
  const segmentsRef = useRef<Segment[]>([])
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  // Crash-safety autosave: while recording, persist the transcript-so-far to a
  // .partial file at most once per AUTOSAVE_DEBOUNCE_MS. If the app dies
  // mid-meeting, the main process recovers the partial on next launch.
  useEffect(() => {
    if (!recording || segments.length === 0) return
    const handle = captureRef.current
    if (!handle) return
    if (autosaveTimerRef.current !== null) return
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      window.api
        .autosaveTranscript(handle.startedAt.toISOString(), segmentsRef.current)
        .catch(() => {}) // Autosave is best-effort; the final save reports real errors.
    }, AUTOSAVE_DEBOUNCE_MS)
  }, [segments, recording])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800/70 px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-950/50 ring-1 ring-white/10">
            <LogoWave />
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight tracking-tight">Transcribe</div>
            <div className="text-[11px] leading-tight text-zinc-500">
              Local transcription — audio never leaves this machine
            </div>
          </div>
        </div>
        <nav className="flex gap-1 rounded-full border border-zinc-800/80 bg-zinc-900/70 p-1 text-xs">
          <button
            className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
              view === 'live'
                ? 'bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => { setView('live'); setViewingFile(null) }}
          >
            Live
          </button>
          <button
            className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
              view === 'history'
                ? 'bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => { setView('history'); refreshHistory() }}
          >
            History
          </button>
        </nav>
      </header>

      {error && (
        <div className="flex items-start gap-3 border-b border-rose-900/40 bg-rose-950/40 px-5 py-3 text-sm text-rose-200">
          <AlertIcon />
          <div className="flex-1 whitespace-pre-wrap">{error}</div>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-rose-400 transition-colors hover:text-rose-100"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {recording && !micAvailable && (
        <div className="border-b border-amber-900/40 bg-amber-950/30 px-5 py-2 text-xs text-amber-200">
          Microphone unavailable — everything will be labeled “Others”.
        </div>
      )}

      {refineState && (
        <div
          className={`flex items-center gap-2 border-b px-5 py-2 text-xs ${
            refineState === 'running'
              ? 'border-zinc-800/70 bg-zinc-900/50 text-zinc-400'
              : refineState === 'done'
                ? 'border-emerald-900/40 bg-emerald-950/30 text-emerald-300'
                : 'border-amber-900/40 bg-amber-950/30 text-amber-200'
          }`}
        >
          {refineState === 'running' && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-500" />
          )}
          {refineState === 'running'
            ? 'Polishing transcript in the background — the saved file will update when done.'
            : refineState === 'done'
              ? 'Transcript polished ✓ — the saved file now uses the full-context pass.'
              : 'Background polish failed — the fast live transcript was kept.'}
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
            downloadPct={downloadPct}
            onDownloadModel={handleDownloadModel}
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

function LogoWave(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="3" y1="7.5" x2="3" y2="10.5" />
      <line x1="6" y1="5.5" x2="6" y2="12.5" />
      <line x1="9" y1="3" x2="9" y2="15" />
      <line x1="12" y1="5.5" x2="12" y2="12.5" />
      <line x1="15" y1="7.5" x2="15" y2="10.5" />
    </svg>
  )
}

function AlertIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-rose-400" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
