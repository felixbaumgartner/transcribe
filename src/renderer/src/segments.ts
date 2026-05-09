import type { Segment } from '../../preload/index'

/**
 * Merge new segments from a chunk into the running list. Consecutive chunks
 * overlap, so only remove a new segment when its timestamp and normalized text
 * match something already seen near the tail.
 */
export function mergeSegments(prev: Segment[], next: Segment[]): Segment[] {
  if (prev.length === 0) return next.filter((s) => normalizeText(s.text))
  if (next.length === 0) return prev
  const tail = prev.slice(-8)
  const filtered = next.filter((candidate) => {
    const candidateText = normalizeText(candidate.text)
    if (!candidateText) return false
    return !tail.some((existing) => {
      const sameText = normalizeText(existing.text) === candidateText
      const nearSameTime = Math.abs(existing.t0 - candidate.t0) < 1.5 || intervalsOverlap(existing, candidate)
      return sameText && nearSameTime
    })
  })
  return [...prev, ...filtered].sort((a, b) => a.t0 - b.t0)
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function intervalsOverlap(a: Segment, b: Segment): boolean {
  return Math.max(a.t0, b.t0) <= Math.min(a.t1, b.t1)
}
