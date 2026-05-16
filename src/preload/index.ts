import { contextBridge, ipcRenderer } from 'electron'

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
  queuedChunks: QueuedChunks
}

export interface TranscribeChunkResult {
  source: Speaker
  segments: Segment[]
}

const api = {
  transcribeChunk(
    id: number,
    pcm: ArrayBuffer,
    sampleRate: number,
    source: Speaker
  ): Promise<TranscribeChunkResult> {
    return ipcRenderer.invoke('transcribe:chunk', { id, pcm, sampleRate, source })
  },
  saveTranscript(startedAt: string, segments: Segment[]): Promise<string> {
    return ipcRenderer.invoke('storage:save', { startedAt, segments })
  },
  listTranscripts(): Promise<TranscriptListItem[]> {
    return ipcRenderer.invoke('storage:list')
  },
  readTranscript(file: string): Promise<string> {
    return ipcRenderer.invoke('storage:read', file)
  },
  openTranscriptsFolder(): Promise<void> {
    return ipcRenderer.invoke('storage:open-folder')
  },
  workerStatus(): Promise<WorkerStatus> {
    return ipcRenderer.invoke('worker:status')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
