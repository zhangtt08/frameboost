// 仅开发预览用：在普通浏览器中打开渲染端时（无 Electron），注入模拟 API，
// 便于用浏览器走查完整 UI 流程（添加 → 设置 → 队列 → 进度 → 完成）。生产构建被摇树移除。
import type { ProbeResponse, StartResult } from './types'

const DEMO = {
  path: 'C:\\Videos\\精彩集锦.mp4',
  fileName: '精彩集锦.mp4',
  sizeBytes: 384921600,
  durationSec: 183.5,
  width: 1920,
  height: 1080,
  fps: 29.97,
  avgFps: 29.97,
  fpsRational: '30000/1001',
  pixFmt: 'yuv420p',
  videoCodec: 'h264',
  videoStreamIndex: 0,
  colorPrimaries: 'bt709',
  colorTrc: 'bt709',
  colorSpace: 'bt709',
  hasAudio: true,
  audioCodec: 'aac'
}

export function installDevMock(): void {
  const listeners: Record<string, ((d: unknown) => void) | null> = {
    progress: null,
    retry: null,
    notice: null,
    done: null,
    error: null,
    cancelled: null
  }
  let timer: ReturnType<typeof setInterval> | null = null

  const api = {
    probe: async (): Promise<ProbeResponse> => ({ ok: true, info: { ...DEMO } }),
    pathForFile: () => '',
    pickVideo: async () => [DEMO.path],
    pickOutput: async (def: string) => def,
    showInFolder: async () => undefined,
    getMeta: async () => ({
      ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
      ffprobePath: 'C:\\ffmpeg\\bin\\ffprobe.exe',
      ffmpegVersion: '7.0.2-mock'
    }),
    checkNvenc: async () => 'modern' as const,
    startRender: async (): Promise<StartResult> => {
      let pct = 0
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        pct += 6
        if (pct >= 100) {
          if (timer) clearInterval(timer)
          timer = null
          listeners.progress?.({
            percent: 100,
            outTimeSec: DEMO.durationSec,
            fps: 68,
            speed: 1.9,
            frame: 11010,
            totalFrames: 11010
          })
          listeners.done?.({
            outputPath: 'C:\\Videos\\精彩集锦_60fps.mp4',
            sizeBytes: 512340000,
            fps: 60,
            durationSec: DEMO.durationSec
          })
        } else {
          listeners.progress?.({
            percent: pct,
            outTimeSec: (DEMO.durationSec * pct) / 100,
            fps: 58 + Math.round(pct / 8),
            speed: 1.6 + Math.random() * 0.6,
            frame: Math.round((11010 * pct) / 100),
            totalFrames: 11010
          })
        }
      }, 300)
      return {
        ok: true,
        command:
          'ffmpeg -y -hide_banner -nostdin -loglevel error -progress pipe:1 -i "C:\\Videos\\精彩集锦.mp4" -map 0:v:0 -map 0:a:0? -vf "fps=30000/1001,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=183.500,format=yuv420p" -c:v libx264 -preset slow -crf 16 -c:a copy -movflags +faststart -f mov "C:\\Videos\\精彩集锦_60fps.mp4.part"',
        encoderLabel: 'NVIDIA NVENC · H.264'
      }
    },
    cancelRender: async () => {
      if (timer) clearInterval(timer)
      timer = null
      listeners.cancelled?.({})
      return { ok: true }
    },
    onProgress: (cb: (d: unknown) => void) => {
      listeners.progress = cb
      return () => {
        listeners.progress = null
      }
    },
    onRetry: (cb: (d: unknown) => void) => {
      listeners.retry = cb
      return () => {
        listeners.retry = null
      }
    },
    onNotice: (cb: (d: unknown) => void) => {
      listeners.notice = cb
      return () => {
        listeners.notice = null
      }
    },
    onDone: (cb: (d: unknown) => void) => {
      listeners.done = cb
      return () => {
        listeners.done = null
      }
    },
    onError: (cb: (d: unknown) => void) => {
      listeners.error = cb
      return () => {
        listeners.error = null
      }
    },
    onCancelled: (cb: (d: unknown) => void) => {
      listeners.cancelled = cb
      return () => {
        listeners.cancelled = null
      }
    }
  }
  ;(window as unknown as { api: unknown }).api = api
}
