import { app } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export type Speaker = 'you' | 'others'

export interface Segment {
  t0: number
  t1: number
  text: string
  speaker?: Speaker
}

export interface TranscribeChunkResult {
  source: Speaker
  segments: Segment[]
}

interface WhisperJsonOutput {
  transcription: { offsets: { from: number; to: number }; text: string }[]
}

// With 6s chunks (was 30s), the same ~48s of audio backlog → ceiling 8 per source.
const MAX_QUEUED_CHUNKS_PER_SOURCE = 8

function whisperBinaryPath(): string {
  // In dev: resources/ sits next to the project root.
  // In packaged app: process.resourcesPath/whisper-bin/...
  const isPackaged = app.isPackaged
  const base = isPackaged
    ? join(process.resourcesPath, 'whisper-bin')
    : join(__dirname, '..', '..', 'resources', 'whisper-bin')

  if (process.platform === 'win32') return join(base, 'whisper.exe')
  return join(base, 'whisper')
}

function modelName(): string {
  return process.env.WHISPER_MODEL || 'small.en'
}

function modelPath(): string {
  // Stored in userData so it survives upgrades and is downloaded on first run.
  return join(app.getPath('userData'), 'models', `ggml-${modelName()}.bin`)
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

  async status(): Promise<{
    binary: boolean
    model: boolean
    binaryPath: string
    modelPath: string
    modelName: string
    queuedChunks: Record<Speaker, number>
  }> {
    return {
      binary: await fileExists(whisperBinaryPath()),
      model: await fileExists(modelPath()),
      binaryPath: whisperBinaryPath(),
      modelPath: modelPath(),
      modelName: modelName(),
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
    source: Speaker
  ): Promise<TranscribeChunkResult> {
    if (this.queuedChunks[source] >= MAX_QUEUED_CHUNKS_PER_SOURCE) {
      return Promise.reject(
        new Error(
          `Transcription is falling behind on '${source}' (${this.queuedChunks[source]} chunks queued). Stop recording or use a smaller model.`
        )
      )
    }

    this.queuedChunks[source] += 1
    const next = this.chains[source].then(() => this.runWithLock(id, pcm, sampleRate, source))
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
    source: Speaker
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
      return await this.runOnce(id, pcm, sampleRate, source)
    } finally {
      release()
    }
  }

  private async runOnce(
    id: number,
    pcm: Buffer,
    sampleRate: number,
    source: Speaker
  ): Promise<Segment[]> {
    const bin = whisperBinaryPath()
    const model = modelPath()

    if (sampleRate <= 0 || !Number.isFinite(sampleRate)) {
      throw new Error(`Invalid sample rate for chunk ${id}: ${sampleRate}`)
    }
    if (pcm.length === 0) {
      return []
    }

    if (!(await fileExists(bin))) {
      throw new Error(`whisper binary missing at ${bin} — run "npm run fetch-whisper"`)
    }
    if (!(await fileExists(model))) {
      throw new Error(`model missing at ${model} — run "npm run fetch-model"`)
    }

    const tmpDir = join(app.getPath('userData'), 'tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    const wavPath = join(tmpDir, `chunk-${source}-${id}.wav`)
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
          '-t', String(Math.max(2, cpus().length - 2)),
          '--no-prints'
        ]
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', reject)
        proc.on('close', (code) => {
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
