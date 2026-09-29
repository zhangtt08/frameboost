// 生成一个 6 秒 30fps 的演示视频（含移动画面与音轨），用于体验补帧效果
// 用法：npm run sample  →  生成 sample-30fps.mp4
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path

const out = path.resolve(process.argv[2] ?? 'sample-30fps.mp4')
const args = [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  '-shortest',
  out
]
console.log('生成演示视频:', out)
const child = spawn(ffmpegPath, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => process.exit(code ?? 1))
