import { contextBridge, ipcRenderer } from 'electron'
import type {
  Segment,
  Speaker,
  TranscriptListItem,
  TranscribeChunkResult,
  WorkerStatus
} from '../shared/transcript'

export type {
  QueuedChunks,
  Segment,
  Speaker,
  TranscriptListItem,
  TranscribeChunkResult,
  WorkerStatus
} from '../shared/transcript'

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
