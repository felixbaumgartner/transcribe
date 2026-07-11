export type Speaker = 'you' | 'others'

export interface Segment {
  t0: number
  t1: number
  text: string
  speaker?: Speaker
}

export interface TranscriptListItem {
  file: string
  name: string
  size: number
  mtime: string
}

export interface QueuedChunks {
  you: number
  others: number
}

export interface WorkerStatus {
  binary: boolean
  model: boolean
  binaryPath: string
  modelPath: string
  modelName: string
  serverBinary: boolean
  serverRunning: boolean
  queuedChunks: QueuedChunks
}

export interface ModelDownloadProgress {
  received: number
  total: number
  pct: number
}

export interface TranscribeChunkResult {
  source: Speaker
  segments: Segment[]
}

export interface TranscribeChunkPayload {
  id: number
  pcm: ArrayBuffer
  sampleRate: number
  source: Speaker
  /** Preceding transcript text used to condition the decoder. */
  prompt?: string
}

// Hard ceiling on conditioning text accepted over IPC; the renderer normally
// sends ~500 chars.
const MAX_PROMPT_LENGTH = 2000

export interface SaveTranscriptPayload {
  startedAt: string
  segments: Segment[]
}

export function isSpeaker(value: unknown): value is Speaker {
  return value === 'you' || value === 'others'
}

export function validateSegment(value: unknown): Segment {
  if (!isRecord(value)) throw new Error('Invalid transcript segment')
  const { t0, t1, text, speaker } = value
  if (
    typeof t0 !== 'number' ||
    typeof t1 !== 'number' ||
    !Number.isFinite(t0) ||
    !Number.isFinite(t1) ||
    t0 < 0 ||
    t1 < t0
  ) {
    throw new Error('Invalid transcript segment timestamps')
  }
  if (typeof text !== 'string') throw new Error('Invalid transcript segment text')
  if (speaker !== undefined && !isSpeaker(speaker)) {
    throw new Error('Invalid transcript segment speaker')
  }
  return { t0, t1, text, ...(speaker === undefined ? {} : { speaker }) }
}

export function validateSaveTranscriptPayload(value: unknown): SaveTranscriptPayload {
  if (!isRecord(value)) throw new Error('Invalid save payload')
  if (typeof value.startedAt !== 'string') throw new Error('Invalid transcript start time')
  if (!Array.isArray(value.segments)) throw new Error('Invalid transcript segments')
  return {
    startedAt: value.startedAt,
    segments: value.segments.map(validateSegment)
  }
}

export interface SessionAudioPayload {
  startedAt: string
  source: Speaker
  pcm: ArrayBuffer
}

export interface RefineStatusEvent {
  state: 'running' | 'done' | 'error'
  startedAt: string
  detail?: string
}

// Raw session appends arrive in ~1s batches (32 KB at 16 kHz); anything much
// larger is malformed.
const MAX_SESSION_APPEND_BYTES = 1024 * 1024

export function validateSessionAudioPayload(value: unknown): SessionAudioPayload {
  if (!isRecord(value)) throw new Error('Invalid session audio payload')
  const { startedAt, source, pcm } = value
  if (typeof startedAt !== 'string' || Number.isNaN(new Date(startedAt).getTime())) {
    throw new Error('Invalid session start time')
  }
  if (!isSpeaker(source)) throw new Error('Invalid source')
  if (!(pcm instanceof ArrayBuffer) || pcm.byteLength > MAX_SESSION_APPEND_BYTES) {
    throw new Error('Invalid session audio payload')
  }
  return { startedAt, source, pcm }
}

export function validateStartedAt(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new Error('Invalid session start time')
  }
  return value
}

export function validateTranscribeChunkPayload(value: unknown): TranscribeChunkPayload {
  if (!isRecord(value)) throw new Error('Invalid chunk payload')
  const { id, pcm, sampleRate, source, prompt } = value
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) throw new Error('Invalid chunk id')
  if (!(pcm instanceof ArrayBuffer)) throw new Error('Invalid chunk payload')
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid sample rate')
  if (!isSpeaker(source)) throw new Error('Invalid source')
  if (prompt !== undefined && typeof prompt !== 'string') throw new Error('Invalid prompt')
  const trimmedPrompt = prompt ? prompt.slice(-MAX_PROMPT_LENGTH) : undefined
  return { id, pcm, sampleRate, source, ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
