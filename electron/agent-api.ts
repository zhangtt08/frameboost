// FrameBoost Agent API — 本地 HTTP 服务，供外部 agent 以 tool 形式调用。
// 随桌面应用启动（main.ts 在 app ready 时接线），复用应用内的 probe/render 流程。
// 渲染是异步任务：POST /api/render 启动，GET /api/job 轮询进度与结果。
// 端口：环境变量 FRAMEBOOST_API_PORT，默认 8393。仅监听 127.0.0.1。
import http from 'node:http'
import type { NvencLevel } from './pipeline'

export interface RenderStateSnapshot {
  done: boolean
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
}

export interface JobSummary {
  running: boolean
  outputPath?: string
  inputPath?: string
  targetFps?: number
  frame?: number
  fps?: number
  speed?: number | null
}

export interface AgentApiDeps {
  version: string
  startRender: (raw: unknown) => Promise<{ ok: boolean; [k: string]: unknown }>
  getJobSummary: () => JobSummary
  probeVideo: (inputPath: string) => Promise<unknown>
  detectNvenc: () => Promise<NvencLevel>
  lastRenderState: RenderStateSnapshot
}

export const DEFAULT_API_PORT = 8393

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createAgentApiServer(deps: AgentApiDeps): http.Server {
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /health') {
      send(res, 200, {
        ok: true,
        tool: 'frameboost',
        version: deps.version,
        hint: 'POST /api/render {inputPath, outputPath, targetFps, mode, quality?, useNvenc?, container?}；GET /api/job 轮询'
      })
      return
    }
    if (route === 'GET /api/nvenc') {
      send(res, 200, { ok: true, data: { nvenc: await deps.detectNvenc() } })
      return
    }
    if (route === 'POST /api/probe') {
      const body = await readBody(req)
      try {
        send(res, 200, { ok: true, data: await deps.probeVideo(String(body.inputPath ?? '')) })
      } catch (err) {
        send(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (route === 'POST /api/render') {
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (e) {
        send(res, 400, { ok: false, error: e instanceof Error ? e.message : '请求体无效' })
        return
      }
      const result = await deps.startRender(body)
      send(res, result.ok ? 202 : (String(result.error).includes('已有任务') ? 409 : 400), result)
      return
    }
    if (route === 'GET /api/job') {
      send(res, 200, { ok: true, data: { job: deps.getJobSummary(), last: deps.lastRenderState } })
      return
    }
    send(res, 404, { ok: false, error: `未知路由 ${route}，可用：GET /health、GET /api/nvenc、POST /api/probe、POST /api/render、GET /api/job` })
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) =>
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : '内部错误' })
    )
  })
}
