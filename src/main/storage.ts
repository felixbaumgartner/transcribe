import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, join } from 'node:path'
import {
  renderTranscriptMarkdown,
  transcriptFileName,
} from './transcript-render.js'
import type { Segment, Speaker, TranscriptListItem } from '../shared/transcript.js'

export type { Segment, Speaker }

export function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

async function ensureDir(): Promise<string> {
  const dir = transcriptsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function parseStartedAt(startedAtIso: string): Date {
  const startedAt = new Date(startedAtIso)
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error('Invalid transcript start time')
  }
  return startedAt
}

/** Write via a temp file + rename so a crash mid-write never leaves a torn file. */
async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}

function partialFilePath(dir: string, startedAt: Date): string {
  return join(dir, `${transcriptFileName(startedAt)}.partial`)
}

export async function writeMarkdownTranscript(startedAtIso: string, segments: Segment[]): Promise<string> {
  const dir = await ensureDir()
  const startedAt = parseStartedAt(startedAtIso)
  const file = join(dir, transcriptFileName(startedAt))
  const body = renderTranscriptMarkdown(startedAt, segments)
  await writeAtomic(file, body)
  // The autosaved partial is superseded by the final file.
  await fs.unlink(partialFilePath(dir, startedAt)).catch(() => {})
  return file
}

/**
 * Crash-safety autosave: periodically persists the in-progress transcript to a
 * `.md.partial` file. If the app dies mid-meeting, recoverPartialTranscripts()
 * turns it into a regular transcript on next launch.
 */
export async function autosaveTranscript(startedAtIso: string, segments: Segment[]): Promise<string> {
  const dir = await ensureDir()
  const startedAt = parseStartedAt(startedAtIso)
  const file = partialFilePath(dir, startedAt)
  await writeAtomic(file, renderTranscriptMarkdown(startedAt, segments))
  return file
}

/**
 * Promote orphaned `.md.partial` files (left behind by a crash) to real
 * transcripts named `<original>-recovered.md`. Returns the recovered paths.
 */
export async function recoverPartialTranscripts(): Promise<string[]> {
  const dir = await ensureDir()
  const recovered: string[] = []
  for (const name of await fs.readdir(dir)) {
    // Sweep temp files from interrupted atomic writes.
    if (name.endsWith('.tmp')) {
      await fs.unlink(join(dir, name)).catch(() => {})
      continue
    }
    if (!name.endsWith('.md.partial')) continue
    const stem = name.slice(0, -'.md.partial'.length)
    let target = join(dir, `${stem}-recovered.md`)
    let counter = 2
    while (await exists(target)) {
      target = join(dir, `${stem}-recovered-${counter}.md`)
      counter += 1
    }
    await fs.rename(join(dir, name), target)
    recovered.push(target)
  }
  return recovered
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function listTranscripts(): Promise<TranscriptListItem[]> {
  const dir = await ensureDir()
  const entries = await fs.readdir(dir)
  const out: TranscriptListItem[] = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const file = join(dir, name)
    const stat = await fs.stat(file)
    out.push({ file, name, size: stat.size, mtime: stat.mtime.toISOString() })
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return out
}

export async function readTranscript(file: string): Promise<string> {
  const dir = await ensureDir()
  const safePath = resolveInside(dir, file)
  return fs.readFile(safePath, 'utf8')
}

function resolveInside(root: string, candidate: string): string {
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  const rel = relative(rootResolved, candidateResolved)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return candidateResolved
  }
  throw new Error('Refusing to read outside transcripts dir')
}
