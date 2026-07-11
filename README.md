# Transcribe

Personal cross-platform meeting transcriber. Captures system audio (the other meeting participants) + your microphone, transcribes locally with whisper.cpp, saves a markdown file. **Audio never leaves your machine.**

Works for any meeting app — Zoom, Google Meet, Teams, Discord, FaceTime — because it captures whatever the OS is playing.

## One-time setup

```bash
cd transcribe
npm install
npm run fetch-whisper   # downloads whisper.cpp binary (Windows) or installs via Homebrew (Mac)
npm run fetch-model     # downloads ggml-small.en.bin (~470 MB)
```

## Run

```bash
npm run dev
```

Click the green record button. On first launch:

- **Windows**: a permission prompt appears for the screen-share picker — pick "Entire Screen" with the audio toggle ON.
- **macOS 13+**: grant Screen Recording + Microphone permission in System Settings → Privacy. May need to relaunch after granting.
- **macOS < 13**: not supported without a virtual audio driver (BlackHole). Upgrade if possible.

While recording, transcripts appear moments after each utterance ends (chunks are cut at speech pauses, max 4 seconds). When you stop, the full transcript is written to:

- **Windows**: `%APPDATA%/transcribe/transcripts/`
- **macOS**: `~/Library/Application Support/transcribe/transcripts/`

Use the History tab in-app to browse and view past transcripts.

If the model is missing (e.g. fresh install of the packaged app), the app shows a **Download model** button and fetches it in-app with a progress bar — no npm needed.

While recording, the transcript-so-far is autosaved every few seconds to a `.md.partial` file next to the transcripts. If the app crashes mid-meeting, the partial is recovered as `<name>-recovered.md` on next launch.

## Tech

- **Electron 33** + React 18 + Vite + Tailwind v4
- **whisper.cpp** for transcription, runs on CPU (no GPU required)
- **whisper-server** keeps the model loaded in RAM between chunks (spawned once, HTTP on localhost); falls back to spawning the CLI per chunk if the server binary is missing
- Silence gating in the audio worklet (RMS < −60 dBFS chunks are skipped) plus a hallucination filter for whisper's stock silence artifacts ("[BLANK_AUDIO]", "Thanks for watching!", …)
- System audio captured via Electron's `setDisplayMediaRequestHandler({ audio: 'loopback' })` — uses ScreenCaptureKit on macOS 13+ and WASAPI loopback on Windows. No virtual audio driver needed.
- VAD endpointing: chunks are cut at speech pauses (max 4s), and each chunk is decoded conditioned on the transcript so far for better punctuation and accuracy

## Models

Default is `small.en` (English-only, ~470 MB, fast on CPU). To use a different model:

```bash
WHISPER_MODEL=medium.en npm run fetch-model    # bigger / more accurate
WHISPER_MODEL=tiny.en   npm run fetch-model    # tiny / very fast
WHISPER_MODEL=small     npm run fetch-model    # multilingual
```

Then set the same `WHISPER_MODEL` env var when launching. The app reads `WHISPER_MODEL` at runtime, defaulting to `small.en` when it is not set.

## Project layout

```
src/
  main/                # Electron main process — window, IPC, whisper.cpp spawn, file IO
  preload/             # contextBridge surface (window.api)
  renderer/src/        # React UI
    audio-capture.ts   # getDisplayMedia + getUserMedia → AudioWorklet
    audio-worklet.ts   # 16-kHz PCM chunker (runs on the audio thread)
    App.tsx, components/
resources/
  whisper-bin/         # whisper.cpp binary (downloaded by fetch-whisper)
scripts/               # fetch-whisper.mjs, fetch-model.mjs
```
