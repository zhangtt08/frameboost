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
import { createAgentApiServer, DEFAULT_API_PORT, type RenderStateSnapshot } from './agent-api'
import {
  ffmpegPath,
  ffprobePath,
  runBin,
  tail,
  probeVideo,
  detectNvenc,
  detectTenBit
} from './ffmpeg'

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

// Agent API 用的最近一次渲染结果快照（render:done / render:error 时更新）
const lastRenderState: RenderStateSnapshot = { done: false, ok: false, result: null, error: null }

// ---------- 窗口事件广播 ----------

function sendToWindow(channel: string, payload: unknown): void {
  if (channel === 'render:done') {
    lastRenderState.done = true
    lastRenderState.ok = true
    lastRenderState.result = payload as Record<string, unknown>
    lastRenderState.error = null
  } else if (channel === 'render:error') {
    lastRenderState.done = true
    lastRenderState.ok = false
    lastRenderState.result = null
    lastRenderState.error = String((payload as { message?: unknown })?.message ?? '')
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
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

async function startRender(raw: unknown): Promise<{ ok: boolean; command?: string; encoderLabel?: string; error?: string }> {
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
    lastRenderState.done = false
    lastRenderState.ok = false
    lastRenderState.result = null
    lastRenderState.error = null
    spawnAttempt(p, info, attempts, 0, tenBitCapable)
    return { ok: true, command: lastCommand, encoderLabel: encoderLabel(attempts[0].nvenc) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function registerIpc(): void {
  ipcMain.handle('video:probe', async (_e, rawPath: unknown) => {
    try {
      return { ok: true, info: await probeVideo(String(rawPath ?? '')) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('render:start', async (_e, raw: unknown) => {
    return startRender(raw)
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

  // 自绘标题栏：窗口三键
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
      return false
    }
    mainWindow.maximize()
    return true
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized())
}

// ---------- 窗口与生命周期 ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    frame: false,
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
  // 自绘标题栏：向渲染层广播最大化状态变化
  const sendMaximized = (maximized: boolean) => mainWindow?.webContents.send('window:maximized', maximized)
  mainWindow.on('maximize', () => sendMaximized(true))
  mainWindow.on('unmaximize', () => sendMaximized(false))
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
    // Agent API：复用应用内 probe/render 流程；端口被占用时静默跳过。
    try {
      const apiServer = createAgentApiServer({
        version: app.getVersion(),
        startRender,
        getJobSummary: () => ({
          running: job !== null,
          outputPath: job?.params.outputPath,
          inputPath: job?.params.inputPath,
          targetFps: job?.params.targetFps,
          frame: job?.frame,
          fps: job?.fps,
          speed: job?.speed
        }),
        probeVideo,
        detectNvenc,
        lastRenderState
      })
      apiServer.on('error', () => {})
      apiServer.listen(Number(process.env.FRAMEBOOST_API_PORT) || DEFAULT_API_PORT, '127.0.0.1', () => {
        console.log('[frameboost-agent-api] listening on http://127.0.0.1:' + (Number(process.env.FRAMEBOOST_API_PORT) || DEFAULT_API_PORT))
      })
    } catch {
      /* ignore */
    }
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
