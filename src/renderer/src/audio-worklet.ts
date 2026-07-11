// AudioWorklet processor: collects mono Float32 audio at the AudioContext sample rate
// (we configure it to 16000 Hz on the renderer side) and emits 16-bit PCM chunks
// segmented at speech boundaries (VAD endpointing):
//
//   - a chunk is cut when an utterance ends (~0.65s of trailing silence), so short
//     replies transcribe quickly instead of waiting for a timer
//   - continuous speech is force-cut at maxChunkSeconds, at the quietest point in
//     the recent audio (a micro-pause between words); the remainder past that point
//     carries into the next chunk. No audio is ever transcribed twice — overlap
//     replay confuses whisper once the same words are also in its context prompt.
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
// Must sit ABOVE comma/breath pauses (~0.3-0.5s): cutting at a comma strands
// fragments like "First," in their own chunk, which whisper decodes badly
// (repetition loops, fallback retries). Sentence gaps are ~0.7s+.
const SILENCE_HOLD_SECONDS = 0.65
// Don't emit a chunk shorter than this on a silence cut. Two constraints: whisper
// hallucinates on sub-second blips, and each chunk carries fixed decode overhead,
// so this floor also caps the chunk rate at one per ~2.4s (min + silence hold) —
// below the ~1-1.5s it takes to transcribe a short chunk.
const MIN_CHUNK_SECONDS = 1.75
// On a forced cut, search this much trailing audio for the quietest block to cut at.
const CUT_SEARCH_SECONDS = 1.5
// Whisper produces nothing useful from clips shorter than this.
const MIN_EMIT_SECONDS = 0.5

class ChunkerProcessor extends AudioWorkletProcessor {
  private maxChunkSamples: number
  private minChunkSamples: number
  private silenceHoldSamples: number
  private cutSearchSamples: number
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
  // Per-block energy history for the current buffer: [end sample index, rms].
  // Used to pick the quietest cut point on a forced cut.
  private blockRms: Array<[number, number]> = []
  // Raw session feed: the full untrimmed audio, batched into ~1s Int16 posts,
  // streamed to disk by the main process for the post-meeting refinement pass.
  private rawBuf = new Int16Array(sampleRate)
  private rawIdx = 0

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
    this.cutSearchSamples = Math.floor(sampleRate * CUT_SEARCH_SECONDS)
    // +256 headroom: cut checks run after appending a (typically 128-sample) block.
    this.buffer = new Float32Array(this.maxChunkSamples + 256)

    this.port.onmessage = (e) => {
      if (e.data?.command === 'flush') {
        this.cut(false, true)
        this.flushRaw()
        this.port.postMessage({ type: 'flushed', source: this.source })
      }
    }
  }

  private flushRaw(): void {
    if (this.rawIdx === 0) return
    const out = this.rawBuf.slice(0, this.rawIdx)
    this.port.postMessage({ type: 'raw', pcm: out.buffer, source: this.source }, [out.buffer])
    this.rawIdx = 0
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channels = input.length
    const frames = input[0].length
    if (this.writeIdx + frames > this.buffer.length) {
      this.cut(true, false)
    }

    // Mix to mono, measure block energy, and feed the raw session stream in one pass.
    let sumSq = 0
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i] || 0
      const v = sum / channels
      this.buffer[this.writeIdx + i] = v
      sumSq += v * v
      const clamped = Math.max(-1, Math.min(1, v))
      this.rawBuf[this.rawIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      if (this.rawIdx >= this.rawBuf.length) this.flushRaw()
    }
    this.writeIdx += frames

    const rms = Math.sqrt(sumSq / frames)
    this.blockRms.push([this.writeIdx, rms])
    if (rms >= SPEECH_RMS) {
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
    if (this.writeIdx === 0) return

    // Nothing worth transcribing — drop the audio but keep absolute time moving.
    if (!this.hasSpeech || this.writeIdx < Math.floor(sampleRate * MIN_EMIT_SECONDS)) {
      this.reset(this.writeIdx)
      return
    }

    // A forced cut lands mid-speech; emitting up to the quietest recent block
    // (usually a gap between words) avoids slicing a word in half. The remainder
    // past the cut point has NOT been transcribed and carries into the next chunk.
    let len = this.writeIdx
    if (forced && !isFinal) {
      let quietest = Infinity
      for (const [end, rms] of this.blockRms) {
        if (end < this.writeIdx - this.cutSearchSamples || end > this.writeIdx) continue
        if (rms < quietest) {
          quietest = rms
          len = end
        }
      }
    }

    // Trim silence at both ends of the emitted window. Whisper wastes decode
    // time on silence and tends to hallucinate repetition loops over a silent
    // tail; a short pad is kept so word onsets/decays aren't clipped.
    const pad = Math.floor(sampleRate * 0.15)
    let firstSpeech = -1
    let lastSpeech = -1
    let prevEnd = 0
    for (const [end, rms] of this.blockRms) {
      if (end > len) break
      if (rms >= SPEECH_RMS) {
        if (firstSpeech === -1) firstSpeech = prevEnd
        lastSpeech = end
      }
      prevEnd = end
    }
    if (firstSpeech === -1) {
      // The window up to the cut point is all silence (speech lives past it) —
      // consume it without emitting.
      this.reset(len)
      return
    }
    const emitStart = Math.max(0, firstSpeech - pad)
    const emitEnd = Math.min(len, lastSpeech + pad)
    if (emitEnd - emitStart < Math.floor(sampleRate * MIN_EMIT_SECONDS)) {
      this.reset(len)
      return
    }

    const float = this.buffer.subarray(emitStart, emitEnd)
    const pcm = new Int16Array(float.length)
    for (let i = 0; i < float.length; i++) {
      const s = Math.max(-1, Math.min(1, float[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    this.port.postMessage(
      {
        id: this.chunkId++,
        pcm: pcm.buffer,
        sampleRate,
        source: this.source,
        startSeconds: (this.bufferStartSample + emitStart) / sampleRate
      },
      [pcm.buffer]
    )

    this.reset(len)
  }

  /** Consume `consumed` samples: shift the remainder to the front, rebase state. */
  private reset(consumed: number): void {
    const remainder = this.writeIdx - consumed
    if (remainder > 0) {
      this.buffer.copyWithin(0, consumed, this.writeIdx)
    }
    this.bufferStartSample += consumed
    this.writeIdx = remainder
    this.trailingSilence = Math.min(this.trailingSilence, remainder)
    this.blockRms = this.blockRms
      .filter(([end]) => end > consumed)
      .map(([end, rms]) => [end - consumed, rms])
    this.hasSpeech = this.blockRms.some(([, rms]) => rms >= SPEECH_RMS)
  }
}

registerProcessor('chunker', ChunkerProcessor)
