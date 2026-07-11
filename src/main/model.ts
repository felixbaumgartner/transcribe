// Whisper model location + in-app download. Packaged users have no npm, so the
// app must be able to fetch the model itself: stream from HuggingFace into
// userData/models with progress reporting, then atomically rename into place.

import { app } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelDownloadProgress } from '../shared/transcript.js'

export function modelName(): string {
  return process.env.WHISPER_MODEL || 'small.en'
}

export function modelPath(): string {
  // Stored in userData so it survives upgrades.
  return join(app.getPath('userData'), 'models', `ggml-${modelName()}.bin`)
}

export function modelUrl(): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName()}.bin`
}

// Silero VAD: a ~1 MB neural speech detector whisper.cpp runs ahead of the
// transcriber, so keyboard clatter / breathing / music never reach the decoder
// (which otherwise hallucinates sentences over them).
const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin'

export function vadModelPath(): string {
  return join(app.getPath('userData'), 'models', VAD_MODEL_FILE)
}

/**
 * Make sure the VAD model exists, downloading it (~1 MB) if needed. Returns
 * its path, or null when unavailable (offline first run) — callers then just
 * run without VAD.
 */
export async function ensureVadModel(): Promise<string | null> {
  const target = vadModelPath()
  try {
    await fs.access(target)
    return target
  } catch {
    // fall through to download
  }
  try {
    const url = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) return null
    await fs.mkdir(dirname(target), { recursive: true })
    const partial = `${target}.download`
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      createWriteStream(partial)
    )
    await fs.rename(partial, target)
    return target
  } catch {
    return null
  }
}

let inflight: Promise<string> | null = null

/**
 * Download the configured model if it's not already present. Concurrent calls
 * share one download. Progress is throttled to whole-percent changes.
 */
export function downloadModel(onProgress: (p: ModelDownloadProgress) => void): Promise<string> {
  if (!inflight) {
    inflight = doDownload(onProgress).finally(() => {
      inflight = null
    })
  }
  return inflight
}

async function doDownload(onProgress: (p: ModelDownloadProgress) => void): Promise<string> {
  const target = modelPath()
  await fs.mkdir(dirname(target), { recursive: true })
  try {
    await fs.access(target)
    return target // already downloaded
  } catch {
    // fall through to download
  }

  const url = modelUrl()
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed: ${res.status} ${res.statusText} (${url})`)
  }

  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastPct = -1

  const partial = `${target}.download`
  const stream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  stream.on('data', (chunk: Buffer) => {
    received += chunk.length
    const pct = total > 0 ? Math.floor((received / total) * 100) : 0
    if (pct !== lastPct) {
      lastPct = pct
      onProgress({ received, total, pct })
    }
  })

  try {
    await pipeline(stream, createWriteStream(partial))
    await fs.rename(partial, target)
  } catch (err) {
    await fs.unlink(partial).catch(() => {})
    throw err
  }
  return target
}
