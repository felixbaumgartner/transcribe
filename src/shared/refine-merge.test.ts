import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeRefinedSources } from './refine-merge.ts'

test('mergeRefinedSources interleaves sources by time', () => {
  const merged = mergeRefinedSources(
    [{ t0: 5, t1: 8, text: 'I think we should ship it.', speaker: 'you' }],
    [
      { t0: 0, t1: 4, text: 'What do you think?', speaker: 'others' },
      { t0: 9, t1: 12, text: 'Agreed, let us ship.', speaker: 'others' }
    ]
  )

  assert.deepEqual(
    merged.map((s) => s.speaker),
    ['others', 'you', 'others']
  )
})

test('mergeRefinedSources drops cross-source echo, keeping the mic copy', () => {
  const merged = mergeRefinedSources(
    [{ t0: 10, t1: 12, text: 'Okay sounds good.', speaker: 'you' }],
    [{ t0: 10.4, t1: 12.4, text: ' okay  sounds good. ', speaker: 'others' }]
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].speaker, 'you')
})

test('mergeRefinedSources keeps same text said far apart', () => {
  const merged = mergeRefinedSources(
    [{ t0: 0, t1: 1, text: 'Yes.', speaker: 'you' }],
    [{ t0: 30, t1: 31, text: 'Yes.', speaker: 'others' }]
  )

  assert.equal(merged.length, 2)
})

test('mergeRefinedSources drops blanks and sound annotations', () => {
  const merged = mergeRefinedSources(
    [{ t0: 0, t1: 1, text: '  ' }],
    [
      { t0: 2, t1: 3, text: '[BLANK_AUDIO]' },
      { t0: 4, t1: 6, text: 'Real words.' }
    ]
  )

  assert.deepEqual(merged.map((s) => s.text), ['Real words.'])
})
