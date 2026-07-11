// AudioWorklet processor: collects mono Float32 audio at the AudioContext sample rate
// (we configure it to 16000 Hz on the renderer side) and emits 16-bit PCM chunks
// segmented at speech boundaries (VAD endpointing):
//
//   - a chunk is cut when an utterance ends (~400ms of trailing silence), so short
//     replies transcribe ~1s after the speaker stops instead of waiting for a timer
//   - continuous speech is force-cut at maxChunkSeconds, keeping a small overlap
//     tail so no word is lost mid-cut (silence cuts need no overlap)
//   - buffers containing no speech at all are dropped without transcription
//
// Every chunk is stamped with startSeconds — its absolute position in the capture —
// so downstream timestamp alignment works with variable-length chunks.
//
// processorOptions: { source?: 'you' | 'others'; maxChunkSeconds?: number }
//   Each instance is dedicated to a single audio source (mic or system). The source
//   tag is stamped on every outgoing message so the main thread can route chunks to
//   the right transcription queue and label segments downstream.

// Per-128-frame-block RMS above this counts as speech. -54 dBFS: comfortably below
// quiet speech (~-40 dBFS) and above idle-loopback/mic-floor noise.
const SPEECH_RMS = 0.002
// An utterance is considered finished after this much continuous silence.
const SILENCE_HOLD_SECONDS = 0.4
// Don't emit a chunk shorter than this on a silence cut. Two constraints: whisper
// hallucinates on sub-second blips, and each chunk carries fixed decode overhead,
// so this floor also caps the chunk rate at one per ~2.2s (min + silence hold) —
// below the ~1-1.5s it takes to transcribe a short chunk.
const MIN_CHUNK_SECONDS = 1.75
// Overlap tail kept only when a forced (mid-speech) cut happens.
const FORCED_OVERLAP_SECONDS = 0.5
// Whisper produces nothing useful from clips shorter than this.
const MIN_EMIT_SECONDS = 0.5

class ChunkerProcessor extends AudioWorkletProcessor {
  private maxChunkSamples: number
  private minChunkSamples: number
  private silenceHoldSamples: number
  private forcedOverlapSamples: number
  private buffer: Float32Array
  private writeIdx = 0
  private chunkId = 0
  private source: 'you' | 'others' | undefined
  // Whether the current buffer contains any speech-level audio.
  private hasSpeech = false
  // Continuous silence (in samples) at the end of the current buffer.
  private trailingSilence = 0
  // Absolute sample index (since capture start) of buffer[0].
  private bufferStartSample = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super()
    const opts = (options?.processorOptions ?? {}) as {
      source?: 'you' | 'others'
      maxChunkSeconds?: number
    }
    this.source = opts.source
    const maxChunkSeconds =
      typeof opts.maxChunkSeconds === 'number' && opts.maxChunkSeconds > 0 ? opts.maxChunkSeconds : 4
    // sampleRate is a global in AudioWorkletGlobalScope.
    this.maxChunkSamples = Math.floor(sampleRate * maxChunkSeconds)
    this.minChunkSamples = Math.floor(sampleRate * MIN_CHUNK_SECONDS)
    this.silenceHoldSamples = Math.floor(sampleRate * SILENCE_HOLD_SECONDS)
    this.forcedOverlapSamples = Math.floor(sampleRate * FORCED_OVERLAP_SECONDS)
    // +256 headroom: cut checks run after appending a (typically 128-sample) block.
    this.buffer = new Float32Array(this.maxChunkSamples + 256)

    this.port.onmessage = (e) => {
      if (e.data?.command === 'flush') {
        this.cut(false, true)
        this.port.postMessage({ type: 'flushed', source: this.source })
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channels = input.length
    const frames = input[0].length
    if (this.writeIdx + frames > this.buffer.length) {
      this.cut(true, false)
    }

    // Mix to mono and measure block energy in one pass.
    let sumSq = 0
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i] || 0
      const v = sum / channels
      this.buffer[this.writeIdx + i] = v
      sumSq += v * v
    }
    this.writeIdx += frames

    if (Math.sqrt(sumSq / frames) >= SPEECH_RMS) {
      this.hasSpeech = true
      this.trailingSilence = 0
    } else {
      this.trailingSilence += frames
    }

    if (this.writeIdx >= this.maxChunkSamples) {
      this.cut(true, false)
    } else if (
      this.hasSpeech &&
      this.trailingSilence >= this.silenceHoldSamples &&
      this.writeIdx >= this.minChunkSamples
    ) {
      this.cut(false, false)
    }
    return true
  }

  private cut(forced: boolean, isFinal: boolean): void {
    const len = this.writeIdx
    if (len === 0) return

    // Nothing worth transcribing — drop the audio but keep absolute time moving.
    if (!this.hasSpeech || len < Math.floor(sampleRate * MIN_EMIT_SECONDS)) {
      this.bufferStartSample += len
      this.writeIdx = 0
      this.hasSpeech = false
      this.trailingSilence = 0
      return
    }

    const float = this.buffer.subarray(0, len)
    const pcm = new Int16Array(len)
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, float[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    this.port.postMessage(
      {
        id: this.chunkId++,
        pcm: pcm.buffer,
        sampleRate,
        source: this.source,
        startSeconds: this.bufferStartSample / sampleRate
      },
      [pcm.buffer]
    )

    if (forced && !isFinal) {
      // Cut mid-speech: keep a tail so the next chunk re-hears the sliced word.
      const tail = Math.min(this.forcedOverlapSamples, len)
      this.buffer.copyWithin(0, len - tail, len)
      this.bufferStartSample += len - tail
      this.writeIdx = tail
      this.trailingSilence = Math.min(this.trailingSilence, tail)
      this.hasSpeech = this.trailingSilence < tail
    } else {
      this.bufferStartSample += len
      this.writeIdx = 0
      this.hasSpeech = false
      this.trailingSilence = 0
    }
  }
}

registerProcessor('chunker', ChunkerProcessor)
