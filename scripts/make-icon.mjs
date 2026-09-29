// 生成 build/icon.ico：SVG → 多尺寸 PNG → ICO
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
const pngToIcoMod = require('png-to-ico')
const pngToIco = pngToIcoMod.default ?? pngToIcoMod

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'))

const sizes = [256, 128, 64, 48, 32, 16]
const pngs = await Promise.all(sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer()))
const ico = await pngToIco(pngs)
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico)
// 附一张 512 PNG 供文档/商店使用
fs.writeFileSync(path.join(root, 'build', 'icon.png'), await sharp(svg).resize(512, 512).png().toBuffer())
console.log('icon.ico + icon.png generated, ico bytes =', ico.length)
