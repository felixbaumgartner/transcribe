import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ModelDownloadProgress,
  RefineStatusEvent,
  Segment,
  Speaker,
  TranscriptListItem,
  TranscribeChunkResult,
  WorkerStatus
} from '../shared/transcript'

export type {
  ModelDownloadProgress,
  QueuedChunks,
  RefineStatusEvent,
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
    source: Speaker,
    prompt?: string
  ): Promise<TranscribeChunkResult> {
    return ipcRenderer.invoke('transcribe:chunk', { id, pcm, sampleRate, source, prompt })
  },
  saveTranscript(startedAt: string, segments: Segment[]): Promise<string> {
    return ipcRenderer.invoke('storage:save', { startedAt, segments })
  },
  autosaveTranscript(startedAt: string, segments: Segment[]): Promise<string> {
    return ipcRenderer.invoke('storage:autosave', { startedAt, segments })
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
  },
  warmupWhisper(): Promise<void> {
    return ipcRenderer.invoke('worker:warmup')
  },
  downloadModel(): Promise<string> {
    return ipcRenderer.invoke('model:download')
  },
  onModelDownloadProgress(cb: (p: ModelDownloadProgress) => void): () => void {
    const listener = (_evt: IpcRendererEvent, p: ModelDownloadProgress): void => cb(p)
    ipcRenderer.on('model:download-progress', listener)
    return () => {
      ipcRenderer.removeListener('model:download-progress', listener)
    }
  },
  appendSessionAudio(startedAt: string, source: Speaker, pcm: ArrayBuffer): Promise<void> {
    return ipcRenderer.invoke('session:append', { startedAt, source, pcm })
  },
  finalizeSession(startedAt: string): Promise<void> {
    return ipcRenderer.invoke('session:finalize', startedAt)
  },
  discardSession(startedAt: string): Promise<void> {
    return ipcRenderer.invoke('session:discard', startedAt)
  },
  refineTranscript(startedAt: string): Promise<void> {
    return ipcRenderer.invoke('session:refine', startedAt)
  },
  onRefineStatus(cb: (s: RefineStatusEvent) => void): () => void {
    const listener = (_evt: IpcRendererEvent, s: RefineStatusEvent): void => cb(s)
    ipcRenderer.on('refine:status', listener)
    return () => {
      ipcRenderer.removeListener('refine:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
