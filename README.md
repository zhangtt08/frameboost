# FrameBoost

**A local, offline video frame-interpolation app for Windows.** Feed it a low-frame-rate video (e.g. 30 fps) and it outputs a smooth high-frame-rate version (60/90/120 fps+) via FFmpeg optical-flow interpolation or frame blending — with NVENC hardware encoding, 10-bit preservation and HDR color-metadata passthrough. Nothing is ever uploaded; all processing happens on your machine.

> 一款全程本地处理的 Windows 视频补帧桌面应用：把 30fps 视频插帧到 60fps+，光流补偿 / 帧混合两档原理，NVENC 硬件加速编码，10bit 与 HDR 色彩元数据完整保留。

English | [简体中文](./README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-bundled%2C%20no%20install-007808?logo=ffmpeg&logoColor=white)
![NVENC](https://img.shields.io/badge/encoding-NVENC%20accelerated-76B900)

**The problem it solves:** low-frame-rate footage looks choppy, and FFmpeg's stock `minterpolate` one-liner is a trap — it silently drops frames at the tail, wrecks 10-bit and HDR color, and re-encodes audio for no reason. FrameBoost wraps carefully engineered ffmpeg filter chains in a simple drag-and-drop queue app: exact output frame counts, color metadata carried through untouched, hardware encoding when available, and automatic multi-level fallback when it is not. It trades speed for quality and tells you so up front (see [Performance expectations](#performance-expectations)).

![Screenshot](docs/screenshot.png)

## ✨ Features

### Three interpolation modes

| Mode | How it works | Best for |
|---|---|---|
| Optical flow · Fine | `minterpolate` AOBMC adaptive block size + bidirectional motion estimation + variational weighting | Quality first, slow is fine |
| Optical flow · Balanced | `minterpolate` OBMC motion compensation | Most videos (recommended) |
| Frame blending | Weighted fusion of adjacent frames (`framerate` filter) | Speed first; slight ghosting on fast motion |

### Picture-quality engineering

- **Quality tiers** — Master (x264 CRF 10, visually lossless, for re-editing/archival), High (CRF 16, recommended), Standard (CRF 20).
- **Exact frame count** — the filter chain uses `tpad` clone-padding → interpolation → `trim` back to the original duration, fixing the tail-frame loss of naive `minterpolate` chains (verified: 3 s @ 30→60 fps outputs exactly 180 frames) so audio and video stay in sync.
- **10-bit preserved** — 10-bit sources produce 10-bit output (encoder capability is probed automatically; falls back to 8-bit with a notice).
- **Color metadata passthrough** — bt709 / bt2020 / PQ primaries, transfer characteristics and colorspace are written to the output as-is, so HDR sources don't turn washed out.
- **Lossless audio copy** — `-c:a copy` by default; automatic re-encode to AAC only when the codec is incompatible with the container (e.g. Opus → MP4).
- **NVENC hardware acceleration** — auto-detected (both older and current driver presets); falls back through multiple CPU levels if NVENC is unavailable or fails; skipped automatically for 10-bit output.
- **Guard rails** — falls back to `avg_frame_rate` when `r_frame_rate` misreports via timebase (e.g. 90000/1); excludes embedded cover-art streams so the main video stream is always the one interpolated; never overwrites (`(1)` suffix on collision).

### Workflow

- **Batch queue** — drag & drop or multi-select; each item gets its own status badge (waiting / processing / done / failed / cancelled).
- **One-click retry** of failed items after the queue finishes; cancel stops the whole queue.
- **Live progress** — percent, processed duration, output frame count, processing fps, relative speed, ETA; cancellable at any time.
- **Persistent preferences** — interpolation mode, quality, target fps, container and hardware settings are remembered.
- **Preview & info panel** — resolution / fps / duration / codec / audio / size; output info after completion with a one-click "open folder".
- **Close-window guard** while a job is running.

## 🚀 Quick Start

### Download (recommended)

Grab `FrameBoost.exe` from [Releases](https://github.com/zhangtt08/frameboost/releases) — a Windows x64 portable build (no installer), with ffmpeg bundled (~135 MB). Run it and drop a video in.

### Build from source

Prerequisites: Windows, Node.js ≥ 20.19 (22 LTS recommended).

```bash
git clone https://github.com/zhangtt08/frameboost.git
cd frameboost
npm install
npm run dev            # vite + electron dev mode
npm run test:pipeline  # unit tests for the ffmpeg filter-chain builder (42 assertions)
npm run sample         # generate a 6-second 30fps demo clip
npm run dist           # package a portable exe into release/
```

On Windows you can also just double-click `启动开发模式.cmd` / `打包Windows.cmd` (dependencies install automatically on first run).

Test inputs (`tests/`) cover: no audio track, Opus audio, embedded cover art, 10-bit, MKV container.

### Options

- Target frame rate: ×2 / ×3 / ×4 or custom (5–480, must exceed the source fps).
- Container: MP4 (faststart) / MKV.
- Env vars `FFMPEG_PATH` / `FFPROBE_PATH` point to a custom ffmpeg (e.g. a newer build for newer NVENC support); the bundled one is used by default.

## 🏗️ Architecture / How it works

```
electron/
├─ main.ts      # app lifecycle, window, IPC
├─ pipeline.ts  # pure logic: ffmpeg filter chains, NVENC attempt plans, fallback levels
└─ preload.ts   # contextBridge (contextIsolation + sandbox)
src/            # React renderer: queue UI, progress, preferences
scripts/        # dev/test/sample/icon helpers
```

`pipeline.ts` builds the complete ffmpeg invocation as a pure, unit-tested plan: it picks the interpolation filter chain, probes encoder capabilities (10-bit support, NVENC presets), and produces an ordered list of attempts — NVENC first when available, then CPU fallback levels — so a failed hardware attempt degrades gracefully instead of failing the job. Scene changes are auto-detected (`scd`) and use frame copies to avoid cross-shot ghosting.

## Performance expectations

Optical-flow interpolation is CPU-bound: measured at roughly **0.4× realtime for 640×360**, and typically **0.05–0.2× for 1080p**. The recommended workflow is to confirm parameters quickly with *Frame blending*, then render the final output with an optical-flow mode. NVENC accelerates encoding only — interpolation itself is always done on the CPU.

## 📄 License

[MIT](./LICENSE)

## 🤖 Agent API

While the app is running, a local HTTP API is available on `127.0.0.1:8393`:

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/health` | GET | — | version |
| `/api/nvenc` | GET | — | NVENC capability (`none` / `legacy` / `modern`) |
| `/api/probe` | POST | `{inputPath}` | duration, fps, pixFmt, codec, 10-bit info |
| `/api/render` | POST | `{inputPath, outputPath, targetFps, mode: "high"\|"balanced"\|"fast", quality?, useNvenc?, container?}` | 202 accepted (renders asynchronously) |
| `/api/job` | GET | — | live progress + last render result (`outputPath`, `sizeBytes`, `fps`) |

Port override: `FRAMEBOOST_API_PORT`.

## 📄 License
