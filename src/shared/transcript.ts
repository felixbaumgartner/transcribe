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
}

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

export function validateTranscribeChunkPayload(value: unknown): TranscribeChunkPayload {
  if (!isRecord(value)) throw new Error('Invalid chunk payload')
  const { id, pcm, sampleRate, source } = value
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) throw new Error('Invalid chunk id')
  if (!(pcm instanceof ArrayBuffer)) throw new Error('Invalid chunk payload')
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid sample rate')
  if (!isSpeaker(source)) throw new Error('Invalid source')
  return { id, pcm, sampleRate, source }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
