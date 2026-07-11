import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateSaveTranscriptPayload,
  validateSegment,
  validateTranscribeChunkPayload
} from './transcript.ts'

test('validateSegment accepts a well-formed transcript segment', () => {
  assert.deepEqual(
    validateSegment({ t0: 1, t1: 2, text: 'hello', speaker: 'you' }),
    { t0: 1, t1: 2, text: 'hello', speaker: 'you' }
  )
})

test('validateSegment rejects invalid timestamps', () => {
  assert.throws(
    () => validateSegment({ t0: 3, t1: 2, text: 'hello', speaker: 'others' }),
    /Invalid transcript segment timestamps/
  )
})

test('validateSaveTranscriptPayload validates every segment', () => {
  assert.throws(
    () => validateSaveTranscriptPayload({ startedAt: '2026-05-16T10:30:00Z', segments: [{ t0: 0, t1: 1, text: 'x', speaker: 'bad' }] }),
    /Invalid transcript segment speaker/
  )
})

test('validateTranscribeChunkPayload accepts ArrayBuffer chunks', () => {
  const pcm = new ArrayBuffer(4)

  assert.deepEqual(
    validateTranscribeChunkPayload({ id: 1, pcm, sampleRate: 16000, source: 'others' }),
    { id: 1, pcm, sampleRate: 16000, source: 'others' }
  )
})

test('validateTranscribeChunkPayload rejects invalid sources', () => {
  assert.throws(
    () => validateTranscribeChunkPayload({ id: 1, pcm: new ArrayBuffer(4), sampleRate: 16000, source: 'system' }),
    /Invalid source/
  )
})

test('validateTranscribeChunkPayload accepts and caps prompt', () => {
  const payload = validateTranscribeChunkPayload({
    id: 1,
    pcm: new ArrayBuffer(4),
    sampleRate: 16000,
    source: 'you',
    prompt: 'x'.repeat(5000)
  })
  assert.equal(payload.prompt?.length, 2000)

  assert.throws(() =>
    validateTranscribeChunkPayload({
      id: 1,
      pcm: new ArrayBuffer(4),
      sampleRate: 16000,
      source: 'you',
      prompt: 42
    })
  )
})
