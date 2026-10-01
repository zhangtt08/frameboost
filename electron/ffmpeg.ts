// 共享 ffmpeg / ffprobe 引擎：二进制解析、子进程执行、视频探测与硬件能力检测。
// 纯 Node 逻辑，不依赖 Electron —— electron/main.ts 与 agent/tools.mjs 复用同一份实现，
// 避免桌面应用与 Agent API 对同一能力各写两遍导致漂移。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type { NvencLevel, ProbeResult } from './pipeline'

// 打包进 asar 时，二进制被解包到 app.asar.unpacked，路径需相应改写。
function asUnpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

// require 在 CJS 编译产物（main.js / ffmpeg.js）里是原生的；从 ESM 动态 import 时
// Node 仍按 CJS 包装，require 可用。createRequire 仅作为极端 ESM 场景的兜底。
function req(id: string): { path?: string } {
  try {
    return require(id) as { path?: string }
  } catch {
    try {
      return createRequire(path.join(process.cwd(), 'noop.cjs'))(id) as { path?: string }
    } catch {
      return {}
    }
  }
}

function resolveBin(pkgName: string, envVar: string, fallback: string): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    const mod = req(pkgName)
    const p = asUnpacked(String(mod?.path ?? ''))
    if (p && fs.existsSync(p)) return p
  } catch {
    // 包不可用时回退到系统 PATH
  }
  return fallback
}

export const ffmpegPath = resolveBin('@ffmpeg-installer/ffmpeg', 'FFMPEG_PATH', 'ffmpeg')
export const ffprobePath = resolveBin('@ffprobe-installer/ffprobe', 'FFPROBE_PATH', 'ffprobe')

/** 截断长文本尾部，用于日志与错误信息展示 */
export function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

/** 运行一个二进制并收集 stdout/stderr，可选超时后强杀 */
export function runBin(
  bin: string,
  args: string[],
  timeoutMs = 0
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill()
            } catch {
              /* ignore */
            }
            reject(new Error(`执行超时: ${bin}`))
          }, timeoutMs)
        : null
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function rationalFps(v: string): number {
  const [numStr, denStr] = String(v ?? '').split('/')
  const den = Number(denStr)
  if (!den || den <= 0) return 0
  const val = Number(numStr) / den
  return val > 0 && val <= 480 ? val : 0
}

/** 用 ffprobe 解析视频流与容器信息（选最大分辨率的非封面视频流） */
export async function probeVideo(inputPath: string): Promise<ProbeResult> {
  if (!inputPath) throw new Error('未指定文件')
  if (!fs.existsSync(inputPath)) throw new Error(`文件不存在：${inputPath}`)
  const { code, stdout, stderr } = await runBin(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath
  ])
  if (code !== 0) throw new Error(`ffprobe 解析失败：${tail(stderr.trim(), 400)}`)
  const data = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  const allStreams = data.streams ?? []
  const vids = allStreams.filter(
    (s) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown> | undefined)?.attached_pic
  )
  if (vids.length === 0) throw new Error('未找到视频流，请选择视频文件')
  const best = vids.reduce((a, b) =>
    Number(b.width ?? 0) * Number(b.height ?? 0) > Number(a.width ?? 0) * Number(a.height ?? 0) ? b : a
  )
  const audio = allStreams.find((s) => s.codec_type === 'audio')
  const format = data.format ?? {}
  return {
    path: inputPath,
    fileName: path.basename(inputPath),
    sizeBytes: Number(format.size ?? 0),
    durationSec: Number(format.duration ?? best.duration ?? 0),
    width: Number(best.width ?? 0),
    height: Number(best.height ?? 0),
    // r_frame_rate 可能按 timebase 误报（如 90000/1），异常时回退 avg_frame_rate
    fps: rationalFps(String(best.r_frame_rate ?? '')),
    avgFps: rationalFps(String(best.avg_frame_rate ?? '')),
    fpsRational: String(best.r_frame_rate ?? ''),
    pixFmt: String(best.pix_fmt ?? ''),
    videoCodec: String(best.codec_name ?? ''),
    videoStreamIndex: vids.indexOf(best),
    colorPrimaries: String(best.color_primaries ?? ''),
    colorTrc: String(best.color_trc ?? ''),
    colorSpace: String(best.colorspace ?? ''),
    hasAudio: !!audio,
    audioCodec: audio ? String(audio.codec_name ?? '') : ''
  }
}

let nvencCache: NvencLevel | null = null

/** 检测 NVIDIA NVENC 能力：modern(p5) / legacy(llhq) / none，带进程内缓存 */
export async function detectNvenc(): Promise<NvencLevel> {
  if (nvencCache) return nvencCache
  const base = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.5', '-frames:v', '15']
  try {
    const modern = await runBin(ffmpegPath, [...base, '-c:v', 'h264_nvenc', '-preset', 'p5', '-f', 'null', '-'], 20000)
    if (modern.code === 0) {
      nvencCache = 'modern'
      return nvencCache
    }
  } catch {
    /* 继续尝试旧版 */
  }
  try {
    const legacy = await runBin(ffmpegPath, [...base, '-c:v', 'h264_nvenc', '-preset', 'llhq', '-f', 'null', '-'], 20000)
    if (legacy.code === 0) {
      nvencCache = 'legacy'
      return nvencCache
    }
  } catch {
    /* 无硬件加速 */
  }
  nvencCache = 'none'
  return nvencCache
}

let tenBitCache: boolean | null = null

/** 检测内置 libx264 是否支持 10bit 输出（影响 pix_fmt 与是否走 NVENC） */
export async function detectTenBit(): Promise<boolean> {
  if (tenBitCache !== null) return tenBitCache
  try {
    const r = await runBin(
      ffmpegPath,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2', '-frames:v', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-f', 'null', '-'],
      15000
    )
    tenBitCache = r.code === 0
  } catch {
    tenBitCache = false
  }
  return tenBitCache
}
