// Renderer-side audio capture pipeline.
//
// 1. getDisplayMedia({audio:true})  → system audio (the other meeting participants)
// 2. getUserMedia({audio:true})     → your mic
// 3. Both are connected into a single AudioContext running at 16 kHz
// 4. Each source feeds its OWN AudioWorklet (tagged 'others' for system, 'you' for mic),
//    so each stream is chunked and transcribed independently — that's what powers
//    speaker labels downstream without needing a diarization model.
// 5. Each worklet emits Int16 PCM chunks cut at speech boundaries (VAD endpointing,
//    max 4s), tagged with its source and absolute start time, which the main process
//    routes into per-source whisper.cpp queues.
//
// Why 16 kHz: whisper.cpp consumes 16 kHz mono PCM. Constructing the AudioContext
// at this rate makes the browser do the resampling for us — simpler than rolling our own.

import workletUrl from './audio-worklet.ts?worker&url'
import type { Speaker } from '../../preload/index'

// Hard cap on chunk length during continuous speech. Utterances shorter than this
// are cut earlier, at silence boundaries (see audio-worklet.ts).
const MAX_CHUNK_SECONDS = 4

export interface CaptureHandle {
  stop(): Promise<void>
  startedAt: Date
  micAvailable: boolean
}

export interface ChunkMessage {
  id: number
  pcm: ArrayBuffer
  sampleRate: number
  source: Speaker
  /** Absolute position of this chunk's first sample within the capture. */
  startSeconds: number
}

interface SourceWorklet {
  node: AudioWorkletNode
  src: MediaStreamAudioSourceNode
  source: Speaker
  flushed: Promise<void>
  resolveFlushed: () => void
}

export async function startCapture(onChunk: (c: ChunkMessage) => void): Promise<CaptureHandle> {
  // Request system audio. We pass video:true because some browsers require it,
  // but the main process display-media handler returns 'loopback' audio without video.
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  })

  // Drop video tracks immediately — we only want audio.
  for (const t of displayStream.getVideoTracks()) t.stop()
  if (displayStream.getAudioTracks().length === 0) {
    throw new Error(
      'No system audio available. On macOS this needs the OS-level audio loopback (macOS 13+); on Windows it should "just work".'
    )
  }

  // Mic — best-effort; if denied we still record system audio (and label everything 'others').
  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
  } catch (err) {
    console.warn('Mic capture failed; recording system audio only.', err)
  }

  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.audioWorklet.addModule(workletUrl)

  const worklets: SourceWorklet[] = []

  const makeWorklet = (stream: MediaStream, source: Speaker): SourceWorklet => {
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'chunker', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        source,
        maxChunkSeconds: MAX_CHUNK_SECONDS
      }
    })
    let resolveFlushed: () => void = () => {}
    const flushed = new Promise<void>((resolve) => {
      resolveFlushed = resolve
    })
    node.port.onmessage = (e) => {
      const msg = e.data
      if (msg?.type === 'flushed') {
        resolveFlushed()
        return
      }
      if (msg?.type) return
      onChunk({
        id: msg.id,
        pcm: msg.pcm,
        sampleRate: msg.sampleRate,
        source: msg.source ?? source,
        startSeconds: msg.startSeconds ?? 0
      })
    }
    src.connect(node)
    return { node, src, source, flushed, resolveFlushed }
  }

  worklets.push(makeWorklet(displayStream, 'others'))
  if (micStream) {
    worklets.push(makeWorklet(micStream, 'you'))
  }

  // Pump the graph to a muted destination so the AudioContext actually runs even though
  // our sink AudioWorkletNodes have no outputs of their own. A single silent sink is
  // enough — we just need one connection to ctx.destination to keep the graph alive.
  const silentSink = ctx.createGain()
  silentSink.gain.value = 0
  for (const w of worklets) {
    w.src.connect(silentSink)
  }
  silentSink.connect(ctx.destination)

  // AudioContext can start suspended on Windows when created after an awaited gesture.
  if (ctx.state === 'suspended') await ctx.resume()

  const startedAt = new Date()
  const micAvailable = micStream !== null

  return {
    startedAt,
    micAvailable,
    async stop() {
      // Ask all worklets to flush whatever's left in their buffers (the last tail of audio)
      // before tearing down, otherwise the tail of the recording is silently discarded.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500))
      const flushAll = Promise.all(
        worklets.map((w) => {
          w.node.port.postMessage({ command: 'flush' })
          return w.flushed
        })
      ).then(() => undefined)
      await Promise.race([flushAll, timeout])

      try {
        for (const w of worklets) {
          w.node.disconnect()
          w.src.disconnect()
        }
        silentSink.disconnect()
      } catch {}
      for (const s of [displayStream, micStream]) {
        if (!s) continue
        for (const t of s.getTracks()) t.stop()
      }
      await ctx.close()
    }
  }
}
