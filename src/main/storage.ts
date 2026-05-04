import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface Segment {
  t0: number // seconds from start
  t1: number
  text: string
}

export function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

async function ensureDir(): Promise<string> {
  const dir = transcriptsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function fileNameFor(startedAt: Date): string {
  return `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}.md`
}

function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${pad(m)}:${pad(s)}`
}

export async function writeMarkdownTranscript(startedAtIso: string, segments: Segment[]): Promise<string> {
  const dir = await ensureDir()
  const startedAt = new Date(startedAtIso)
  const file = join(dir, fileNameFor(startedAt))

  const lines: string[] = []
  lines.push(`# Transcript — ${startedAt.toLocaleString()}`)
  lines.push('')
  lines.push(`Started: ${startedAt.toISOString()}`)
  lines.push(`Segments: ${segments.length}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const seg of segments) {
    lines.push(`**[${fmtTimestamp(seg.t0)}]** ${seg.text.trim()}`)
    lines.push('')
  }

  await fs.writeFile(file, lines.join('\n'), 'utf8')
  return file
}

export interface TranscriptListItem {
  file: string
  name: string
  size: number
  mtime: string
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
  if (!file.startsWith(dir)) throw new Error('Refusing to read outside transcripts dir')
  return fs.readFile(file, 'utf8')
}
