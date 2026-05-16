import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeSegments } from './segments.ts'

test('mergeSegments removes overlapping duplicate text', () => {
  const merged = mergeSegments(
    [{ t0: 28, t1: 30, text: 'hello there' }],
    [{ t0: 28.4, t1: 30.2, text: ' Hello   there ' }]
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, 'hello there')
})

test('mergeSegments keeps repeated text at different times', () => {
  const merged = mergeSegments(
    [{ t0: 5, t1: 7, text: 'yes' }],
    [{ t0: 40, t1: 41, text: 'yes' }]
  )

  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((s) => s.t0), [5, 40])
})

test('mergeSegments drops blank segments', () => {
  const merged = mergeSegments([], [{ t0: 0, t1: 1, text: '   ' }])

  assert.deepEqual(merged, [])
})

test('mergeSegments preserves speaker on new segments', () => {
  const merged = mergeSegments(
    [{ t0: 0, t1: 2, text: 'first', speaker: 'others' }],
    [{ t0: 5, t1: 7, text: 'second', speaker: 'you' }]
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[0].speaker, 'others')
  assert.equal(merged[1].speaker, 'you')
})

test('mergeSegments drops Others when You said the same thing within 2s (echo)', () => {
  const merged = mergeSegments(
    [{ t0: 10, t1: 11, text: 'okay sounds good', speaker: 'you' }],
    [{ t0: 11.2, t1: 12.3, text: 'okay sounds good', speaker: 'others' }]
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].speaker, 'you')
})

test('mergeSegments keeps Others when matching text is >2s away from You', () => {
  const merged = mergeSegments(
    [{ t0: 10, t1: 11, text: 'yes', speaker: 'you' }],
    [{ t0: 30, t1: 31, text: 'yes', speaker: 'others' }]
  )

  assert.equal(merged.length, 2)
  assert.deepEqual(
    merged.map((s) => s.speaker),
    ['you', 'others']
  )
})

test('mergeSegments interleaves two sources by t0', () => {
  const prev = [
    { t0: 0, t1: 2, text: 'hello', speaker: 'others' as const },
    { t0: 4, t1: 5, text: 'hi back', speaker: 'you' as const }
  ]
  const next = [
    { t0: 2.5, t1: 3.5, text: 'how are you', speaker: 'others' as const },
    { t0: 6, t1: 7, text: 'doing well', speaker: 'you' as const }
  ]
  const merged = mergeSegments(prev, next)

  assert.deepEqual(
    merged.map((s) => s.t0),
    [0, 2.5, 4, 6]
  )
  assert.deepEqual(
    merged.map((s) => s.speaker),
    ['others', 'others', 'you', 'you']
  )
})

test('mergeSegments same-source overlap dedup respects speaker (no cross-source false drop)', () => {
  // Same text at near-same time from different speakers (e.g., a host says
  // a guest's name into the meeting while the guest happens to repeat it).
  // Not in the echo direction (Others arrives before You), so we should keep both.
  const merged = mergeSegments(
    [{ t0: 10, t1: 11, text: 'alice', speaker: 'others' }],
    [{ t0: 10.5, t1: 11.5, text: 'alice', speaker: 'you' }]
  )

  assert.equal(merged.length, 2)
})
