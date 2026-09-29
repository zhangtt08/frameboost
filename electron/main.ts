import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildArgs,
  encoderLabel,
  planAttempts,
  pixFmtFor,
  resolveOutputPath,
  sanitizeRational,
  MAX_FPS,
  type Attempt,
  type NvencLevel,
  type ProbeResult,
  type RenderParams
} from './pipeline'

interface Job {
  proc: ReturnType<typeof spawn>
  params: RenderParams
  attempts: Attempt[]
  attemptIndex: number
  cancelled: boolean
  durationSec: number
  totalFrames: number
  outTimeSec: number
  frame: number
  fps: number
  speed: number | null
  stderrTail: string
  stdoutRest: string
  lastSendAt: number
}

let mainWindow: BrowserWindow | null = null
let job: Job | null = null
let lastCommand = ''
let quitting = false

// ---------- ffmpeg / ffprobe 二进制解析 ----------

function asUnpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

function resolveBin(pkgName: string, envVar: string, fallback: string): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    const mod = require(pkgName) as { path?: string }
    const p = asUnpacked(String(mod?.path ?? ''))
    if (p && fs.existsSync(p)) return p
  } catch {
    // 包不可用时回退到系统 PATH
  }
  return fallback
}

const ffmpegPath = resolveBin('@ffmpeg-installer/ffmpeg', 'FFMPEG_PATH', 'ffmpeg')
const ffprobePath = resolveBin('@ffprobe-installer/ffprobe', 'FFPROBE_PATH', 'ffprobe')

// ---------- 通用工具 ----------

function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function runBin(
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
  return val > 0 && val <= MAX_FPS ? val : 0
}

// ---------- 视频探测 ----------

async function probeVideo(inputPath: string): Promise<ProbeResult> {
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

// ---------- 硬件能力检测（带缓存） ----------

let nvencCache: NvencLevel | null = null

async function detectNvenc(): Promise<NvencLevel> {
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

async function detectTenBit(): Promise<boolean> {
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

// ---------- 任务执行 ----------

function parseSpeed(v: string): number | null {
  const m = /([\d.]+)/.exec(v)
  return m ? Number(m[1]) : null
}

function sendProgress(forcePercent?: number): void {
  const j = job
  if (!j) return
  const percent =
    forcePercent ?? Math.min(99.5, j.durationSec > 0 ? (j.outTimeSec / j.durationSec) * 100 : 0)
  sendToWindow('render:progress', {
    percent,
    outTimeSec: j.outTimeSec,
    fps: j.fps,
    speed: j.speed,
    frame: j.frame,
    totalFrames: j.totalFrames
  })
}

function handleProgressLine(line: string): void {
  const j = job
  if (!j) return
  const eq = line.indexOf('=')
  if (eq <= 0) return
  const key = line.slice(0, eq).trim()
  const val = line.slice(eq + 1).trim()
  if (key === 'out_time_us' || key === 'out_time_ms') {
    // ffmpeg 的 out_time_ms 实际也是微秒
    const us = Number(val)
    if (Number.isFinite(us) && us >= 0) j.outTimeSec = us / 1e6
  } else if (key === 'frame') {
    const f = Number(val)
    if (Number.isFinite(f)) j.frame = f
  } else if (key === 'fps') {
    const f = Number(val)
    if (Number.isFinite(f) && f > 0) j.fps = f
  } else if (key === 'speed') {
    j.speed = parseSpeed(val)
  } else if (key === 'progress' && val === 'end') {
    j.outTimeSec = j.durationSec
    sendProgress(100)
    return
  }
  const now = Date.now()
  if (now - j.lastSendAt >= 250) {
    j.lastSendAt = now
    sendProgress()
  }
}

async function cleanupPart(out: string): Promise<void> {
  try {
    await fs.promises.rm(`${out}.part`, { force: true })
  } catch {
    /* ignore */
  }
}

function spawnAttempt(p: RenderParams, info: ProbeResult, attempts: Attempt[], index: number, tenBitCapable: boolean): void {
  const attempt = attempts[index]
  const args = buildArgs(p, info, attempt, tenBitCapable)
  lastCommand =
    'ffmpeg ' +
    args
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ')
  console.log('[frameboost]', lastCommand)
  const proc = spawn(ffmpegPath, args, { windowsHide: true })
  job = {
    proc,
    params: p,
    attempts,
    attemptIndex: index,
    cancelled: false,
    durationSec: info.durationSec,
    totalFrames: Math.max(1, Math.round(info.durationSec * p.targetFps)),
    outTimeSec: 0,
    frame: 0,
    fps: 0,
    speed: null,
    stderrTail: '',
    stdoutRest: '',
    lastSendAt: 0
  }

  proc.stdout?.on('data', (d: Buffer) => {
    const j = job
    if (!j) return
    j.stdoutRest += d.toString()
    let nl: number
    while ((nl = j.stdoutRest.indexOf('\n')) >= 0) {
      const line = j.stdoutRest.slice(0, nl).trim()
      j.stdoutRest = j.stdoutRest.slice(nl + 1)
      if (line) handleProgressLine(line)
    }
  })

  proc.stderr?.on('data', (d: Buffer) => {
    const j = job
    if (j) j.stderrTail = (j.stderrTail + d.toString()).slice(-8000)
  })

  proc.on('error', (err) => {
    sendToWindow('render:error', { message: `无法启动 ffmpeg：${err.message}`, log: '' })
    job = null
  })

  proc.on('close', (code) => {
    const j = job
    if (!j || j.proc !== proc) return
    if (j.cancelled) {
      void cleanupPart(p.outputPath)
      sendToWindow('render:cancelled', {})
      job = null
      return
    }
    if (code === 0) {
      fs.rename(`${p.outputPath}.part`, p.outputPath, (err) => {
        if (err) {
          sendToWindow('render:error', { message: `输出文件保存失败：${err.message}`, log: '' })
          job = null
          return
        }
        // 回探输出信息，供完成面板展示
        probeVideo(p.outputPath)
          .then((outInfo) => {
            sendToWindow('render:done', {
              outputPath: p.outputPath,
              sizeBytes: outInfo.sizeBytes,
              fps: outInfo.fps > 0 ? outInfo.fps : outInfo.avgFps,
              durationSec: outInfo.durationSec
            })
          })
          .catch(() => {
            sendToWindow('render:done', { outputPath: p.outputPath })
          })
          .finally(() => {
            job = null
          })
      })
      return
    }
    if (index + 1 < attempts.length) {
      const next = attempts[index + 1]
      const reason =
        attempt.nvenc !== 'none' && next.nvenc === 'none'
          ? '硬件加速不可用，已自动回退到 CPU 编码'
          : '音频无损直写失败，已改为重编码 AAC 后重试'
      sendToWindow('render:retry', { reason, encoderLabel: encoderLabel(next.nvenc) })
      spawnAttempt(p, info, attempts, index + 1, tenBitCapable)
      return
    }
    void cleanupPart(p.outputPath)
    sendToWindow('render:error', { message: 'ffmpeg 处理失败，请查看日志', log: tail(j.stderrTail.trim(), 1600) })
    job = null
  })
}

function sanitizeParams(raw: unknown): RenderParams {
  const r = (raw ?? {}) as Record<string, unknown>
  const inputPath = String(r.inputPath ?? '')
  const outputPath = String(r.outputPath ?? '')
  const targetFps = Math.round(Number(r.targetFps))
  const mode = r.mode === 'high' || r.mode === 'fast' ? r.mode : 'balanced'
  const quality = r.quality === 'master' || r.quality === 'high' ? r.quality : 'standard'
  const container = r.container === 'mkv' ? 'mkv' : 'mp4'
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('输入文件不存在')
  if (!outputPath) throw new Error('未指定输出路径')
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error('输出路径不能与输入文件相同')
  if (!Number.isFinite(targetFps) || targetFps < 5 || targetFps > MAX_FPS) {
    throw new Error(`目标帧率无效（应在 5-${MAX_FPS} 之间）`)
  }
  if (!/\.(mp4|mkv)$/i.test(outputPath)) throw new Error('输出文件必须是 .mp4 或 .mkv')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  return { inputPath, outputPath, targetFps, mode, quality, container, useNvenc: !!r.useNvenc }
}

// ---------- IPC ----------

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', '3gp', 'vob', 'ogv', 'm2ts']

function registerIpc(): void {
  ipcMain.handle('video:probe', async (_e, rawPath: unknown) => {
    try {
      return { ok: true, info: await probeVideo(String(rawPath ?? '')) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('render:start', async (_e, raw: unknown) => {
    try {
      if (job) return { ok: false, error: '已有任务正在运行，请先等待完成或取消' }
      const p0 = sanitizeParams(raw)
      const info = await probeVideo(p0.inputPath)
      const srcFps = info.fps > 0 ? info.fps : info.avgFps
      if (!(srcFps > 0)) return { ok: false, error: '无法读取原视频帧率' }
      if (p0.targetFps <= srcFps + 0.01) {
        return { ok: false, error: `目标帧率需高于原帧率（原 ${Math.round(srcFps * 100) / 100} fps）` }
      }
      const tenBitCapable = await detectTenBit()
      const eff = pixFmtFor(info.pixFmt, tenBitCapable)
      let nvencLevel: NvencLevel = 'none'
      if (p0.useNvenc && !eff.downgraded) nvencLevel = await detectNvenc()
      const attempts = planAttempts(p0, nvencLevel, !eff.downgraded)
      // 重名输出自动加后缀，避免覆盖
      const outputPath = resolveOutputPath(p0.outputPath, (x) => fs.existsSync(x))
      const p: RenderParams = { ...p0, outputPath }
      if (eff.downgraded) {
        sendToWindow('render:notice', {
          message: '源视频为 10bit，内置编码器不支持 10bit H.264，将以 8bit 输出'
        })
      }
      spawnAttempt(p, info, attempts, 0, tenBitCapable)
      return { ok: true, command: lastCommand, encoderLabel: encoderLabel(attempts[0].nvenc) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('render:cancel', () => {
    const j = job
    if (!j) return { ok: false }
    j.cancelled = true
    try {
      j.proc.kill()
    } catch {
      /* ignore */
    }
    return { ok: true }
  })

  ipcMain.handle('dialog:open-video', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: VIDEO_EXTS }]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:save-output', async (_e, defaultPath: unknown) => {
    const r = await dialog.showSaveDialog({
      defaultPath: String(defaultPath ?? 'output.mp4'),
      filters: [{ name: '视频文件', extensions: ['mp4', 'mkv'] }]
    })
    return r.canceled ? null : (r.filePath ?? null)
  })

  ipcMain.handle('shell:show-in-folder', (_e, p: unknown) => {
    const s = String(p ?? '')
    if (s && fs.existsSync(s)) shell.showItemInFolder(s)
  })

  ipcMain.handle('app:meta', async () => {
    let version = ''
    try {
      const r = await runBin(ffmpegPath, ['-version'], 8000)
      version = (r.stdout.split('\n')[0] ?? '').replace(/^ffmpeg version /i, '').trim().split(' ')[0] ?? ''
    } catch {
      /* ignore */
    }
    return { ffmpegPath, ffprobePath, ffmpegVersion: version }
  })

  ipcMain.handle('nvenc:check', () => detectNvenc())
}

// ---------- 窗口与生命周期 ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d13',
    autoHideMenuBar: true,
    title: 'FrameBoost · 视频补帧',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // preload 需要完整的 electron API（webUtils 解析拖拽文件路径）
      sandbox: false,
      spellcheck: false
    }
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 任务进行中关闭窗口需确认，防止误触丢任务
  mainWindow.on('close', (e) => {
    if (quitting || !job || !mainWindow) return
    e.preventDefault()
    void dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: '正在补帧',
        message: '补帧任务正在进行中，退出将取消当前任务。',
        buttons: ['继续等待（取消退出）', '退出并停止任务'],
        defaultId: 0,
        cancelId: 0
      })
      .then((r) => {
        if (r.response === 1) {
          quitting = true
          try {
            job?.proc.kill()
          } catch {
            /* ignore */
          }
          mainWindow?.close()
        }
      })
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const ev = args[0] as Record<string, unknown> | undefined
    const msg = ev && typeof ev === 'object' && 'message' in ev ? String(ev.message) : String(args[2] ?? '')
    const level = ev && typeof ev === 'object' && 'level' in ev ? ev.level : args[1]
    if (level === 3 || level === 'error') console.log('[renderer-error]', msg)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerIpc()
    createWindow()
    console.log('[frameboost] main ready, ffmpeg =', ffmpegPath)
  })
}

app.on('before-quit', () => {
  quitting = true
  const j = job
  if (j) {
    j.cancelled = true
    try {
      j.proc.kill()
    } catch {
      /* ignore */
    }
    void cleanupPart(j.params.outputPath)
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
