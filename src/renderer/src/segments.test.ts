import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt, collapseRepeats, isHallucination, mergeSegments } from './segments.ts'

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

test('isHallucination flags sound annotations and stock phrases', () => {
  assert.equal(isHallucination('[BLANK_AUDIO]'), true)
  assert.equal(isHallucination(' (silence) '), true)
  assert.equal(isHallucination('(electronic beeping)'), true)
  assert.equal(isHallucination('*click*'), true)
  assert.equal(isHallucination('Thanks for watching!'), true)
  assert.equal(isHallucination('Subtitles by the Amara.org community'), true)
  assert.equal(isHallucination('you'), true)
})

test('isHallucination keeps real speech', () => {
  assert.equal(isHallucination('Thanks for watching the metrics dashboard today.'), false)
  assert.equal(isHallucination('Can you hear me?'), false)
  assert.equal(isHallucination('Let me share my screen (one second).'), false)
})

test('mergeSegments drops hallucinated segments', () => {
  const merged = mergeSegments(
    [{ t0: 0, t1: 2, text: 'real speech' }],
    [
      { t0: 5, t1: 7, text: '[BLANK_AUDIO]' },
      { t0: 8, t1: 10, text: 'more real speech' }
    ]
  )

  assert.deepEqual(merged.map((s) => s.text), ['real speech', 'more real speech'])
})

test('buildPrompt returns empty string with no history', () => {
  assert.equal(buildPrompt([]), '')
})

test('buildPrompt joins recent segments in order', () => {
  const prompt = buildPrompt([
    { t0: 0, t1: 2, text: ' Hello there. ' },
    { t0: 2, t1: 4, text: 'How are you?' }
  ])

  assert.equal(prompt, 'Hello there. How are you?')
})

test('buildPrompt caps length at a word boundary', () => {
  const segments = Array.from({ length: 100 }, (_, i) => ({
    t0: i,
    t1: i + 1,
    text: `word${i} is here`
  }))
  const prompt = buildPrompt(segments)

  assert.ok(prompt.length <= 200)
  assert.ok(!prompt.startsWith(' '))
  // Ends with the most recent text
  assert.ok(prompt.endsWith('word99 is here'))
})

test('collapseRepeats collapses decoder repetition loops', () => {
  assert.equal(
    collapseRepeats('first, first, first, first, first, first,'),
    'first,'
  )
  assert.equal(collapseRepeats('yes, yes'), 'yes, yes') // doubles survive
  assert.equal(collapseRepeats('the numbers look good'), 'the numbers look good')
  assert.equal(
    collapseRepeats('go on go on go on go on please'),
    'go on please'
  )
})

test('mergeSegments drops overlap-echo fragments (words subset of adjacent segment)', () => {
  const merged = mergeSegments(
    [{ t0: 8.6, t1: 12.6, text: 'The churn rate dropped below 2% last month.', speaker: 'you' }],
    [{ t0: 12.1, t1: 13.9, text: 'Last month', speaker: 'you' }]
  )

  assert.equal(merged.length, 1)
})

test('mergeSegments dedupes identical segments within one batch', () => {
  const merged = mergeSegments(
    [],
    [
      { t0: 12.5, t1: 13.5, text: 'We should look at the numbers.', speaker: 'you' },
      { t0: 13.5, t1: 14.5, text: 'We should look at the numbers.', speaker: 'you' }
    ]
  )

  assert.equal(merged.length, 1)
})

test('mergeSegments keeps a short genuine reply that is not near the previous segment', () => {
  const merged = mergeSegments(
    [{ t0: 0, t1: 3, text: 'Should we ship it last month or next month?', speaker: 'others' }],
    [{ t0: 6, t1: 7, text: 'Next month.', speaker: 'you' }]
  )

  assert.equal(merged.length, 2)
})
