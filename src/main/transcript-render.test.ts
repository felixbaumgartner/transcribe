import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderTranscriptMarkdown } from './transcript-render.ts'

const T0 = new Date('2026-05-16T10:30:00Z')

test('renders speaker label per segment when speaker is set', () => {
  const md = renderTranscriptMarkdown(T0, [
    { t0: 0, t1: 3, text: 'hello team', speaker: 'others' },
    { t0: 4, t1: 6, text: 'hi back', speaker: 'you' }
  ])

  assert.match(md, /\*\*\[00:00\] Others:\*\* hello team/)
  assert.match(md, /\*\*\[00:04\] You:\*\* hi back/)
})

test('emits Speakers stats line when both sources produced segments', () => {
  const md = renderTranscriptMarkdown(T0, [
    { t0: 0, t1: 4, text: 'a', speaker: 'others' }, // 4s
    { t0: 5, t1: 6, text: 'b', speaker: 'you' } // 1s
  ])

  assert.match(md, /Speakers: You 20% \/ Others 80%/)
})

test('omits Speakers stats line when only one source produced segments', () => {
  const md = renderTranscriptMarkdown(T0, [
    { t0: 0, t1: 4, text: 'a', speaker: 'others' },
    { t0: 5, t1: 6, text: 'b', speaker: 'others' }
  ])

  assert.equal(/Speakers:/.test(md), false)
})

test('renders legacy segments (no speaker) with no label and no crash', () => {
  const md = renderTranscriptMarkdown(T0, [
    { t0: 0, t1: 3, text: 'plain text segment' }
  ])

  assert.match(md, /\*\*\[00:00\]\*\* plain text segment/)
  // No You: or Others: prefix should appear.
  assert.equal(/Others:|You:/.test(md), false)
  assert.equal(/Speakers:/.test(md), false)
})

test('mixes legacy and labeled segments without breaking format', () => {
  const md = renderTranscriptMarkdown(T0, [
    { t0: 0, t1: 2, text: 'old style' },
    { t0: 3, t1: 5, text: 'new style', speaker: 'you' }
  ])

  assert.match(md, /\*\*\[00:00\]\*\* old style/)
  assert.match(md, /\*\*\[00:03\] You:\*\* new style/)
})
