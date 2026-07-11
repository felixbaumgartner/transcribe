// Post-meeting refinement: while recording, raw session PCM streams to disk per
// source; after the fast live transcript is saved, a background whisper pass
// re-transcribes the WHOLE recording with full context and a careful decode
// (beam 5, temperature fallback allowed) and rewrites the saved markdown.
// The audio exists on disk only until the pass finishes — it is deleted
// immediately afterwards (and swept at startup after a crash), preserving the
// "audio never persists" property up to the few minutes of processing.
//
// Everything here is parameterized by explicit paths so the core can be
// exercised by a node harness without Electron.

import { spawn } from 'node:child_process'
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs'
import { cpus } from 'node:os'
import os from 'node:os'
import { join } from 'node:path'
import type { Segment, Speaker } from '../shared/transcript.js'
import { mergeRefinedSources } from '../shared/refine-merge.js'

const REFINE_TIMEOUT_MS = 90 * 60 * 1000

export interface RefineStatus {
  state: 'running' | 'done' | 'error'
  startedAt: string
  detail?: string
}

interface WhisperJsonOutput {
  transcription: { offsets: { from: number; to: number }; text: string }[]
}

/** Wrap raw 16-bit PCM mono in a minimal WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + pcm.length)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + pcm.length, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(pcm.length, 40)
  pcm.copy(buf, 44)
  return buf
}

/** Streams per-source session PCM to disk while a recording is in progress. */
export class SessionAudioStore {
  private streams = new Map<string, WriteStream>()
  private readonly sessionsRoot: string

  constructor(sessionsRoot: string) {
    this.sessionsRoot = sessionsRoot
  }

  private dirFor(stem: string): string {
    return join(this.sessionsRoot, stem)
  }

  async append(stem: string, source: Speaker, pcm: Buffer): Promise<void> {
    const key = `${stem}|${source}`
    let stream = this.streams.get(key)
    if (!stream) {
      await fs.mkdir(this.dirFor(stem), { recursive: true })
      stream = createWriteStream(join(this.dirFor(stem), `${source}.pcm`), { flags: 'a' })
      this.streams.set(key, stream)
    }
    stream.write(pcm)
  }

  /** Close this session's write streams so the refine pass reads complete files. */
  async finalize(stem: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [key, stream] of this.streams) {
      if (!key.startsWith(`${stem}|`)) continue
      closing.push(new Promise((resolve) => stream.end(() => resolve())))
      this.streams.delete(key)
    }
    await Promise.all(closing)
  }

  /** Delete a session's audio (recording discarded or refinement finished). */
  async discard(stem: string): Promise<void> {
    await this.finalize(stem)
    await fs.rm(this.dirFor(stem), { recursive: true, force: true }).catch(() => {})
  }

  /** Startup sweep: remove any audio left behind by a crash. */
  async sweep(): Promise<void> {
    await fs.rm(this.sessionsRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RefineOptions {
  sessionDir: string
  binPath: string
  modelPath: string
  sampleRate: number
}

/**
 * Re-transcribe one source's full session audio with whisper-cli. Runs at low
 * OS priority with a reduced thread count so a concurrently running live
 * session keeps its CPU headroom.
 */
async function transcribeWholeFile(
  opts: RefineOptions,
  source: Speaker
): Promise<Segment[] | null> {
  const pcmPath = join(opts.sessionDir, `${source}.pcm`)
  let pcm: Buffer
  try {
    pcm = await fs.readFile(pcmPath)
  } catch {
    return null // source not captured (e.g. mic denied)
  }
  if (pcm.length < opts.sampleRate) return [] // < 0.5s of audio

  const wavPath = join(opts.sessionDir, `${source}.wav`)
  await fs.writeFile(wavPath, pcmToWav(pcm, opts.sampleRate))

  const args = [
    '-m', opts.modelPath,
    '-f', wavPath,
    '-oj',
    '-of', wavPath,
    '-l', 'en',
    // Full threads are fine: the LOW process priority (below) is what protects
    // a concurrently running live session, not thread starvation.
    '-t', String(Math.max(2, cpus().length - 2)),
    '-bs', '3',
    '--no-prints'
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(opts.binPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    try {
      os.setPriority(proc.pid!, os.constants.priority.PRIORITY_LOW)
    } catch {
      // Best effort — refinement still works at normal priority.
    }
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`refinement timed out after ${REFINE_TIMEOUT_MS}ms`))
    }, REFINE_TIMEOUT_MS)
    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-1000)
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`whisper exited ${code}: ${stderr.slice(-400)}`))
    })
  })

  const raw = await fs.readFile(`${wavPath}.json`, 'utf8')
  const parsed = JSON.parse(raw) as WhisperJsonOutput
  return (parsed.transcription || []).map((t) => ({
    t0: t.offsets.from / 1000,
    t1: t.offsets.to / 1000,
    text: t.text,
    speaker: source
  }))
}

/**
 * Refine a finished session: re-transcribe both sources from the full audio,
 * merge, and hand the result to `write`. Returns the merged segments, or null
 * when there was nothing to refine.
 */
export async function refineSession(
  opts: RefineOptions,
  write: (segments: Segment[]) => Promise<void>
): Promise<Segment[] | null> {
  const you = await transcribeWholeFile(opts, 'you')
  const others = await transcribeWholeFile(opts, 'others')
  const merged = mergeRefinedSources(you ?? [], others ?? [])
  if (merged.length === 0) return null // don't clobber the live transcript with nothing
  await write(merged)
  return merged
}
