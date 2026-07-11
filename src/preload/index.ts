import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ModelDownloadProgress,
  Segment,
  Speaker,
  TranscriptListItem,
  TranscribeChunkResult,
  WorkerStatus
} from '../shared/transcript'

export type {
  ModelDownloadProgress,
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
  downloadModel(): Promise<string> {
    return ipcRenderer.invoke('model:download')
  },
  onModelDownloadProgress(cb: (p: ModelDownloadProgress) => void): () => void {
    const listener = (_evt: IpcRendererEvent, p: ModelDownloadProgress): void => cb(p)
    ipcRenderer.on('model:download-progress', listener)
    return () => {
      ipcRenderer.removeListener('model:download-progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
