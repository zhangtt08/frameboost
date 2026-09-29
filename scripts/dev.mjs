import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

const server = await createServer({ server: { port: 5173, strictPort: true } })
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173'
console.log('[frameboost dev] renderer:', url)

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: url },
  windowsHide: false
})

child.on('exit', async (code) => {
  try {
    await server.close()
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  })
}
