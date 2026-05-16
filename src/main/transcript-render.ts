// Pure (no-Electron) rendering of a transcript to markdown. Split out from storage.ts
// so it can be unit-tested without spinning up the Electron module graph.

export type Speaker = 'you' | 'others'

export interface Segment {
  t0: number
  t1: number
  text: string
  speaker?: Speaker
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${pad(m)}:${pad(s)}`
}

function speakerLabel(speaker: Speaker | undefined): string {
  if (speaker === 'you') return 'You'
  if (speaker === 'others') return 'Others'
  return ''
}

function speakerStats(segments: Segment[]): { you: number; others: number } | null {
  let you = 0
  let others = 0
  for (const s of segments) {
    const dur = Math.max(0, s.t1 - s.t0)
    if (s.speaker === 'you') you += dur
    else if (s.speaker === 'others') others += dur
  }
  // Only emit stats when both sources actually contributed.
  if (you <= 0 || others <= 0) return null
  const total = you + others
  const youPct = Math.round((you / total) * 100)
  return { you: youPct, others: 100 - youPct }
}

export function renderTranscriptMarkdown(startedAt: Date, segments: Segment[]): string {
  const lines: string[] = []
  lines.push(`# Transcript — ${startedAt.toLocaleString()}`)
  lines.push('')
  lines.push(`Started: ${startedAt.toISOString()}`)
  lines.push(`Segments: ${segments.length}`)
  const stats = speakerStats(segments)
  if (stats) {
    lines.push(`Speakers: You ${stats.you}% / Others ${stats.others}%`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const seg of segments) {
    const label = speakerLabel(seg.speaker)
    const prefix = label
      ? `**[${fmtTimestamp(seg.t0)}] ${label}:**`
      : `**[${fmtTimestamp(seg.t0)}]**`
    lines.push(`${prefix} ${seg.text.trim()}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function transcriptFileName(startedAt: Date): string {
  return `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}.md`
}
