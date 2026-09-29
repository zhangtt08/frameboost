// 纯函数模块：补帧命令构建、回退策略与输出命名。不依赖 Electron，可被测试脚本直接 require。

export type Mode = 'high' | 'balanced' | 'fast'
export type NvencLevel = 'none' | 'legacy' | 'modern'
export type Quality = 'master' | 'high' | 'standard'

export interface ProbeResult {
  path: string
  fileName: string
  sizeBytes: number
  durationSec: number
  width: number
  height: number
  /** 基准帧率（r_frame_rate，异常时为 0） */
  fps: number
  /** 平均帧率（avg_frame_rate，异常时为 0） */
  avgFps: number
  fpsRational: string
  pixFmt: string
  videoCodec: string
  /** 该流在所有视频流中的序号（用于 -map 0:v:N），已排除封面图 */
  videoStreamIndex: number
  colorPrimaries: string
  colorTrc: string
  colorSpace: string
  hasAudio: boolean
  audioCodec: string
}

export interface RenderParams {
  inputPath: string
  outputPath: string
  targetFps: number
  mode: Mode
  quality: Quality
  useNvenc: boolean
  container: 'mp4' | 'mkv'
}

export interface Attempt {
  nvenc: NvencLevel
  audio: 'copy' | 'aac'
}

export const MAX_FPS = 480

export function sanitizeRational(v: unknown, fallbackNum: number): string {
  const s = String(v ?? '')
  const m = /^(\d+)\/(\d+)$/.exec(s)
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    const val = Number(m[1]) / Number(m[2])
    // 过大的 r_frame_rate（如 mkv 里按 timebase 误报的 90000/1）视为无效
    if (val <= MAX_FPS) return `${m[1]}/${m[2]}`
  }
  return fallbackNum > 0 && fallbackNum <= MAX_FPS ? String(Math.round(fallbackNum)) : ''
}

/** 依据 10bit 编码能力决定输出像素格式；10bit 源在不支持时降级为 8bit */
export function pixFmtFor(src: string, tenBitCapable: boolean): { fmt: string; downgraded: boolean } {
  const is10 = /10le|10be/.test(src)
  if (is10 && tenBitCapable) return { fmt: 'yuv420p10le', downgraded: false }
  if (is10) return { fmt: 'yuv420p', downgraded: true }
  return { fmt: 'yuv420p', downgraded: false }
}

/**
 * 补帧滤镜链。
 * 关键画质点：minterpolate/framerate 处理最后一段时缺少"下一帧"会丢尾部，
 * 先 tpad 克隆补 1s 再插帧，最后 trim 回原时长，保证输出帧数完整、音画对齐。
 */
export function buildFilter(p: RenderParams, info: ProbeResult, tenBitCapable: boolean): string {
  const { fmt } = pixFmtFor(info.pixFmt, tenBitCapable)
  const hasDur = info.durationSec > 0
  const pad = hasDur ? 'tpad=stop_mode=clone:stop_duration=1,' : ''
  const trim = hasDur ? `trim=duration=${info.durationSec.toFixed(3)},` : ''
  if (p.mode === 'fast') {
    return `${pad}framerate=fps=${p.targetFps},${trim}format=${fmt}`
  }
  const mc =
    p.mode === 'high'
      ? 'mc_mode=aobmc:me_mode=bidir:vsbmc=1'
      : 'mc_mode=obmc:me_mode=bidir:vsbmc=0'
  const src = sanitizeRational(info.fpsRational, info.fps > 0 ? info.fps : info.avgFps)
  const normalize = src ? `fps=${src},` : ''
  return `${normalize}${pad}minterpolate=fps=${p.targetFps}:mi_mode=mci:${mc},${trim}format=${fmt}`
}

export function encoderArgs(level: NvencLevel, quality: Quality): string[] {
  const cq = quality === 'master' ? '17' : quality === 'high' ? '19' : '23'
  if (level === 'modern') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', cq, '-b:v', '0']
  }
  if (level === 'legacy') {
    return ['-c:v', 'h264_nvenc', '-preset', 'llhq', '-rc', 'vbr', '-cq', cq, '-b:v', '0']
  }
  if (quality === 'master') return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '10']
  if (quality === 'high') return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']
}

export function encoderLabel(level: NvencLevel): string {
  return level === 'none' ? 'CPU · libx264' : 'NVIDIA NVENC · H.264'
}

/**
 * 尝试序列规划：
 * - NVENC 仅在启用、检测可用且输出为 8bit 时尝试（h264_nvenc 不支持 10bit）
 * - 音轨先无损直写，失败（编解码器与容器不兼容）自动回退 AAC 重编码
 */
export function planAttempts(p: RenderParams, nvencLevel: NvencLevel, eightBit: boolean): Attempt[] {
  const attempts: Attempt[] = []
  if (p.useNvenc && nvencLevel !== 'none' && eightBit) {
    attempts.push({ nvenc: nvencLevel, audio: 'copy' })
  }
  attempts.push({ nvenc: 'none', audio: 'copy' })
  attempts.push({ nvenc: 'none', audio: 'aac' })
  return attempts
}

/** 输出文件重名时自动追加 " (1)" 后缀，避免覆盖已有文件 */
export function resolveOutputPath(desired: string, exists: (p: string) => boolean): string {
  if (!exists(desired)) return desired
  const m = /^(.*)(\.[^./\\]+)$/.exec(desired)
  const base = m ? m[1] : desired
  const ext = m ? m[2] : ''
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`
    if (!exists(cand)) return cand
  }
  return `${base} (new)${ext}`
}

export function buildArgs(p: RenderParams, info: ProbeResult, attempt: Attempt, tenBitCapable: boolean): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-i',
    p.inputPath,
    '-map',
    `0:v:${info.videoStreamIndex}`,
    '-map',
    '0:a:0?',
    '-vf',
    buildFilter(p, info, tenBitCapable),
    ...encoderArgs(attempt.nvenc, p.quality),
    '-c:a',
    attempt.audio
  ]
  if (attempt.audio === 'aac') args.push('-b:a', '192k')
  if (info.colorPrimaries && info.colorPrimaries !== 'unknown') args.push('-color_primaries', info.colorPrimaries)
  if (info.colorTrc && info.colorTrc !== 'unknown') args.push('-color_trc', info.colorTrc)
  if (info.colorSpace && info.colorSpace !== 'unknown') args.push('-colorspace', info.colorSpace)
  if (p.container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', p.container === 'mp4' ? 'mov' : 'matroska', `${p.outputPath}.part`)
  return args
}
