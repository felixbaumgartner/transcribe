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

export async function writeMarkdownTranscript(startedAtIso: string, segments: Segment[]): Promise<string> {
  const dir = await ensureDir()
  const startedAt = new Date(startedAtIso)
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error('Invalid transcript start time')
  }
  const file = join(dir, transcriptFileName(startedAt))
  const body = renderTranscriptMarkdown(startedAt, segments)
  await fs.writeFile(file, body, 'utf8')
  return file
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
