// Renderer-side audio capture pipeline.
//
// 1. getDisplayMedia({audio:true})  → system audio (the other meeting participants)
// 2. getUserMedia({audio:true})     → your mic
// 3. Both are connected into a single AudioContext running at 16 kHz
// 4. An AudioWorklet emits 30-second Int16 PCM chunks (with 2s overlap)
// 5. Each chunk is sent to the main process for whisper.cpp transcription
//
// Why 16 kHz: whisper.cpp consumes 16 kHz mono PCM. Constructing the AudioContext
// at this rate makes the browser do the resampling for us — simpler than rolling our own.

import workletUrl from './audio-worklet.ts?worker&url'

export interface CaptureHandle {
  stop(): Promise<void>
  startedAt: Date
}

export interface ChunkMessage {
  id: number
  pcm: ArrayBuffer
  sampleRate: number
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

  // Mic — best-effort; if denied we still record system audio
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

  const sysSrc = ctx.createMediaStreamSource(displayStream)
  const merger = ctx.createGain()
  sysSrc.connect(merger)
  if (micStream) {
    const micSrc = ctx.createMediaStreamSource(micStream)
    micSrc.connect(merger)
  }

  const node = new AudioWorkletNode(ctx, 'chunker', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  })
  // Single dispatcher for everything coming from the worklet. Typed messages
  // (e.g. 'flushed') are control signals; un-typed messages are real audio chunks.
  let onFlushed: (() => void) | null = null
  node.port.onmessage = (e) => {
    const msg = e.data
    if (msg?.type === 'flushed') {
      onFlushed?.()
      return
    }
    if (msg?.type) return
    onChunk(msg as ChunkMessage)
  }
  merger.connect(node)

  // Pump the graph to a muted destination so the AudioContext actually runs even though
  // our sink AudioWorkletNode has no outputs of its own.
  const silentSink = ctx.createGain()
  silentSink.gain.value = 0
  merger.connect(silentSink)
  silentSink.connect(ctx.destination)

  // AudioContext can start suspended on Windows when created after an awaited gesture.
  if (ctx.state === 'suspended') await ctx.resume()

  const startedAt = new Date()

  return {
    startedAt,
    async stop() {
      // Ask the worklet to flush whatever's left in its buffer (the last <30s of audio)
      // before tearing down, otherwise the tail of the recording is silently discarded.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          onFlushed = null
          resolve()
        }, 1000)
        onFlushed = () => {
          clearTimeout(timer)
          onFlushed = null
          resolve()
        }
        node.port.postMessage({ command: 'flush' })
      })

      try {
        node.disconnect()
        merger.disconnect()
        sysSrc.disconnect()
      } catch {}
      for (const s of [displayStream, micStream]) {
        if (!s) continue
        for (const t of s.getTracks()) t.stop()
      }
      await ctx.close()
    }
  }
}
