// AudioWorklet processor: collects mono Float32 audio at the AudioContext sample rate
// (we configure it to 16000 Hz on the renderer side) and emits 16-bit PCM chunks
// back to the main thread every chunkSeconds, with overlapSeconds of overlap so
// whisper doesn't cut words at chunk boundaries.
//
// processorOptions: { source?: 'you' | 'others'; chunkSeconds?: number; overlapSeconds?: number }
//   Each instance is dedicated to a single audio source (mic or system). The source tag
//   is stamped on every outgoing message so the main thread can route chunks to the
//   right transcription queue and label segments downstream.

class ChunkerProcessor extends AudioWorkletProcessor {
  private chunkSamples: number
  private overlapSamples: number
  private buffer: Float32Array
  private writeIdx = 0
  private chunkId = 0
  private source: 'you' | 'others' | undefined

  constructor(options?: AudioWorkletNodeOptions) {
    super()
    const opts = (options?.processorOptions ?? {}) as {
      source?: 'you' | 'others'
      chunkSeconds?: number
      overlapSeconds?: number
    }
    this.source = opts.source
    const chunkSeconds = typeof opts.chunkSeconds === 'number' && opts.chunkSeconds > 0 ? opts.chunkSeconds : 30
    const overlapSeconds = typeof opts.overlapSeconds === 'number' && opts.overlapSeconds >= 0 ? opts.overlapSeconds : 2
    // sampleRate is a global in AudioWorkletGlobalScope.
    this.chunkSamples = Math.floor(sampleRate * chunkSeconds)
    this.overlapSamples = Math.floor(sampleRate * overlapSeconds)
    this.buffer = new Float32Array(this.chunkSamples)

    this.port.onmessage = (e) => {
      if (e.data?.command === 'flush') {
        this.flush(true)
        this.port.postMessage({ type: 'flushed', source: this.source })
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Mix to mono if multi-channel
    const channels = input.length
    const frames = input[0].length
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i] || 0
      this.buffer[this.writeIdx++] = sum / channels

      if (this.writeIdx >= this.chunkSamples) {
        this.flush()
      }
    }
    return true
  }

  private flush(isFinal = false): void {
    if (this.writeIdx === 0) return
    // Skip very short tails — whisper produces nothing useful from <0.5s of audio
    // and may emit hallucinations on a tiny clip.
    const minSamples = Math.floor(sampleRate * 0.5)
    if (isFinal && this.writeIdx < minSamples) {
      this.writeIdx = 0
      return
    }

    const float = this.buffer.subarray(0, this.writeIdx)

    // Energy gate: don't transcribe silence. Whisper burns a full inference pass
    // on it and tends to hallucinate text ("Thank you.", "[BLANK_AUDIO]", …).
    // -60 dBFS RMS is far below any speech (even quiet speech is ~-40 dBFS) but
    // above pure digital silence from an idle loopback. The chunk id still
    // advances so downstream timestamp offsets (id * stride) stay aligned.
    const SILENCE_RMS = 0.001
    let sumSq = 0
    for (let i = 0; i < float.length; i++) sumSq += float[i] * float[i]
    const rms = Math.sqrt(sumSq / float.length)
    if (rms < SILENCE_RMS) {
      this.chunkId++
      if (isFinal) {
        this.writeIdx = 0
        return
      }
      const silentTail = Math.min(this.overlapSamples, this.writeIdx)
      if (silentTail > 0) {
        this.buffer.copyWithin(0, this.writeIdx - silentTail, this.writeIdx)
        this.writeIdx = silentTail
      } else {
        this.writeIdx = 0
      }
      return
    }

    const pcm = new Int16Array(float.length)
    for (let i = 0; i < float.length; i++) {
      let s = Math.max(-1, Math.min(1, float[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    this.port.postMessage(
      {
        id: this.chunkId++,
        pcm: pcm.buffer,
        sampleRate,
        source: this.source
      },
      [pcm.buffer]
    )

    if (isFinal) {
      // Last chunk — no need to keep overlap.
      this.writeIdx = 0
      return
    }

    // Keep tail for overlap so the next chunk doesn't cut a word.
    const tail = Math.min(this.overlapSamples, this.writeIdx)
    if (tail > 0) {
      this.buffer.copyWithin(0, this.writeIdx - tail, this.writeIdx)
      this.writeIdx = tail
    } else {
      this.writeIdx = 0
    }
  }
}

registerProcessor('chunker', ChunkerProcessor)
