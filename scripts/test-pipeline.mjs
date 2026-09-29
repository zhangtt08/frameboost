// pipeline.ts 纯函数单元测试：node scripts/test-pipeline.mjs
// 需先编译：npm run build:electron
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const P = require('../dist-electron/pipeline.js')

let failed = 0
let total = 0

function eq(actual, expected, name) {
  total++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

function info(over = {}) {
  return {
    path: 'C:\\v\\a.mp4',
    fileName: 'a.mp4',
    sizeBytes: 1000,
    durationSec: 3,
    width: 640,
    height: 360,
    fps: 30,
    avgFps: 30,
    fpsRational: '30/1',
    pixFmt: 'yuv420p',
    videoCodec: 'h264',
    videoStreamIndex: 0,
    colorPrimaries: '',
    colorTrc: '',
    colorSpace: '',
    hasAudio: true,
    audioCodec: 'aac',
    ...over
  }
}

function params(over = {}) {
  return {
    inputPath: 'C:\\v\\a.mp4',
    outputPath: 'C:\\v\\a_60fps.mp4',
    targetFps: 60,
    mode: 'balanced',
    quality: 'high',
    useNvenc: true,
    container: 'mp4',
    ...over
  }
}

console.log('== sanitizeRational ==')
eq(P.sanitizeRational('30000/1001', 0), '30000/1001', '正常有理数保留')
eq(P.sanitizeRational('0/0', 29.97), '30', '0/0 回退数值')
eq(P.sanitizeRational('', 0), '', '无效且无回退')
eq(P.sanitizeRational('90000/1', 0), '', 'timebase 误报(>480fps)拒绝')
eq(P.sanitizeRational('30/1', 0), '30/1', '常规 30fps')
eq(P.sanitizeRational('240/1', 0), '240/1', '240fps 高速摄影合法')

console.log('== pixFmtFor ==')
eq(P.pixFmtFor('yuv420p10le', true), { fmt: 'yuv420p10le', downgraded: false }, '10bit 且支持 → 保持')
eq(P.pixFmtFor('yuv420p10le', false), { fmt: 'yuv420p', downgraded: true }, '10bit 不支持 → 降级 8bit')
eq(P.pixFmtFor('yuv420p', false), { fmt: 'yuv420p', downgraded: false }, '8bit 不受影响')

console.log('== buildFilter ==')
const fBal = P.buildFilter(params({ mode: 'balanced' }), info(), true)
eq(
  fBal,
  'fps=30/1,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=3.000,format=yuv420p',
  '均衡模式：fps归一→tpad→minterpolate→trim→format'
)
const fHigh = P.buildFilter(params({ mode: 'high' }), info(), true)
eq(
  /minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1/.test(fHigh),
  true,
  '精细模式 AOBMC+vsbmc'
)
const fFast = P.buildFilter(params({ mode: 'fast' }), info(), true)
eq(
  fFast,
  'tpad=stop_mode=clone:stop_duration=1,framerate=fps=60,trim=duration=3.000,format=yuv420p',
  '快速模式：tpad→framerate→trim→format'
)
const f10 = P.buildFilter(params({ mode: 'balanced' }), info({ pixFmt: 'yuv420p10le' }), true)
eq(/format=yuv420p10le$/.test(f10), true, '10bit 源输出 10bit')
const f8 = P.buildFilter(params({ mode: 'balanced' }), info({ pixFmt: 'yuv420p10le' }), false)
eq(/format=yuv420p$/.test(f8), true, '10bit 源降级输出 8bit')
const fNoDur = P.buildFilter(params(), info({ durationSec: 0 }), true)
eq(/tpad/.test(fNoDur), false, '无时长时不加 tpad')
const fVfr = P.buildFilter(params(), info({ fpsRational: '90000/1', fps: 0, avgFps: 29.97 }), true)
eq(/^fps=30,/.test(fVfr), true, 'VFR 误报帧率回退 avgFps 归一化')

console.log('== encoderArgs / 画质三档 ==')
eq(P.encoderArgs('none', 'master'), ['-c:v', 'libx264', '-preset', 'slow', '-crf', '10'], '母版级 CRF10')
eq(P.encoderArgs('none', 'high'), ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16'], '高画质 CRF16')
eq(P.encoderArgs('none', 'standard'), ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'], '标准 CRF20')
eq(
  P.encoderArgs('modern', 'high'),
  ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  'NVENC modern p6'
)
eq(
  P.encoderArgs('legacy', 'standard'),
  ['-c:v', 'h264_nvenc', '-preset', 'llhq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
  'NVENC legacy llhq'
)

console.log('== planAttempts ==')
const pNv = P.planAttempts(params(), 'modern', true)
eq(pNv.length, 3, 'NVENC 可用 → 3 级尝试')
eq(pNv[0], { nvenc: 'modern', audio: 'copy' }, '首选 NVENC+音轨直写')
eq(pNv[2], { nvenc: 'none', audio: 'aac' }, '末级 AAC 重编码')
eq(P.planAttempts(params(), 'none', true).length, 2, '无 NVENC → 2 级尝试')
eq(P.planAttempts(params(), 'modern', false).length, 2, '10bit 输出 → 跳过 NVENC')
eq(P.planAttempts(params({ useNvenc: false }), 'modern', true).length, 2, '关闭硬解 → 跳过 NVENC')

console.log('== resolveOutputPath ==')
const exists1 = () => false
eq(P.resolveOutputPath('C:\\v\\a_60fps.mp4', exists1), 'C:\\v\\a_60fps.mp4', '不冲突原样返回')
const taken = new Set(['C:\\v\\a_60fps.mp4', 'C:\\v\\a_60fps (1).mp4'])
eq(
  P.resolveOutputPath('C:\\v\\a_60fps.mp4', (p) => taken.has(p)),
  'C:\\v\\a_60fps (2).mp4',
  '重名自动 (2) 后缀'
)

console.log('== buildArgs ==')
const args = P.buildArgs(params(), info(), { nvenc: 'none', audio: 'copy' }, true)
eq(args[0], '-y', '首参 -y')
eq(args.includes('-nostdin'), true, '包含 -nostdin')
eq(args.includes('-progress'), true, '包含 -progress')
eq(args.includes('0:a:0?'), true, '音轨可选映射')
eq(
  args.includes('fps=30/1,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=3.000,format=yuv420p'),
  true,
  '滤镜链完整'
)
eq(args[args.length - 1], 'C:\\v\\a_60fps.mp4.part', '输出为 .part 文件')
eq(args.includes('mov'), true, 'mp4 → mov 封装器')
const argsMkv = P.buildArgs(params({ container: 'mkv' }), info(), { nvenc: 'none', audio: 'aac' }, true)
eq(argsMkv.includes('matroska'), true, 'mkv → matroska 封装器')
eq(argsMkv.includes('192k'), true, 'AAC 时带码率')
eq(argsMkv.includes('+faststart'), false, 'mkv 无 faststart')
const argsColor = P.buildArgs(
  params(),
  info({ colorPrimaries: 'bt2020', colorTrc: 'smpte2084', colorSpace: 'bt2020nc' }),
  { nvenc: 'none', audio: 'copy' },
  true
)
eq(
  argsColor.includes('-color_primaries') && argsColor.includes('bt2020') && argsColor.includes('smpte2084'),
  true,
  'HDR 色彩元数据透传'
)

console.log('== encoderLabel ==')
eq(P.encoderLabel('none'), 'CPU · libx264', 'CPU 标签')
eq(P.encoderLabel('modern'), 'NVIDIA NVENC · H.264', 'NVENC 标签')

console.log(`\n${total - failed}/${total} passed${failed ? `，${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
