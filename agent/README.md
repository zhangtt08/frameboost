# FrameBoost Agent API

把 FrameBoost 的真实能力（本机 ffmpeg/ffprobe、NVENC/10bit 检测、补帧渲染）封装成带 JSON Schema 的工具，供任意 Agent（Tcode、Claude Code、Codex、任何 MCP 客户端）调用。遵循 `personal-agent-hub/docs/AGENT_API_STANDARD.md`。

服务只监听 `127.0.0.1`，端口 **8791**（占用时自动 +1，并把实际地址写入 `agent/.endpoint`，MCP 桥优先读它）。

## 复用真实内核

`agent/` 里的 `server.mjs`、`mcp-server.mjs` 是从标准模板逐字节复制的（**不要改动逻辑**）。项目唯一需要写的是 `tools.mjs`，它 `require` 桌面应用**同一份**编译产物：

- `dist-electron/pipeline.js` ← `electron/pipeline.ts`（命令构建、尝试序列、输出命名）
- `dist-electron/ffmpeg.js` ← `electron/ffmpeg.ts`（二进制解析、ffprobe 探测、NVENC/10bit 检测）

所以 Agent 与桌面应用对同一能力的实现完全一致，不存在第二套逻辑或写死的假数据。因为依赖编译产物，运行前需要先构建。

## 启动

```bash
npm run agent:serve     # 先 npm run build:electron，再监听 http://127.0.0.1:8791
npm run agent:mcp       # stdio MCP 桥（自带拉起：优先读 agent/.endpoint / AGENT_DEFAULT_BASE）
```

直接起（不经 npm）时默认端口是模板约定的 8790，需显式给 8791：

```bash
node agent/server.mjs                        # 端口取自 AGENT_PORT（默认 8790）
AGENT_PORT=8791 node agent/server.mjs        # 绑定 8791
node -e "import('./agent/server.mjs').then(m=>m.start({port:8791}))"   # 跨平台强制 8791
```

`agent/launch.json` = `{"command":"node","args":["agent/server.mjs"],"ready_port":8791}`，MCP 桥据此探测/拉起。

## HTTP 契约

```
GET  /api/health          -> {ok:true, data:{project, version, agent_api:1, tools, uptime_ms}}
GET  /api/agent/tools     -> {ok:true, data:[{name, description, input_schema, risk}]}
GET  /api/agent/manifest  -> {ok:true, data:{project, version, base_url, tools}}
POST /api/agent/tool      -> body {tool, input} -> {ok:true, tool, ms, data}
                                失败 -> {ok:false, error:{code, message}}  (bad_input=400, 其余=500)
```

## 工具清单（前缀 `frameboost.`）

| 工具 | 风险 | 说明 |
|---|---|---|
| `frameboost.capability_probe` | read | 本机真实 ffmpeg/ffprobe 路径与版本、NVENC 等级（modern/legacy/none）、10bit 能力 |
| `frameboost.list_inputs` | read | 扫描目录列出可处理输入视频（真实 stat，含大小/修改时间）；`dir` 省略用默认位置 |
| `frameboost.probe_video` | read | ffprobe 单个文件，附 ×2/×3/×4 目标帧率建议 |
| `frameboost.render_start` | **exec** | 创建并真实执行补帧任务；**必须 `confirm:true`**，否则只返回预演计划（不 spawn 任何进程）。返回 `jobId` |
| `frameboost.job_status` | read | 轮询进度（百分比/已处理时长/处理帧率/倍速/剩余秒数）与完成后的真实回探结果 |
| `frameboost.cancel_job` | **write** | 停止运行中的任务并清理 `.part`；**必须 `confirm:true`** |
| `frameboost.list_outputs` | read | 列出目录中 FrameBoost 输出文件（命名约定 `原名_数字fps.mp4/mkv`） |

### 调用示例

```bash
# 只读：能力探测
curl -s http://127.0.0.1:8791/api/agent/tool -X POST -H 'content-type: application/json' \
  -d '{"tool":"frameboost.capability_probe","input":{}}'

# 补帧（写操作）：先不带 confirm 拿到计划，再带 confirm:true 真实执行
curl -s http://127.0.0.1:8791/api/agent/tool -X POST -H 'content-type: application/json' \
  -d '{"tool":"frameboost.render_start","input":{"inputPath":"D:/v/a.mp4","multiplier":2,"mode":"fast","confirm":true}}'

# 轮询进度 / 结果
curl -s http://127.0.0.1:8791/api/agent/tool -X POST -H 'content-type: application/json' \
  -d '{"tool":"frameboost.job_status","input":{"jobId":"<上一步返回的 jobId>"}}'
```

任务状态（`running` / `done` / `error` / `cancelled`）存活于 Agent 服务进程内存；进程重启后进行中的任务丢失（历史渲染产物仍在磁盘，可用 `list_outputs` 查看）。

## MCP

任何 MCP 客户端直接起 `node agent/mcp-server.mjs` 即可获得同一套工具；`tools/list` 转发自 `/api/agent/tools`，`tools/call` 转发到 `POST /api/agent/tool`。服务未启动时桥会按 `launch.json` 拉起（或先手动 `npm run agent:serve`）。

自检（stdio，三条 JSON-RPC 都应有响应）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"frameboost.capability_probe","arguments":{}}}' \
  | node agent/mcp-server.mjs
```
