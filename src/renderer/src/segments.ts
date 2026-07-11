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
  if (prev.length === 0) return next.filter((s) => normalizeText(s.text) && !isHallucination(s.text))
  if (next.length === 0) return prev
  const tail = prev.slice(-8)
  const filtered = next.filter((candidate) => {
    const candidateText = normalizeText(candidate.text)
    if (!candidateText) return false
    if (isHallucination(candidate.text)) return false
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

// Whisper decodes noticeably better (punctuation, casing, word choice) when
// conditioned on the preceding conversation. Cap the prompt so a long meeting
// doesn't blow up request size — and so one bad segment ages out quickly.
const MAX_PROMPT_CHARS = 500

/**
 * Build a whisper `prompt` from the transcript so far: the last ~500 characters
 * of merged text, cut at a word boundary. Returns '' when there's no history.
 * Built from post-filter segments, so hallucinations don't self-reinforce.
 */
export function buildPrompt(segments: Segment[]): string {
  if (segments.length === 0) return ''
  let text = ''
  for (let i = segments.length - 1; i >= 0 && text.length < MAX_PROMPT_CHARS; i--) {
    text = `${segments[i].text.trim()} ${text}`
  }
  text = text.trim().replace(/\s+/g, ' ')
  if (text.length <= MAX_PROMPT_CHARS) return text
  const cut = text.slice(-MAX_PROMPT_CHARS)
  const firstSpace = cut.indexOf(' ')
  return firstSpace === -1 ? cut : cut.slice(firstSpace + 1)
}

// Whisper hallucinates stock phrases on silence/noise — YouTube-outro lines it
// learned from training data, and bracketed sound annotations. Only segments
// consisting ENTIRELY of such content are dropped; the phrases inside real
// sentences are untouched.
const HALLUCINATED_PHRASES = new Set([
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  "don't forget to subscribe",
  'see you in the next video',
  'see you next time',
  'you'
])

/** True for segments that are whisper noise artifacts, not speech. */
export function isHallucination(text: string): boolean {
  const t = normalizeText(text)
  if (!t) return true
  // Pure sound annotations: "[BLANK_AUDIO]", "(silence)", "(music)", "*click*", "♪ ... ♪"
  if (/^[\[(*♪].*[\])*♪]$/.test(t)) return true
  // Stock phrases (matched with trailing punctuation stripped).
  if (HALLUCINATED_PHRASES.has(t.replace(/[.!?]+$/, ''))) return true
  // "Subtitles by the Amara.org community" and similar credits.
  if (/^subtitles?\s+by\b/.test(t) || /amara\.org/.test(t)) return true
  return false
}

function intervalsOverlap(a: Segment, b: Segment): boolean {
  return Math.max(a.t0, b.t0) <= Math.min(a.t1, b.t1)
}
