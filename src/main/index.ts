import { app, BrowserWindow, ipcMain, shell, session } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  writeMarkdownTranscript,
  autosaveTranscript,
  recoverPartialTranscripts,
  listTranscripts,
  readTranscript,
  transcriptsDir
} from './storage.js'
import { TranscribeWorker, whisperBinaryPath } from './transcribe-worker.js'
import { downloadModel, ensureVadModel, modelPath } from './model.js'
import { SessionAudioStore, refineSession } from './refine.js'
import { transcriptFileName } from './transcript-render.js'
import {
  validateSaveTranscriptPayload,
  validateSessionAudioPayload,
  validateStartedAt,
  validateTranscribeChunkPayload,
  type RefineStatusEvent
} from '../shared/transcript.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow: BrowserWindow | null = null
let worker: TranscribeWorker | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0c11',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox must be false for ESM preload (.mjs with import statements) on
      // Electron 28+. contextIsolation: true still keeps the renderer in its own
      // context with no Node access — which is the security property we care about
      // for a local-only app.
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.transcribe.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Auto-grant media + display capture permissions for our own window.
  // We can do this safely because we control the renderer code.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (wc === mainWindow?.webContents && (permission === 'media' || permission === 'display-capture')) {
      callback(true)
      return
    }
    callback(false)
  })

  // System audio capture: tell Electron to deliver the OS audio loopback as the
  // audio track for any getDisplayMedia call. We satisfy the API's requirement
  // that the *video* field be a real DesktopCapturerSource by handing back the
  // primary screen — but the renderer drops the video tracks immediately, so
  // nothing is actually recorded from the screen. This works on macOS 13+
  // (ScreenCaptureKit) and Windows (WASAPI loopback).
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const { desktopCapturer } = await import('electron')
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    if (sources.length === 0) {
      callback({})
      return
    }
    callback({ video: sources[0], audio: 'loopback' })
  })

  // Promote transcripts orphaned by a crash before the renderer lists history.
  recoverPartialTranscripts().catch((err) => {
    console.warn('Failed to recover partial transcripts:', err)
  })

  worker = new TranscribeWorker()

  ipcMain.handle('transcribe:chunk', async (_evt, rawPayload: unknown) => {
    const payload = validateTranscribeChunkPayload(rawPayload)
    return await worker!.transcribeChunk(
      payload.id,
      Buffer.from(payload.pcm),
      payload.sampleRate,
      payload.source,
      payload.prompt
    )
  })

  ipcMain.handle('storage:save', async (_evt, rawPayload: unknown) => {
    const payload = validateSaveTranscriptPayload(rawPayload)
    const file = await writeMarkdownTranscript(payload.startedAt, payload.segments)
    return file
  })

  ipcMain.handle('storage:autosave', async (_evt, rawPayload: unknown) => {
    const payload = validateSaveTranscriptPayload(rawPayload)
    return await autosaveTranscript(payload.startedAt, payload.segments)
  })

  ipcMain.handle('storage:list', async () => listTranscripts())
  ipcMain.handle('storage:read', async (_evt, file: string) => readTranscript(file))
  ipcMain.handle('storage:open-folder', async () => {
    shell.openPath(transcriptsDir())
  })

  ipcMain.handle('worker:status', async () => worker!.status())

  // Fire-and-forget: kick off the whisper-server model load when recording
  // starts so the first chunks don't queue behind it.
  ipcMain.handle('worker:warmup', async () => {
    void worker!.warmup()
  })

  ipcMain.handle('model:download', async () => {
    return await downloadModel((p) => {
      mainWindow?.webContents.send('model:download-progress', p)
    })
  })

  // --- Post-meeting refinement: session audio spool + background re-pass ---
  const sessions = new SessionAudioStore(join(app.getPath('userData'), 'sessions'))
  // Privacy sweep: audio from crashed sessions must not outlive the restart.
  sessions.sweep().catch(() => {})

  const sessionStem = (startedAtIso: string): string =>
    transcriptFileName(new Date(startedAtIso)).replace(/\.md$/, '')

  ipcMain.handle('session:append', async (_evt, rawPayload: unknown) => {
    const payload = validateSessionAudioPayload(rawPayload)
    await sessions.append(sessionStem(payload.startedAt), payload.source, Buffer.from(payload.pcm))
  })

  ipcMain.handle('session:finalize', async (_evt, raw: unknown) => {
    await sessions.finalize(sessionStem(validateStartedAt(raw)))
  })

  ipcMain.handle('session:discard', async (_evt, raw: unknown) => {
    await sessions.discard(sessionStem(validateStartedAt(raw)))
  })

  ipcMain.handle('session:refine', async (_evt, raw: unknown) => {
    const startedAt = validateStartedAt(raw)
    const stem = sessionStem(startedAt)
    const sendStatus = (s: RefineStatusEvent): void => {
      mainWindow?.webContents.send('refine:status', s)
    }
    sendStatus({ state: 'running', startedAt })
    void (async () => {
      try {
        const refined = await refineSession(
          {
            sessionDir: join(app.getPath('userData'), 'sessions', stem),
            binPath: whisperBinaryPath(),
            modelPath: modelPath(),
            sampleRate: 16000,
            vadModelPath: await ensureVadModel()
          },
          async (segments) => {
            await writeMarkdownTranscript(startedAt, segments)
          }
        )
        sendStatus({
          state: 'done',
          startedAt,
          detail: refined ? `${refined.length} segments` : 'nothing to refine'
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('Transcript refinement failed:', msg)
        sendStatus({ state: 'error', startedAt, detail: msg })
      } finally {
        // The audio's job is done either way — never keep it around.
        await sessions.discard(stem)
      }
    })()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  worker?.dispose()
})
