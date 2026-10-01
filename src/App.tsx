import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { DonePayload, MetaInfo, Mode, NvencLevel, ProgressData, Quality } from './types'
import type { ProbeResult } from './types'

type Stage = 'empty' | 'ready' | 'rendering' | 'done'
type ItemStatus = 'pending' | 'rendering' | 'done' | 'error' | 'cancelled'

interface QueueItem {
  id: number
  path: string
  fileName: string
  info: ProbeResult
  previewUrl: string
  status: ItemStatus
  progress?: ProgressData
  error?: string
  log?: string
  note?: string
  result?: DonePayload
}

interface Prefs {
  mode: Mode
  quality: Quality
  mult: number // 0 = 自定义
  customFps: string
  container: 'mp4' | 'mkv'
  useNvenc: boolean
}

const PREF_KEY = 'frameboost.prefs.v2'
const DEFAULT_PREFS: Prefs = {
  mode: 'balanced',
  quality: 'high',
  mult: 2,
  customFps: '60',
  container: 'mp4',
  useNvenc: true
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFS
}

const VIDEO_ACCEPT = '.mp4,.mkv,.mov,.avi,.webm,.flv,.ts,.m4v,.mpg,.mpeg,.wmv,.3gp,.vob,.ogv,.m2ts'

const MODES: { id: Mode; title: string; desc: string; speed: number; quality: number; tag: string }[] = [
  {
    id: 'high',
    title: '光流补偿 · 精细',
    desc: 'AOBMC 自适应分块 + 双向运动估计 + 变分加权，运动最顺滑',
    speed: 1,
    quality: 3,
    tag: '最慢 · 画质最佳'
  },
  {
    id: 'balanced',
    title: '光流补偿 · 均衡',
    desc: 'OBMC 运动补偿插帧，速度与画质平衡，适合大多数视频',
    speed: 2,
    quality: 2,
    tag: '推荐'
  },
  {
    id: 'fast',
    title: '帧混合',
    desc: '相邻帧加权融合，接近实时处理；快速运动场景略有拖影',
    speed: 3,
    quality: 1,
    tag: '最快'
  }
]

const QUALITIES: { id: Quality; title: string; desc: string }[] = [
  { id: 'master', title: '母版级', desc: 'CRF 10 · 视觉无损，用于再剪辑/存档' },
  { id: 'high', title: '高画质', desc: 'CRF 16 · 画质与体积的推荐平衡' },
  { id: 'standard', title: '标准', desc: 'CRF 20 · 体积小、速度快' }
]

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const two = String(ss).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${two}` : `${m}:${two}`
}

function fmtSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

function fmtFps(f: number): string {
  return Number.isFinite(f) && f > 0 ? String(Math.round(f * 100) / 100) : '—'
}

function fileUrl(p: string): string {
  return encodeURI('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
}

function defaultOutput(src: string, fps: number, container: string): string {
  const idx = Math.max(src.lastIndexOf('\\'), src.lastIndexOf('/'))
  const dir = src.slice(0, idx)
  const base = src.slice(idx + 1).replace(/\.[^.]+$/, '')
  const sep = src.includes('\\') ? '\\' : '/'
  return `${dir}${sep}${base}_${fps}fps.${container}`
}

function Dots({ n }: { n: number }) {
  return (
    <span className="dots" aria-hidden>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  )
}

const ST_ICON: Record<ItemStatus, string> = {
  pending: '○',
  rendering: '◐',
  done: '✓',
  error: '✕',
  cancelled: '—'
}
const ST_TEXT: Record<ItemStatus, string> = {
  pending: '等待中',
  rendering: '处理中',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
}

export default function App() {
  const hasApi = typeof window !== 'undefined' && !!window.api
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const { mode, quality, mult, customFps, container, useNvenc } = prefs
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }))
  }, [])

  const [items, setItems] = useState<QueueItem[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [currentItemId, setCurrentItemId] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage>('empty')
  const [outputPath, setOutputPath] = useState('')
  const [outputLocked, setOutputLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState('')
  const [meta, setMeta] = useState<MetaInfo | null>(null)
  const [nvenc, setNvenc] = useState<NvencLevel | null>(null)
  const [command, setCommand] = useState('')
  const [encoderLabel, setEncoderLabel] = useState('')

  const runningRef = useRef(false)
  const currentIdRef = useRef<number | null>(null)
  const terminalResolvers = useRef(new Map<number, (v: 'done' | 'error' | 'cancelled') => void>())
  const nextIdRef = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveRef = useRef({ mode, quality, mult, customFps, container, useNvenc, outputLocked, outputPath })
  liveRef.current = { mode, quality, mult, customFps, container, useNvenc, outputLocked, outputPath }

  const sel = items.find((i) => i.id === selectedId) ?? items[0] ?? null
  const currentItem = items.find((i) => i.id === currentItemId) ?? null
  const selFps = sel ? (sel.info.fps > 0 ? sel.info.fps : sel.info.avgFps) : 0
  const targetFps = mult > 0 ? Math.round(selFps * mult) : Math.round(Number(customFps) || 0)
  const fpsValid = targetFps >= 5 && targetFps <= 480 && selFps > 0 && targetFps > selFps
  const pendingCount = items.filter((i) => i.status === 'pending').length
  const doneCount = items.filter((i) => i.status === 'done').length
  const failedCount = items.filter((i) => i.status === 'error' || i.status === 'cancelled').length
  const running = stage === 'rendering'
  const is4K = !!sel && sel.info.width * sel.info.height >= 3_500_000

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4200)
  }, [])

  const patchItem = useCallback((id: number, patch: Partial<QueueItem>) => {
    const next = itemsRef.current.map((i) => (i.id === id ? { ...i, ...patch } : i))
    itemsRef.current = next
    setItems(next)
  }, [])

  const addByPath = useCallback(
    async (p: string, preview?: string) => {
      try {
        const r = await window.api.probe(p)
        if (!r.ok || !r.info) throw new Error(r.error || '视频解析失败')
        const item: QueueItem = {
          id: nextIdRef.current++,
          path: p,
          fileName: r.info.fileName,
          info: r.info,
          previewUrl: preview ?? fileUrl(p),
          status: 'pending'
        }
        itemsRef.current = [...itemsRef.current, item]
        setItems(itemsRef.current)
        setSelectedId(item.id)
        setStage((s) => (s === 'rendering' ? 'rendering' : 'ready'))
        if (itemsRef.current.length > 1) {
          setOutputLocked(false)
          setOutputPath('')
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      }
    },
    [showToast]
  )

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const arr = files ? Array.from(files) : []
      if (!arr.length) return
      setBusy(true)
      for (const f of arr) {
        const p = window.api.pathForFile(f)
        if (!p) {
          showToast(`无法获取「${f.name}」的文件路径，请改用「添加视频」按钮选择`)
          continue
        }
        await addByPath(p, URL.createObjectURL(f))
      }
      setBusy(false)
    },
    [addByPath, showToast]
  )

  const addViaDialog = useCallback(async () => {
    const paths = await window.api.pickVideo()
    for (const p of paths ?? []) await addByPath(p)
  }, [addByPath])

  // 偏好持久化
  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  // 窗口级拖拽
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types?.includes('Files')) setDragOver(true)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      if (!e.relatedTarget) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      void addFiles(e.dataTransfer?.files ?? null)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  // 事件订阅 + 元信息（仅挂载一次）
  useEffect(() => {
    if (!hasApi) return
    const offs = [
      window.api.onProgress((d) => {
        const id = currentIdRef.current
        if (id != null) patchItem(id, { progress: d })
      }),
      window.api.onRetry((d) => {
        const id = currentIdRef.current
        if (id != null) patchItem(id, { note: d.reason })
        if (d.encoderLabel) setEncoderLabel(d.encoderLabel)
      }),
      window.api.onNotice((d) => {
        const id = currentIdRef.current
        if (id != null) patchItem(id, { note: d.message })
      }),
      window.api.onDone((d) => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, { status: 'done', progress: undefined, result: d })
        terminalResolvers.current.get(id)?.('done')
      }),
      window.api.onError((d) => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, { status: 'error', progress: undefined, error: d.message, log: d.log ?? '' })
        terminalResolvers.current.get(id)?.('error')
      }),
      window.api.onCancelled(() => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, { status: 'cancelled', progress: undefined })
        terminalResolvers.current.get(id)?.('cancelled')
      })
    ]
    void window.api.getMeta().then(setMeta).catch(() => undefined)
    void window.api
      .checkNvenc()
      .then(setNvenc)
      .catch(() => setNvenc('none'))
    return () => offs.forEach((o) => o())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runQueue = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setStage('rendering')
    try {
      for (;;) {
        const next = itemsRef.current.find((i) => i.status === 'pending')
        if (!next) break
        const src = next.info.fps > 0 ? next.info.fps : next.info.avgFps
        const live = liveRef.current
        const tf =
          live.mult > 0 ? Math.round(src * live.mult) : Math.round(Number(live.customFps) || 0)
        if (!(tf >= 5 && tf <= 480 && src > 0 && tf > src + 0.01)) {
          patchItem(next.id, {
            status: 'error',
            error: `目标帧率无效或未高于原帧率（原 ${fmtFps(src)} fps）`
          })
          continue
        }
        const out =
          itemsRef.current.length === 1 && live.outputLocked && live.outputPath
            ? live.outputPath
            : defaultOutput(next.path, tf, live.container)
        currentIdRef.current = next.id
        setCurrentItemId(next.id)
        patchItem(next.id, {
          status: 'rendering',
          progress: undefined,
          error: undefined,
          log: undefined,
          note: undefined,
          result: undefined
        })
        const res = await window.api.startRender({
          inputPath: next.path,
          outputPath: out,
          targetFps: tf,
          mode: live.mode,
          quality: live.quality,
          useNvenc: live.useNvenc,
          container: live.container
        })
        if (!res.ok) {
          patchItem(next.id, { status: 'error', error: res.error || '启动失败' })
          currentIdRef.current = null
          continue
        }
        setCommand(res.command || '')
        setEncoderLabel(res.encoderLabel || '')
        const term = await new Promise<'done' | 'error' | 'cancelled'>((resolve) => {
          terminalResolvers.current.set(next.id, resolve)
        })
        terminalResolvers.current.delete(next.id)
        currentIdRef.current = null
        if (term === 'cancelled') {
          itemsRef.current.forEach((i) => {
            if (i.status === 'pending') patchItem(i.id, { status: 'cancelled' })
          })
          break
        }
      }
    } finally {
      runningRef.current = false
      setCurrentItemId(null)
      setStage('done')
    }
  }, [patchItem])

  const cancel = useCallback(() => {
    void window.api.cancelRender()
  }, [])

  const removeItem = useCallback(
    (id: number) => {
      const it = itemsRef.current.find((i) => i.id === id)
      if (!it || running) return
      if (it.previewUrl.startsWith('blob:')) URL.revokeObjectURL(it.previewUrl)
      const next = itemsRef.current.filter((i) => i.id !== id)
      itemsRef.current = next
      setItems(next)
      if (selectedId === id) setSelectedId(null)
      if (!next.length) setStage('empty')
    },
    [running, selectedId]
  )

  const clearFinished = useCallback(() => {
    if (running) return
    const keep = itemsRef.current.filter((i) => i.status === 'pending')
    itemsRef.current.forEach((i) => {
      if (i.status !== 'pending' && i.previewUrl.startsWith('blob:')) URL.revokeObjectURL(i.previewUrl)
    })
    itemsRef.current = keep
    setItems(keep)
    setSelectedId(null)
    setStage(keep.length ? 'ready' : 'empty')
  }, [running])

  const retryFailed = useCallback(() => {
    if (running) return
    const next = itemsRef.current.map((i) =>
      i.status === 'error' || i.status === 'cancelled'
        ? { ...i, status: 'pending' as const, error: undefined, log: undefined, note: undefined }
        : i
    )
    itemsRef.current = next
    setItems(next)
    void runQueue()
  }, [running, runQueue])

  const chooseOutput = useCallback(async () => {
    const def = outputPath || (sel ? defaultOutput(sel.path, targetFps || 60, container) : 'output.mp4')
    const p = await window.api.pickOutput(def)
    if (p) {
      setOutputPath(p)
      setOutputLocked(true)
    }
  }, [outputPath, sel, targetFps, container])

  const changeContainer = useCallback(
    (v: 'mp4' | 'mkv') => {
      setPref('container', v)
      // 自定义输出路径的后缀跟随容器变化，简单起见回退到自动命名
      setOutputLocked(false)
      setOutputPath('')
    },
    [setPref]
  )

  const badge = nvencBadge(nvenc)
  const autoOut = sel && items.length === 1 ? defaultOutput(sel.path, targetFps || 60, container) : ''
  const shownOut = items.length === 1 ? (outputLocked ? outputPath : autoOut) : ''
  const canStart = !running && pendingCount > 0 && (items.length > 1 || fpsValid)

  // 标题栏双击空白处切换最大化（命中可交互元素时忽略）
  const onTitlebarDoubleClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea')) return
    void window.api?.windowControls?.toggleMaximize()
  }, [])

  return (
    <>
      <header className="top" onDoubleClick={onTitlebarDoubleClick}>
        <div className="brand">
          <div className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.95)" />
              <rect x="10" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.55)" />
              <rect x="17" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.95)" />
            </svg>
          </div>
          <div>
            <h1>FrameBoost</h1>
            <span>企业级本地视频补帧</span>
          </div>
        </div>
        <div className="badges">
          <span className={badge.cls}>{badge.text}</span>
          {meta?.ffmpegVersion && <span className="badge dim">ffmpeg {meta.ffmpegVersion}</span>}
        </div>
        <WindowButtons />
      </header>

      <div className="app">

      {!hasApi && (
        <div className="banner">
          当前是浏览器预览模式，选择文件与补帧功能需在桌面应用中运行（<code>npm run dev</code>）。
        </div>
      )}

      {items.length === 0 ? (
        <section
          className={'dropzone' + (dragOver ? ' drag' : '') + (busy ? ' busy' : '')}
          onClick={() => hasApi && !busy && fileInputRef.current?.click()}
        >
          <svg className="dz-icon" viewBox="0 0 48 48" fill="none" aria-hidden>
            <rect x="4" y="10" width="40" height="28" rx="4" stroke="currentColor" strokeWidth="2.4" />
            <path d="M4 18h40" stroke="currentColor" strokeWidth="2.4" />
            <path d="M12 10v8M20 10v8M28 10v8M36 10v8" stroke="currentColor" strokeWidth="2.4" />
            <path d="M20 26.5v7l6.5-3.5-6.5-3.5z" fill="currentColor" />
          </svg>
          <h2>{busy ? '正在读取视频信息…' : '拖入视频文件（支持多选），或点击选择'}</h2>
          <p>MP4 / MKV / MOV / AVI / WebM 等 · 全程本地处理，不会上传任何数据</p>
          <button
            className="ghost dz-browse"
            onClick={(e) => {
              e.stopPropagation()
              if (hasApi && !busy) void addViaDialog()
            }}
          >
            添加视频…
          </button>
        </section>
      ) : (
        <>
          <div className="workspace">
            <div className="col">
              {sel && (
                <section className="card preview-card">
                  {sel.previewUrl && <video key={sel.previewUrl} src={sel.previewUrl} controls muted playsInline />}
                  <div className="file-row">
                    <span className="fname" title={sel.path}>
                      {sel.fileName}
                    </span>
                    <span className={'chip st-chip ' + sel.status}>{ST_TEXT[sel.status]}</span>
                  </div>
                  <div className="chips">
                    <span className="chip">
                      {sel.info.width}×{sel.info.height}
                    </span>
                    <span className="chip">{fmtFps(selFps)} fps</span>
                    <span className="chip">{fmtDuration(sel.info.durationSec)}</span>
                    <span className="chip">
                      {sel.info.videoCodec.toUpperCase()}
                      {sel.info.pixFmt ? ` · ${sel.info.pixFmt}` : ''}
                    </span>
                    {sel.info.hasAudio ? (
                      <span className="chip">音轨 {sel.info.audioCodec}</span>
                    ) : (
                      <span className="chip dim">无音轨</span>
                    )}
                    <span className="chip">{fmtSize(sel.info.sizeBytes)}</span>
                  </div>
                </section>
              )}

              <section className="card queue-card">
                <div className="q-head">
                  <label>
                    处理队列 <span className="q-count">{items.length}</span>
                  </label>
                  <div className="q-actions">
                    <button className="mini" disabled={busy || !hasApi} onClick={() => void addViaDialog()}>
                      ＋ 添加视频
                    </button>
                  </div>
                </div>
                <ul className="queue">
                  {items.map((it) => {
                    const src = it.info.fps > 0 ? it.info.fps : it.info.avgFps
                    const tf = mult > 0 ? Math.round(src * mult) : Math.round(Number(customFps) || 0)
                    return (
                      <li
                        key={it.id}
                        className={'q-item' + (sel?.id === it.id ? ' sel' : '') + (currentItemId === it.id ? ' cur' : '')}
                        onClick={() => setSelectedId(it.id)}
                      >
                        <span className={'st ' + it.status}>{it.status === 'rendering' ? <i className="spin" /> : ST_ICON[it.status]}</span>
                        <div className="q-main">
                          <div className="q-name" title={it.path}>
                            {it.fileName}
                          </div>
                          <div className="q-sub">
                            {it.status === 'done' && it.result ? (
                              <>
                                → {fmtFps(it.result.fps ?? tf)} fps · {fmtSize(it.result.sizeBytes)}
                              </>
                            ) : it.status === 'pending' ? (
                              <>
                                {fmtFps(src)} → {tf > src ? tf : '—'} fps
                                {!(tf > src) ? <em className="bad"> 无法提升</em> : ''}
                              </>
                            ) : it.status === 'rendering' ? (
                              <>{Math.round(it.progress?.percent ?? 0)}% · {fmtFps(it.progress?.fps ?? 0)} fps 处理中</>
                            ) : (
                              <em className="bad">{it.error ?? ST_TEXT[it.status]}</em>
                            )}
                          </div>
                        </div>
                        {it.status === 'pending' && !running && (
                          <button
                            className="q-x"
                            title="移除"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeItem(it.id)
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            </div>

            <section className={'card settings' + (running ? ' disabled' : '')}>
              <div className="field">
                <label>目标帧率{sel ? <span className="lbl-hint">按所选视频计算</span> : null}</label>
                <div className="seg">
                  {[2, 3, 4].map((m) => (
                    <button key={m} className={mult === m ? 'on' : ''} onClick={() => setPref('mult', m)}>
                      ×{m}
                    </button>
                  ))}
                  <button className={mult === 0 ? 'on' : ''} onClick={() => setPref('mult', 0)}>
                    自定义
                  </button>
                </div>
                {mult === 0 && (
                  <input
                    className="fps-input"
                    value={customFps}
                    onChange={(e) => setPref('customFps', e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="例如 60"
                    inputMode="decimal"
                  />
                )}
                <div className={'hint' + (fpsValid || !sel ? '' : ' bad')}>
                  {sel
                    ? `${fmtFps(selFps)} fps → ${targetFps > 0 ? targetFps : '—'} fps${
                        !fpsValid && targetFps > 0 ? '（需高于原帧率）' : ''
                      }`
                    : ''}
                </div>
              </div>

              <div className="field">
                <label>补帧方式</label>
                <div className="mode-grid">
                  {MODES.map((m) => (
                    <div
                      key={m.id}
                      className={'mode-card' + (mode === m.id ? ' sel' : '')}
                      onClick={() => setPref('mode', m.id)}
                    >
                      <h4>{m.title}</h4>
                      <p>{m.desc}</p>
                      <div className="mode-meta">
                        <span className="mode-tag">{m.tag}</span>
                        <span className="mode-dots">
                          速度 <Dots n={m.speed} /> 画质 <Dots n={m.quality} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                {is4K && mode !== 'fast' && (
                  <div className="hint warn">当前为高分辨率视频，光流补帧会非常耗时；建议先用「帧混合」确认效果。</div>
                )}
              </div>

              <div className="field">
                <label>输出质量</label>
                <div className="quality-grid">
                  {QUALITIES.map((q) => (
                    <div
                      key={q.id}
                      className={'quality-card' + (quality === q.id ? ' sel' : '')}
                      onClick={() => setPref('quality', q.id)}
                    >
                      <h4>{q.title}</h4>
                      <p>{q.desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>封装格式</label>
                <div className="seg">
                  <button className={container === 'mp4' ? 'on' : ''} onClick={() => changeContainer('mp4')}>
                    MP4（兼容性最好）
                  </button>
                  <button className={container === 'mkv' ? 'on' : ''} onClick={() => changeContainer('mkv')}>
                    MKV
                  </button>
                </div>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={useNvenc}
                  onChange={(e) => setPref('useNvenc', e.target.checked)}
                />
                硬件加速（NVIDIA NVENC，不可用时自动回退 CPU）
              </label>
            </section>
          </div>

          <section className="card action">
            {running ? (
              <>
                <div className="overall">
                  正在处理 <b>{currentItem?.fileName ?? '…'}</b>
                  <span className="overall-stats">
                    完成 {doneCount} · 失败 {failedCount} · 剩余 {pendingCount}
                  </span>
                </div>
                {currentItem && (
                  <ProgressView
                    p={currentItem.progress ?? null}
                    duration={currentItem.info.durationSec}
                    note={currentItem.note ?? ''}
                    encoder={encoderLabel}
                    onCancel={cancel}
                  />
                )}
              </>
            ) : (
              <>
                {items.length === 1 ? (
                  <div className="out-row">
                    <span className="out-label">输出</span>
                    <input className="out-path" value={shownOut} readOnly title={shownOut} />
                    <button className="ghost" onClick={() => void chooseOutput()}>
                      修改…
                    </button>
                  </div>
                ) : (
                  <div className="out-note">
                    将为 {items.length} 个视频输出到各自源目录，自动命名（<code>原名_帧率fps.{container}</code>），重名自动加后缀。
                  </div>
                )}

                {sel?.status === 'error' && (
                  <div className="error-box">
                    <div>{sel.error}</div>
                    {sel.log && (
                      <details>
                        <summary>查看日志</summary>
                        <pre>{sel.log}</pre>
                      </details>
                    )}
                  </div>
                )}

                {stage === 'done' && (
                  <div className={'summary' + (failedCount > 0 ? ' warn' : '')}>
                    {failedCount === 0 ? '✓' : '⚠'} 队列结束：成功 {doneCount} · 失败 {failedCount}
                  </div>
                )}

                {sel?.status === 'done' && sel.result && (
                  <div className="result-box">
                    <div className="result-path" title={sel.result.outputPath}>
                      {sel.result.outputPath}
                    </div>
                    <div className="chips">
                      <span className="chip ok">{fmtFps(sel.result.fps ?? 0)} fps</span>
                      <span className="chip ok">{fmtSize(sel.result.sizeBytes)}</span>
                      <span className="chip ok">{fmtDuration(sel.result.durationSec ?? 0)}</span>
                    </div>
                    <div className="btn-row result-actions">
                      <button
                        className="mini"
                        title="在文件管理器中显示输出文件"
                        onClick={() => void window.api.showInFolder(sel.result!.outputPath)}
                      >
                        打开所在文件夹
                      </button>
                    </div>
                  </div>
                )}

                <div className="btn-row main-actions">
                  {stage === 'done' && failedCount > 0 ? (
                    <button className="primary" onClick={retryFailed}>
                      重试失败项（{failedCount}）
                    </button>
                  ) : (
                    <button className="primary" disabled={!canStart || busy} onClick={() => void runQueue()}>
                      开始补帧{pendingCount > 1 ? `（${pendingCount} 个）` : ''}
                    </button>
                  )}
                  <button className="ghost" disabled={!doneCount && !failedCount} onClick={clearFinished}>
                    清空已完成
                  </button>
                </div>
                <p className="fine">
                  光流补帧为 CPU 密集型，高分辨率下耗时可能达到视频时长的数倍至数十倍；建议先用「帧混合」快速预览，再用光流模式出成片。
                  处理全程在本地进行。
                </p>
                {command && (
                  <details className="cmd">
                    <summary>查看本次使用的 ffmpeg 命令</summary>
                    <pre>{command}</pre>
                  </details>
                )}
              </>
            )}
          </section>
        </>
      )}

      {dragOver && (
        <div className="drag-overlay">
          <div>松开以添加视频（支持多选）</div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void addFiles(e.target.files)
          e.currentTarget.value = ''
        }}
      />
      </div>
    </>
  )
}

// 自绘标题栏三键：最小化 / 最大化(还原) / 关闭
function WindowButtons() {
  const controls = typeof window !== 'undefined' ? window.api?.windowControls : undefined
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!controls) return
    void controls
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return controls.onMaximizedChange(setMaximized)
  }, [controls])

  if (!controls) return null

  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => void controls.minimize()}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="win-btn"
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
        onClick={() => void controls.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <rect x="1.5" y="3.5" width="7" height="7" rx="1.2" />
            <path d="M3.5 3.5v-2h7v7h-2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.2" />
          </svg>
        )}
      </button>
      <button className="win-btn close" title="关闭" aria-label="关闭" onClick={() => void controls.close()}>
        <svg viewBox="0 0 12 12" width="12" height="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden>
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  )
}

function nvencBadge(level: NvencLevel | null): { text: string; cls: string } {
  if (level === 'modern') return { text: 'NVENC 硬件加速可用', cls: 'badge ok' }
  if (level === 'legacy') return { text: 'NVENC（旧版驱动）可用', cls: 'badge ok' }
  if (level === 'none') return { text: '无独立显卡加速 · CPU 编码', cls: 'badge dim' }
  return { text: '检测硬件…', cls: 'badge dim' }
}

function ProgressView(props: {
  p: ProgressData | null
  duration: number
  note: string
  encoder: string
  onCancel: () => void
}) {
  const { p, duration, note, encoder, onCancel } = props
  const percent = Math.min(100, p?.percent ?? 0)
  const remain =
    p && p.speed && p.speed > 0 && duration > 0 ? Math.max(0, (duration - p.outTimeSec) / p.speed) : null
  return (
    <div className="prog">
      <div className="prog-head">
        <strong>{percent >= 100 ? '正在收尾写入文件…' : '正在补帧'}</strong>
        <span className="pct">{percent.toFixed(1)}%</span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="stats">
        <span>
          已处理 <b>{fmtDuration(p?.outTimeSec ?? 0)}</b> / {fmtDuration(duration)}
        </span>
        <span>
          输出帧 <b>{p?.frame ?? 0}</b> / {p?.totalFrames ?? '—'}
        </span>
        <span>
          处理帧率 <b>{p?.fps ? `${p.fps} fps` : '—'}</b>
        </span>
        <span>
          速度 <b>{p?.speed ? `${p.speed.toFixed(2)}x` : '—'}</b>
        </span>
        <span>
          剩余约 <b>{remain != null && Number.isFinite(remain) ? fmtDuration(remain) : '—'}</b>
        </span>
      </div>
      {encoder && <div className="stats dim">编码器：{encoder}</div>}
      {note && <div className="note">{note}</div>}
      <div className="btn-row">
        <button className="ghost danger" onClick={onCancel}>
          取消任务
        </button>
      </div>
    </div>
  )
}
