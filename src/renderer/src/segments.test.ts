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
