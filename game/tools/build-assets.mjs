/**
 * Asset build: slice every sheet in the art library into one manifest.
 *
 * The library ships 65 sheets in a dozen categories, each an approximate grid
 * that does not match its declared layout. Writing a bespoke loader per
 * category would be a dozen near-identical files; instead every sheet goes
 * through the same connected-component slicer (tools/slice-sheet.mjs) and lands
 * in one manifest keyed by category and name.
 *
 * Terrain gets an extra pass (tools/measure-terrain.mjs) because tiles need
 * true diamond geometry, not bounding boxes.
 *
 * Usage:
 *   node tools/build-assets.mjs --lib <extracted-library> --out public/assets/sprites
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { sliceSheet } from './slice-sheet.mjs'

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const LIB = arg('--lib')
const OUT = arg('--out', 'public/assets/sprites')

if (!LIB) {
  console.error('usage: node tools/build-assets.mjs --lib <dir> [--out <dir>]')
  process.exit(2)
}

/**
 * Categories to process, and how each sheet's rows should be named.
 *
 * `rows: null` means "leave rows unnamed" — the consumer indexes numerically.
 * Naming matters only where the runtime looks a row up by meaning (unit
 * animations, building damage states).
 */
const CATEGORIES = {
  units: { rows: ['idle', 'walk', 'attack', 'death', 'corpse'] },
  animations: { rows: null },
  buildings: { rows: null },
  resources: { rows: null },
  doodads: { rows: null },
  terrain: { rows: null },
  wildlife: { rows: null },
  effects: { rows: null },
  factions: { rows: null },
  hud: { rows: null },
  items: { rows: null },
  armor: { rows: null },
}

mkdirSync(OUT, { recursive: true })

const manifest = { version: 2, generator: 'tools/build-assets.mjs', sheets: {} }
let total = 0
let cells = 0

for (const [category, cfg] of Object.entries(CATEGORIES)) {
  const dir = join(LIB, category)
  if (!existsSync(dir)) continue

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const id = basename(file, '.png')
    const key = `${category}/${id}`
    const src = join(dir, file)

    // Copy the sheet next to the manifest so the browser can fetch it.
    const outName = `${category}__${file}`
    copyFileSync(src, join(OUT, outName))

    const sliced = await sliceSheet(src)
    const rows = sliced.rows.map((r, i) => ({
      name: cfg.rows?.[i] ?? `row${i}`,
      cells: r,
    }))

    manifest.sheets[key] = {
      id,
      category,
      file: outName,
      width: sliced.width,
      height: sliced.height,
      rows,
    }

    const n = sliced.rows.flat().length
    cells += n
    total++
    console.log(
      `  ${key.padEnd(34)} ${sliced.width}x${sliced.height}  ` +
        `${sliced.rows.length} rows [${sliced.rows.map((r) => r.length).join(',')}] = ${n} cells`,
    )
  }
}

writeFileSync(join(OUT, 'sheets.json'), JSON.stringify(manifest, null, 1))
console.log(`\nsliced ${total} sheets, ${cells} cells -> ${OUT}/sheets.json`)
