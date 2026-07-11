import { app } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Segment, Speaker, TranscribeChunkResult } from '../shared/transcript.js'
import { WhisperServerManager } from './whisper-server.js'
import { modelName, modelPath } from './model.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface WhisperJsonOutput {
  transcription: { offsets: { from: number; to: number }; text: string }[]
}

// ~10 chunks of backlog per source before we tell the user to slow down.
const MAX_QUEUED_CHUNKS_PER_SOURCE = 10
const DEFAULT_WHISPER_TIMEOUT_MS = 120000

// Whisper pads every input to a 30s window and runs the encoder over ALL of it —
// for short live chunks most of that work is spent encoding padding. Scaling the
// audio context to each chunk's actual length (50 frames/second + headroom)
// measured 2-3x faster per chunk on CPU with identical transcription output,
// and keeps short endpointed chunks cheap enough that the queue can always
// drain faster than speech arrives.
const MIN_AUDIO_CTX = 128
const MAX_AUDIO_CTX = 512

function audioCtxForSeconds(seconds: number): number {
  const frames = Math.ceil(seconds * 50) + 32
  return Math.min(MAX_AUDIO_CTX, Math.max(MIN_AUDIO_CTX, frames))
}

function whisperBinDir(): string {
  // In dev: resources/ sits next to the project root.
  // In packaged app: process.resourcesPath/whisper-bin/...
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper-bin')
    : join(__dirname, '..', '..', 'resources', 'whisper-bin')
}

function whisperBinaryPath(): string {
  if (process.platform === 'win32') return join(whisperBinDir(), 'whisper.exe')
  return join(whisperBinDir(), 'whisper')
}

function whisperServerPath(): string {
  if (process.platform === 'win32') return join(whisperBinDir(), 'whisper-server.exe')
  return join(whisperBinDir(), 'whisper-server')
}

function whisperThreads(): number {
  return Math.max(2, cpus().length - 2)
}

function whisperTimeoutMs(): number {
  const value = Number(process.env.WHISPER_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WHISPER_TIMEOUT_MS
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Wrap raw 16-bit PCM mono @ 16kHz in a minimal WAV header so whisper.cpp can read it. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = pcm.length

  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(numChannels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  pcm.copy(buf, 44)
  return buf
}

export class TranscribeWorker {
  // Per-source promise chains preserve in-source FIFO ordering so a slow chunk
  // on one source can't reorder its own siblings.
  private chains: Record<Speaker, Promise<unknown>> = {
    you: Promise.resolve(),
    others: Promise.resolve()
  }
  // Single cross-source mutex: only one whisper.cpp process at a time. Running two
  // in parallel would double CPU and cancel the latency win we got from smaller chunks.
  private inflight: Promise<unknown> = Promise.resolve()
  private queuedChunks: Record<Speaker, number> = { you: 0, others: 0 }
  // Lazily created on the first chunk (needs the model path to be final by then).
  // null = server binary not installed; the CLI path is used instead.
  private server: WhisperServerManager | null | undefined

  dispose(): void {
    this.server?.dispose()
  }

  async status(): Promise<{
    binary: boolean
    model: boolean
    binaryPath: string
    modelPath: string
    modelName: string
    serverBinary: boolean
    serverRunning: boolean
    queuedChunks: Record<Speaker, number>
  }> {
    return {
      binary: await fileExists(whisperBinaryPath()),
      model: await fileExists(modelPath()),
      binaryPath: whisperBinaryPath(),
      modelPath: modelPath(),
      modelName: modelName(),
      serverBinary: await fileExists(whisperServerPath()),
      serverRunning: this.server?.running ?? false,
      queuedChunks: { ...this.queuedChunks }
    }
  }

  /**
   * Transcribe a single PCM chunk. Calls are ordered per-source via this.chains
   * and serialized across sources via this.inflight so we never run two whisper.cpp
   * processes in parallel — keeps CPU usage predictable.
   */
  transcribeChunk(
    id: number,
    pcm: Buffer,
    sampleRate: number,
    source: Speaker,
    prompt?: string
  ): Promise<TranscribeChunkResult> {
    if (this.queuedChunks[source] >= MAX_QUEUED_CHUNKS_PER_SOURCE) {
      return Promise.reject(
        new Error(
          `Transcription is falling behind on '${source}' (${this.queuedChunks[source]} chunks queued). Stop recording or use a smaller model.`
        )
      )
    }

    this.queuedChunks[source] += 1
    const next = this.chains[source].then(() => this.runWithLock(id, pcm, sampleRate, source, prompt))
    // Swallow rejection so a single bad chunk doesn't poison the queue.
    this.chains[source] = next.catch(() => [] as Segment[])
    return next
      .then((segments) => ({ source, segments }))
      .finally(() => {
        this.queuedChunks[source] = Math.max(0, this.queuedChunks[source] - 1)
      })
  }

  /** Take the global whisper lock, run the transcription, release the lock. */
  private async runWithLock(
    id: number,
    pcm: Buffer,
    sampleRate: number,
    source: Speaker,
    prompt?: string
  ): Promise<Segment[]> {
    const wait = this.inflight
    let release: () => void = () => {}
    const lock = new Promise<void>((resolve) => {
      release = resolve
    })
    this.inflight = lock
    try {
      await wait
    } catch {
      // Previous inflight rejection shouldn't block us.
    }
    try {
      return await this.runOnce(id, pcm, sampleRate, source, prompt)
    } finally {
      release()
    }
  }

  private async getServer(model: string): Promise<WhisperServerManager | null> {
    if (this.server !== undefined) return this.server
    this.server = (await fileExists(whisperServerPath()))
      ? new WhisperServerManager(whisperServerPath(), model, whisperThreads())
      : null
    return this.server
  }

  /**
   * Start loading the model before the first chunk arrives (call when recording
   * starts). Without this the first ~10-15s of speech piles up behind the load.
   */
  async warmup(): Promise<void> {
    const model = modelPath()
    if (!(await fileExists(model))) return
    const server = await this.getServer(model)
    if (server?.available) {
      await server.warmup().catch(() => {}) // failures latch inside the manager
    }
  }

  private async runOnce(
    id: number,
    pcm: Buffer,
    sampleRate: number,
    source: Speaker,
    prompt?: string
  ): Promise<Segment[]> {
    const bin = whisperBinaryPath()
    const model = modelPath()

    if (sampleRate <= 0 || !Number.isFinite(sampleRate)) {
      throw new Error(`Invalid sample rate for chunk ${id}: ${sampleRate}`)
    }
    if (pcm.length === 0) {
      return []
    }

    if (!(await fileExists(model))) {
      throw new Error(`model missing at ${model} — run "npm run fetch-model"`)
    }

    const chunkSeconds = pcm.length / 2 / sampleRate
    const audioCtx = audioCtxForSeconds(chunkSeconds)

    // Preferred path: resident whisper-server (model stays loaded across chunks).
    const server = await this.getServer(model)
    if (server?.available) {
      try {
        const segments = await server.transcribe(
          pcmToWav(pcm, sampleRate),
          whisperTimeoutMs(),
          prompt,
          audioCtx
        )
        return segments
          // Whisper marks segments it is confident contain no speech; those are
          // near-certain hallucinations (breathing, keyboard noise, music).
          .filter((s) => (s.no_speech_prob ?? 0) < 0.85)
          // A segment starting at/after the chunk's real end is decoded from pure
          // padding — always hallucination.
          .filter((s) => s.start < chunkSeconds - 0.05)
          // Degenerate decodes report the full padded window (0-30s); clamp
          // timestamps to the actual chunk so downstream alignment stays sane.
          .map((s) => ({
            t0: s.start,
            t1: Math.max(s.start, Math.min(s.end, chunkSeconds)),
            text: s.text,
            speaker: source
          }))
      } catch (err) {
        // App is quitting — don't burn CPU on a CLI fallback for a dead session.
        if (server.disposed) throw err
        // Server hiccup (crash, timeout, port clash) — fall back to the CLI for
        // this chunk. The next chunk retries the server; after repeated start
        // failures `available` latches false and we stop trying.
        console.warn(`whisper-server failed for chunk ${source}-${id}; using CLI fallback:`, err)
      }
    }

    if (!(await fileExists(bin))) {
      throw new Error(`whisper binary missing at ${bin} — run "npm run fetch-whisper"`)
    }

    const tmpDir = join(app.getPath('userData'), 'tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
    const wavPath = join(tmpDir, `chunk-${source}-${id}-${nonce}.wav`)
    const jsonPath = `${wavPath}.json`

    await fs.writeFile(wavPath, pcmToWav(pcm, sampleRate))

    try {
      await new Promise<void>((resolve, reject) => {
        const args = [
          '-m', model,
          '-f', wavPath,
          '-oj', // output JSON
          '-of', wavPath, // output file prefix (whisper appends .json)
          '-l', 'en',
          '-t', String(whisperThreads()),
          '-ac', String(audioCtx),
          '--no-fallback',
          '--no-prints'
        ]
        if (prompt) args.push('--prompt', prompt)
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const timeoutMs = whisperTimeoutMs()
        const timeout = setTimeout(() => {
          proc.kill()
          reject(new Error(`whisper timed out after ${timeoutMs}ms for chunk ${source}-${id}`))
        }, timeoutMs)
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
        proc.on('close', (code) => {
          clearTimeout(timeout)
          if (code === 0) resolve()
          else reject(new Error(`whisper exited ${code}: ${stderr.slice(-500)}`))
        })
      })

      const raw = await fs.readFile(jsonPath, 'utf8')
      const parsed = JSON.parse(raw) as WhisperJsonOutput
      return (parsed.transcription || []).map((t) => ({
        t0: t.offsets.from / 1000,
        t1: t.offsets.to / 1000,
        text: t.text,
        speaker: source
      }))
    } finally {
      // Best-effort cleanup; leave on failure for debugging.
      fs.unlink(wavPath).catch(() => {})
      fs.unlink(jsonPath).catch(() => {})
    }
  }
}
