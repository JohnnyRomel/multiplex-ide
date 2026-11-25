#!/usr/bin/env node
/**
 * Builds official Apple macOS squircle icon assets (`resources/icon.png` + `resources/icon.icns`)
 * from a full-bleed square source artwork using zero external npm dependencies
 * (Node.js built-in zlib + macOS sips & iconutil).
 *
 * Usage: node scripts/build-mac-icon.mjs <source-image-path>
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { execFileSync } from 'child_process'

const srcArg = process.argv[2]
if (!srcArg) {
  console.error('Usage: node scripts/build-mac-icon.mjs <source-image-path>')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const resourcesDir = path.join(projectRoot, 'resources')
fs.mkdirSync(resourcesDir, { recursive: true })

const tmpBmp = path.join(resourcesDir, '.icon-tmp-1024.bmp')
const iconPng = path.join(resourcesDir, 'icon.png')
const iconsetDir = path.join(resourcesDir, 'icon.iconset')
const iconIcns = path.join(resourcesDir, 'icon.icns')

// 1. Convert source image to 1024x1024 uncompressed BMP via macOS sips
execFileSync('/usr/bin/sips', ['-z', '1024', '1024', '-s', 'format', 'bmp', srcArg, '--out', tmpBmp], {
  stdio: 'pipe'
})

// 2. Parse BMP pixel data (supports 24-bit BGR and 32-bit BGRA, bottom-up or top-down)
const bmp = fs.readFileSync(tmpBmp)
const dataOffset = bmp.readUInt32LE(10)
const width = bmp.readInt32LE(18)
const rawHeight = bmp.readInt32LE(22)
const height = Math.abs(rawHeight)
const topDown = rawHeight < 0
const bpp = bmp.readUInt16LE(28)
const bytesPerPixel = bpp / 8
const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4

if (width !== 1024 || height !== 1024 || (bpp !== 24 && bpp !== 32)) {
  throw new Error(`Unexpected BMP geometry: ${width}x${height} @ ${bpp}bpp`)
}

function sampleSource(u, v) {
  // Bilinear sample in [0, 1] x [0, 1]
  const fx = Math.max(0, Math.min(width - 1.001, u * (width - 1)))
  const fy = Math.max(0, Math.min(height - 1.001, v * (height - 1)))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0

  const readPx = (x, y) => {
    const bmpY = topDown ? y : height - 1 - y
    const off = dataOffset + bmpY * rowStride + x * bytesPerPixel
    return [bmp[off + 2], bmp[off + 1], bmp[off]] // R, G, B
  }

  const c00 = readPx(x0, y0)
  const c10 = readPx(x1, y0)
  const c01 = readPx(x0, y1)
  const c11 = readPx(x1, y1)

  const out = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const top = c00[i] * (1 - tx) + c10[i] * tx
    const bot = c01[i] * (1 - tx) + c11[i] * tx
    out[i] = top * (1 - ty) + bot * ty
  }
  return out
}

// 3. Render official Apple macOS Big Sur/Sequoia 1024x1024 RGBA squircle icon
//    Canvas: 1024x1024 | Squircle body: 824x824 centered at (512, 512) | 4x4 supersampling
const SIZE = 1024
const HALF_CANVAS = SIZE / 2
const SQUIRCLE_HALF = 412 // 824px wide/tall per Apple macOS HIG
const CORNER_R = 205 // Apple continuous-curvature corner extent
const CORNER_P = 2.65 // G2 continuous corner blend (straight edges, smooth Apple corners)
const ART_ZOOM = 1.12 // Bold emblem framing inside the squircle

const rgba = Buffer.alloc(SIZE * SIZE * 4)

/**
 * Signed distance (in pixels, <= 0 inside) to an Apple macOS continuous-curvature squircle.
 * Perfectly flat straight sides + G2 continuous superelliptical corners.
 */
function squircleSdf(dx, dy, halfSize) {
  const flat = halfSize - CORNER_R
  const ax = Math.abs(dx) - flat
  const ay = Math.abs(dy) - flat
  if (ax <= 0 && ay <= 0) {
    return Math.max(ax, ay) - CORNER_R
  }
  const qx = Math.max(0, ax)
  const qy = Math.max(0, ay)
  return Math.pow(Math.pow(qx, CORNER_P) + Math.pow(qy, CORNER_P), 1 / CORNER_P) - CORNER_R
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = x + 0.5 - HALF_CANVAS
    const cy = y + 0.5 - HALF_CANVAS

    const coarseDist = squircleSdf(cx, cy, SQUIRCLE_HALF)

    let coverage = 0
    if (coarseDist < -2.0) {
      coverage = 1
    } else if (coarseDist > 2.0) {
      coverage = 0
    } else {
      // 4x4 supersampled anti-aliasing along the squircle edge
      let inside = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4 - HALF_CANVAS
          const py = y + (sy + 0.5) / 4 - HALF_CANVAS
          if (squircleSdf(px, py, SQUIRCLE_HALF) <= 0) inside++
        }
      }
      coverage = inside / 16
    }

    // Soft authentic macOS drop shadow below the squircle
    let shadowAlpha = 0
    if (coverage < 1) {
      const sDist = squircleSdf(cx, cy - 16, SQUIRCLE_HALF)
      if (sDist < 56) {
        const distOutside = Math.max(0, sDist + 4)
        const norm = distOutside / 52
        shadowAlpha = Math.max(0, 0.32 * Math.exp(-norm * norm * 3.8))
      }
    }

    let r = 0
    let g = 0
    let b = 0
    let a = 0

    if (coverage > 0) {
      // Map squircle interior to source artwork coordinates with subtle zoom
      const u = 0.5 + (cx / (SQUIRCLE_HALF * 2)) / ART_ZOOM
      const v = 0.5 + (cy / (SQUIRCLE_HALF * 2)) / ART_ZOOM
      ;[r, g, b] = sampleSource(u, v)

      // Subtle inner specular glass rim (brighter along top edge, crisp 2px inner highlight)
      if (coarseDist > -4.5 && coarseDist <= 0.5) {
        const edgeBand = 1 - Math.abs((coarseDist + 1.8) / 2.6)
        const topFactor = Math.max(0.22, Math.min(1.0, 0.65 - (cy / SQUIRCLE_HALF) * 0.5))
        const rimAlpha = Math.max(0, edgeBand) * 0.22 * topFactor
        r = r * (1 - rimAlpha) + 255 * rimAlpha
        g = g * (1 - rimAlpha) + 255 * rimAlpha
        b = b * (1 - rimAlpha) + 255 * rimAlpha
      }

      // Composite foreground over drop shadow cleanly
      const outA = coverage + shadowAlpha * (1 - coverage)
      if (outA > 0) {
        r = (r * coverage) / outA
        g = (g * coverage) / outA
        b = (b * coverage) / outA
      }
      a = outA
    } else if (shadowAlpha > 0) {
      r = 0
      g = 0
      b = 0
      a = shadowAlpha
    }

    const idx = (y * SIZE + x) * 4
    rgba[idx] = Math.max(0, Math.min(255, Math.round(r)))
    rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g)))
    rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b)))
    rgba[idx + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
  }
}

// 4. Minimal pure-Node PNG encoder (32-bit RGBA)
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodeRgbaPng(w, h, pixels) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1)
    raw[rowStart] = 0 // filter type 0 (None)
    pixels.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

fs.writeFileSync(iconPng, encodeRgbaPng(SIZE, SIZE, rgba))

// 5. Generate complete Apple .iconset and compile resources/icon.icns via iconutil
fs.rmSync(iconsetDir, { recursive: true, force: true })
fs.mkdirSync(iconsetDir, { recursive: true })

const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

for (const [name, px] of sizes) {
  const outFile = path.join(iconsetDir, name)
  if (px === 1024) {
    fs.copyFileSync(iconPng, outFile)
  } else {
    execFileSync('/usr/bin/sips', ['-z', String(px), String(px), iconPng, '--out', outFile], { stdio: 'pipe' })
  }
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', iconIcns], { stdio: 'pipe' })

// Clean up intermediate files
fs.rmSync(tmpBmp, { force: true })
fs.rmSync(iconsetDir, { recursive: true, force: true })

console.log(`Built macOS icons:\n  - ${iconPng} (${fs.statSync(iconPng).size} bytes)\n  - ${iconIcns} (${fs.statSync(iconIcns).size} bytes)`)
