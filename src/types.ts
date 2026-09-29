// 渲染端与主进程共享的类型：核心类型直接复用 electron/pipeline.ts（纯函数模块）
import type { ProbeResult } from '../electron/pipeline'

export type { Mode, NvencLevel, Quality, ProbeResult, RenderParams } from '../electron/pipeline'

export interface ProbeResponse {
  ok: boolean
  info?: ProbeResult
  error?: string
}

export interface StartResult {
  ok: boolean
  error?: string
  command?: string
  encoderLabel?: string
}

export interface ProgressData {
  percent: number
  outTimeSec: number
  fps: number
  speed: number | null
  frame: number
  totalFrames: number
}

export interface DonePayload {
  outputPath: string
  sizeBytes?: number
  fps?: number
  durationSec?: number
}

export interface MetaInfo {
  ffmpegPath: string
  ffprobePath: string
  ffmpegVersion: string
}
