import type { Segment } from '../../preload/index'

/**
 * Merge new segments from a chunk into the running list.
 *
 * Candidates are cleaned (repetition loops collapsed) and dropped when they are
 * blank, known hallucinations, or duplicates under three rules:
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
 *
 * 3. **Overlap-echo fragments** — see isOverlapEcho().
 */
export function mergeSegments(prev: Segment[], next: Segment[]): Segment[] {
  const cleaned = next.map((s) => ({ ...s, text: collapseRepeats(s.text) }))
  if (cleaned.length === 0) return prev
  // Candidates are compared against the recent tail AND against candidates
  // already accepted from this same batch — whisper sometimes emits the same
  // sentence twice within one chunk.
  const accepted: Segment[] = []
  for (const candidate of cleaned) {
    const candidateText = normalizeText(candidate.text)
    if (!candidateText) continue
    if (isHallucination(candidate.text)) continue
    const against = [...prev.slice(-8), ...accepted]
    if (isOverlapEcho(candidate, against)) continue
    const duplicate = against.some((existing) => {
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
    if (!duplicate) accepted.push(candidate)
  }
  if (accepted.length === 0) return prev
  return [...prev, ...accepted].sort((a, b) => a.t0 - b.t0)
}

/**
 * Forced mid-speech cuts keep a small audio overlap so no word is lost, but
 * whisper sometimes re-transcribes that overlap as its own fragment ("Last
 * month" after "...dropped below 2% last month."). Drop a short candidate
 * whose words are all contained in a time-adjacent same-source segment.
 */
function isOverlapEcho(candidate: Segment, tail: Segment[]): boolean {
  const words = wordList(candidate.text)
  if (words.length === 0 || words.length > 8) return false
  return tail.some((existing) => {
    if (existing.speaker !== candidate.speaker) return false
    // Candidate must start inside (or just after) the existing segment's span.
    if (candidate.t0 < existing.t0 - 0.25 || candidate.t0 > existing.t1 + 0.25) return false
    const existingWords = new Set(wordList(existing.text))
    return words.every((w) => existingWords.has(w))
  })
}

function wordList(text: string): string[] {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .split(' ')
    .filter(Boolean)
}

/**
 * Collapse decoder repetition loops ("first, first, first, first...") down to a
 * single occurrence. Runs per word-group size 1-3; only collapses 3+ repeats so
 * legitimate doubles ("yes, yes") survive.
 */
export function collapseRepeats(text: string): string {
  const tokens = text.trim().split(/\s+/)
  for (let size = 1; size <= 3; size++) {
    const out: string[] = []
    let i = 0
    while (i < tokens.length) {
      const group = tokens.slice(i, i + size)
      const norm = group.join(' ').toLowerCase().replace(/[.,!?]+$/, '')
      let repeats = 1
      while (i + (repeats + 1) * size <= tokens.length) {
        const nextGroup = tokens
          .slice(i + repeats * size, i + (repeats + 1) * size)
          .join(' ')
          .toLowerCase()
          .replace(/[.,!?]+$/, '')
        if (nextGroup !== norm) break
        repeats += 1
      }
      out.push(...group)
      i += repeats >= 3 ? repeats * size : size
    }
    tokens.length = 0
    tokens.push(...out)
  }
  return tokens.join(' ')
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
