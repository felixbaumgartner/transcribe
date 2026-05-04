// AudioWorklet processor: collects mono Float32 audio at the AudioContext sample rate
// (we configure it to 16000 Hz on the renderer side) and emits 16-bit PCM chunks
// back to the main thread every CHUNK_SECONDS, with OVERLAP_SECONDS of overlap so
// whisper doesn't cut words at chunk boundaries.

class ChunkerProcessor extends AudioWorkletProcessor {
  private chunkSamples: number
  private overlapSamples: number
  private buffer: Float32Array
  private writeIdx = 0
  private chunkId = 0

  constructor() {
    super()
    // sampleRate is a global in AudioWorkletGlobalScope.
    const CHUNK_SECONDS = 30
    const OVERLAP_SECONDS = 2
    this.chunkSamples = Math.floor(sampleRate * CHUNK_SECONDS)
    this.overlapSamples = Math.floor(sampleRate * OVERLAP_SECONDS)
    this.buffer = new Float32Array(this.chunkSamples)
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

  private flush(): void {
    const float = this.buffer.subarray(0, this.writeIdx)
    const pcm = new Int16Array(float.length)
    for (let i = 0; i < float.length; i++) {
      let s = Math.max(-1, Math.min(1, float[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    this.port.postMessage(
      {
        id: this.chunkId++,
        pcm: pcm.buffer,
        sampleRate
      },
      [pcm.buffer]
    )

    // Keep tail for overlap
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
