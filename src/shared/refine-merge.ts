// Pure merge logic for the post-meeting refinement pass: combine the two
// independently re-transcribed sources (mic = 'you', loopback = 'others')
// into one timeline. Kept free of Electron/DOM imports so it unit-tests in
// plain node and can be exercised by a standalone harness.

import type { Segment } from './transcript.js'

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function overlaps(a: Segment, b: Segment): boolean {
  return Math.max(a.t0, b.t0) <= Math.min(a.t1, b.t1)
}

/**
 * Merge refined per-source segments into one transcript:
 *  - blank segments and bracketed sound annotations ("[BLANK_AUDIO]") drop
 *  - cross-source echo (mic re-captured by loopback, or vice versa: same text,
 *    overlapping/near time) keeps only the 'you' copy — the mic is closest to
 *    the actual speaker
 *  - result ordered by start time
 */
export function mergeRefinedSources(you: Segment[], others: Segment[]): Segment[] {
  const clean = (segs: Segment[]): Segment[] =>
    segs.filter((s) => {
      const t = normalize(s.text)
      if (!t) return false
      if (/^[\[(*♪].*[\])*♪]$/.test(t)) return false
      return true
    })

  const youClean = clean(you)
  const othersClean = clean(others).filter((o) => {
    const text = normalize(o.text)
    return !youClean.some(
      (y) => normalize(y.text) === text && (overlaps(y, o) || Math.abs(y.t0 - o.t0) < 2)
    )
  })

  return [...youClean, ...othersClean].sort((a, b) => a.t0 - b.t0)
}
