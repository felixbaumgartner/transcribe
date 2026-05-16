import type { Segment } from '../../preload/index'

/**
 * Merge new segments from a chunk into the running list.
 *
 * Two dedup rules apply:
 *
 * 1. **Same-source overlap** — consecutive chunks from the same source share an
 *    overlap window, so we drop a candidate when an existing tail segment of the
 *    same source has matching text within 1.5s (or overlapping intervals).
 *
 * 2. **Cross-source echo** — when the mic re-captures the meeting audio coming
 *    out of the speakers, the same words show up on both streams. If an existing
 *    'you' segment has the same text within 2s of a new 'others' segment, drop
 *    the 'others' copy: the mic is closer to the actual speaker than re-captured
 *    loopback. Known v1 limitation: only fires when the 'you' segment arrived
 *    first; reverse-order echoes slip through.
 */
export function mergeSegments(prev: Segment[], next: Segment[]): Segment[] {
  if (prev.length === 0) return next.filter((s) => normalizeText(s.text))
  if (next.length === 0) return prev
  const tail = prev.slice(-8)
  const filtered = next.filter((candidate) => {
    const candidateText = normalizeText(candidate.text)
    if (!candidateText) return false
    return !tail.some((existing) => {
      if (normalizeText(existing.text) !== candidateText) return false

      // 1. Same-source overlap dedup
      const sameSource = existing.speaker === candidate.speaker
      if (sameSource) {
        const nearSameTime =
          Math.abs(existing.t0 - candidate.t0) < 1.5 || intervalsOverlap(existing, candidate)
        if (nearSameTime) return true
      }

      // 2. Cross-source echo: drop Others when You said the same thing within 2s
      if (candidate.speaker === 'others' && existing.speaker === 'you') {
        if (Math.abs(existing.t0 - candidate.t0) < 2) return true
      }

      return false
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
