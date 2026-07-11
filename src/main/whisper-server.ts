// Resident whisper.cpp server. Spawning whisper-cli per chunk reloads the ~500 MB
// model from disk every time; whisper-server loads it once and answers HTTP
// requests on localhost, cutting per-chunk latency to just the inference cost.
//
// The manager owns the child process: lazy start on first request, restart on
// crash, and a permanent-failure latch after repeated start failures so callers
// can fall back to the CLI path.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

export interface ServerSegment {
  start: number
  end: number
  text: string
  no_speech_prob?: number
}

interface VerboseJsonResponse {
  segments?: ServerSegment[]
}

const START_TIMEOUT_MS = 120000
const READY_POLL_INTERVAL_MS = 250
const MAX_CONSECUTIVE_START_FAILURES = 2

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('Could not allocate a local port')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class WhisperServerManager {
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private consecutiveStartFailures = 0

  constructor(
    private readonly binPath: string,
    private readonly modelPath: string,
    private readonly threads: number,
    private readonly audioCtx: number
  ) {}

  /** False once the server has repeatedly failed to start — callers should use the CLI. */
  get available(): boolean {
    return this.consecutiveStartFailures < MAX_CONSECUTIVE_START_FAILURES
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  async transcribe(wav: Buffer, timeoutMs: number): Promise<ServerSegment[]> {
    await this.ensureStarted()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0.0')
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`whisper-server responded ${res.status}: ${body.slice(0, 300)}`)
    }
    const parsed = (await res.json()) as VerboseJsonResponse
    return parsed.segments ?? []
  }

  dispose(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill()
    }
    this.proc = null
  }

  private ensureStarted(): Promise<void> {
    if (!this.available) {
      return Promise.reject(new Error('whisper-server is unavailable after repeated start failures'))
    }
    if (this.running) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start()
        .then(() => {
          this.consecutiveStartFailures = 0
        })
        .catch((err) => {
          this.consecutiveStartFailures += 1
          throw err
        })
        .finally(() => {
          this.starting = null
        })
    }
    return this.starting
  }

  private async start(): Promise<void> {
    const port = await freePort()
    const proc = spawn(
      this.binPath,
      [
        '-m', this.modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(this.threads),
        '-ac', String(this.audioCtx)
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    // Swallow spawn errors here; they surface as "exited before becoming ready" below.
    proc.on('error', () => {})
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`whisper-server exited before becoming ready: ${stderr.slice(-500)}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(READY_POLL_INTERVAL_MS * 4)
        })
        // Any HTTP response means the listener is up and the model is loaded.
        if (res.status > 0) {
          this.proc = proc
          this.port = port
          return
        }
      } catch {
        // Not listening yet (model still loading) — keep polling.
      }
      await sleep(READY_POLL_INTERVAL_MS)
    }
    proc.kill()
    throw new Error(`whisper-server did not become ready within ${START_TIMEOUT_MS}ms`)
  }
}
