#!/usr/bin/env node
/**
 * build/generate-icons.js
 * Generates simple PNG placeholder icons for the extension using the Canvas API
 * via the `canvas` npm package (optional dev dependency).
 *
 * If the `canvas` package is not installed the script falls back to creating
 * minimal valid 1×1 PNG files so the extension can still be loaded in developer
 * mode.  Replace these with proper artwork before publishing.
 *
 * Usage:
 *   node build/generate-icons.js
 */

const fs = require('fs')
const path = require('path')

const ICONS_DIR = path.resolve(__dirname, '../extension/icons')

// Ensure output directory exists
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true })
}

// ---------------------------------------------------------------------------
// Minimal valid 1×1 transparent PNG (base64)
// Used as a fallback when the `canvas` package is unavailable.
// ---------------------------------------------------------------------------
const MINIMAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function writeFallback(size) {
  const file = path.join(ICONS_DIR, `icon-${size}.png`)
  if (fs.existsSync(file)) {
    console.log(`  icon-${size}.png already exists — skipping`)
    return
  }
  fs.writeFileSync(file, Buffer.from(MINIMAL_PNG_B64, 'base64'))
  console.log(`  icon-${size}.png written (1×1 placeholder — replace with real artwork)`)
}

// ---------------------------------------------------------------------------
// Try to render proper icons using the `canvas` package
// ---------------------------------------------------------------------------
let Canvas
try {
  Canvas = require('canvas') // optional
} catch {
  /* not installed */
}

function renderIcon(size) {
  const file = path.join(ICONS_DIR, `icon-${size}.png`)
  if (fs.existsSync(file)) {
    console.log(`  icon-${size}.png already exists — skipping`)
    return
  }

  if (!Canvas) {
    writeFallback(size)
    return
  }

  const { createCanvas } = Canvas
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  // Background circle
  ctx.fillStyle = '#4CAF50'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()

  // Letter "E" for Eruda
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('E', size / 2, size / 2 + size * 0.03)

  const buf = canvas.toBuffer('image/png')
  fs.writeFileSync(file, buf)
  console.log(`  icon-${size}.png written (${size}×${size})`)
}

console.log('Generating extension icons…')
;[16, 48, 128].forEach(renderIcon)
console.log('Done.')
