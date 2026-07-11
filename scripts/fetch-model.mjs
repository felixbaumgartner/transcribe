// Download a Whisper GGML model into the user's Electron userData/models folder
// so it persists across rebuilds. Default: small.en (~470 MB) — best speed/quality
// balance on CPU. Override with WHISPER_MODEL=base.en or medium.en, etc.

import { mkdirSync, createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MODEL = process.env.WHISPER_MODEL || 'small.en'
const fileName = `ggml-${MODEL}.bin`
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`

function userDataDir() {
  const appName = 'transcribe'
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), appName)
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName)
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), appName)
}

const modelsDir = join(userDataDir(), 'models')
mkdirSync(modelsDir, { recursive: true })
const target = join(modelsDir, fileName)

if (existsSync(target)) {
  console.log(`✓ Model already present at ${target}`)
  process.exit(0)
}

console.log(`Downloading ${MODEL} model (~470 MB for small.en) to ${target} ...`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText} (${url})`)
  process.exit(1)
}

const total = Number(res.headers.get('content-length') || 0)
let received = 0
let lastReport = 0

const reader = res.body.getReader()
const reportingStream = new ReadableStream({
  async start(controller) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      const pct = total ? Math.floor((received / total) * 100) : 0
      if (pct - lastReport >= 5) {
        process.stdout.write(`\r  ${pct}%  ${(received / 1024 / 1024).toFixed(1)} MB`)
        lastReport = pct
      }
      controller.enqueue(value)
    }
    controller.close()
  }
})

await pipeline(Readable.fromWeb(reportingStream), createWriteStream(target))
process.stdout.write('\n')
console.log(`✓ Saved ${target}`)

// Silero VAD model (~1 MB): gates the decoder so non-speech audio (keyboard,
// breathing, music) is never transcribed. The app also self-downloads this.
const vadFile = 'ggml-silero-v5.1.2.bin'
const vadTarget = join(modelsDir, vadFile)
if (!existsSync(vadTarget)) {
  const vadRes = await fetch(`https://huggingface.co/ggml-org/whisper-vad/resolve/main/${vadFile}`, { redirect: 'follow' })
  if (vadRes.ok) {
    await pipeline(Readable.fromWeb(vadRes.body), createWriteStream(vadTarget))
    console.log(`✓ Saved ${vadTarget}`)
  } else {
    console.warn(`⚠ VAD model download failed (${vadRes.status}) — the app will retry on first recording`)
  }
}
