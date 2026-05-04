// Minimal ambient typings for the AudioWorkletGlobalScope so audio-worklet.ts
// type-checks. The full @types/audioworklet package adds a lot of unrelated stuff.

declare const sampleRate: number
declare const currentFrame: number
declare const currentTime: number

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
}

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor
): void
