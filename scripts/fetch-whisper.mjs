// Fetch a whisper.cpp binary into resources/whisper-bin/.
//
// Windows: downloads the prebuilt release zip from GitHub.
// macOS:   uses `brew install whisper-cpp` (homebrew) and symlinks the binary,
//          or falls back to clear instructions if homebrew is missing.
//
// Override the version with: WHISPER_VERSION=v1.7.4 npm run fetch-whisper

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, arch as osArch, platform as osPlatform } from 'node:os'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const targetDir = join(projectRoot, 'resources', 'whisper-bin')
const VERSION = process.env.WHISPER_VERSION || 'v1.8.4'

mkdirSync(targetDir, { recursive: true })

const platform = osPlatform()
const arch = osArch()

if (platform === 'win32') {
  await fetchWindows()
} else if (platform === 'darwin') {
  await fetchMac()
} else {
  console.error(`Unsupported platform: ${platform}. Build whisper.cpp from source and place the binary at ${targetDir}/whisper`)
  process.exit(1)
}

async function fetchWindows() {
  const asset = arch === 'x64' ? 'whisper-bin-x64.zip' : 'whisper-bin-Win32.zip'
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/${asset}`
  console.log(`Downloading ${url} ...`)

  const tmp = join(tmpdir(), `whisper-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const zipPath = join(tmp, asset)

  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))

  console.log('Extracting ...')
  // Use PowerShell's Expand-Archive — already on every Windows.
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${tmp}'`
  ], { stdio: 'inherit' })

  // Find the cli binary — naming has shifted between versions
  const candidates = ['whisper-cli.exe', 'main.exe', 'whisper.exe']
  let found = ''
  const flat = walk(tmp)
  for (const cand of candidates) {
    const hit = flat.find((f) => f.toLowerCase().endsWith(`\\${cand}`))
    if (hit) { found = hit; break }
  }
  if (!found) throw new Error('Could not locate whisper binary inside zip')

  // Copy the binary as whisper.exe + every DLL in the same folder it was extracted to
  const srcDir = dirname(found)
  copyFileSync(found, join(targetDir, 'whisper.exe'))
  for (const f of readdirSync(srcDir)) {
    if (f.toLowerCase().endsWith('.dll')) {
      copyFileSync(join(srcDir, f), join(targetDir, f))
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`✓ Installed whisper.exe + DLLs into ${targetDir}`)
}

async function fetchMac() {
  // Prefer homebrew — it builds with native acceleration (Metal) automatically.
  const which = spawnSync('which', ['whisper-cli'])
  let binPath = ''
  if (which.status === 0) {
    binPath = which.stdout.toString().trim()
  } else {
    const brew = spawnSync('which', ['brew'])
    if (brew.status !== 0) {
      console.error([
        'Homebrew not found.',
        '',
        'Install Homebrew (https://brew.sh) then re-run, OR build whisper.cpp manually:',
        '  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && make -j',
        `  cp build/bin/whisper-cli ${targetDir}/whisper`
      ].join('\n'))
      process.exit(1)
    }
    console.log('Installing whisper-cpp via Homebrew (this may take a minute)...')
    const r = spawnSync('brew', ['install', 'whisper-cpp'], { stdio: 'inherit' })
    if (r.status !== 0) { process.exit(r.status || 1) }
    binPath = spawnSync('which', ['whisper-cli']).stdout.toString().trim()
  }

  if (!binPath || !existsSync(binPath)) {
    console.error('whisper-cli not found after install. Aborting.')
    process.exit(1)
  }
  copyFileSync(binPath, join(targetDir, 'whisper'))
  chmodSync(join(targetDir, 'whisper'), 0o755)
  console.log(`✓ Installed whisper into ${targetDir}/whisper (from ${binPath})`)
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
