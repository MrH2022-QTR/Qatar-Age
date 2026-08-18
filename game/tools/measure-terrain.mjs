/**
 * Measure the diamond geometry of each terrain tile.
 *
 * Slicing a terrain atlas by bounding box is not enough. A tile's bounding box
 * includes the earth thickness drawn below the diamond face, and the face
 * itself may not match the engine's tile aspect ratio — this pack's faces are
 * 200x88 (2.27:1) while our tile is 64x32 (2:1).
 *
 * Scale such a tile uniformly and every tile falls a few pixels short of its
 * neighbour, which reads as a grid of seams rather than continuous ground. The
 * fix is to scale each axis independently onto the engine's tile, which needs
 * the true diamond dimensions rather than the bounding box.
 *
 * For each cell this finds:
 *   - the widest opaque row, which is the diamond's horizontal axis
 *   - the topmost opaque row, giving the upper half-height
 *   - the horizontal centre of that widest row
 *
 * The diamond is assumed symmetric about its horizontal axis, so the face is
 * `widest` wide by `2 * (axisY - topY)` tall. Everything below that is earth
 * thickness, which should overhang rather than be squashed into the tile.
 *
 * Usage: node tools/measure-terrain.mjs --atlas <png> --slices <json> --out <json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const ALPHA = 64

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const atlasPath = arg('--atlas', 'public/assets/sprites/terrain_atlas.png')
const slicesPath = arg('--slices', 'public/assets/sprites/terrain.json')
const outPath = arg('--out', slicesPath)

const sheet = JSON.parse(readFileSync(slicesPath, 'utf8'))
const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width
const A = (x, y) => data[(y * W + x) * 4 + 3]

let measured = 0

for (const row of sheet.rows) {
  for (const cell of row) {
    let widest = 0
    let axisY = 0
    let axisL = 0
    let axisR = 0
    let topY = -1

    for (let y = 0; y < cell.h; y++) {
      let l = -1
      let r = -1
      for (let x = 0; x < cell.w; x++) {
        if (A(cell.x + x, cell.y + y) > ALPHA) {
          if (l < 0) l = x
          r = x
        }
      }
      if (l < 0) continue
      if (topY < 0) topY = y
      const w = r - l + 1
      if (w > widest) {
        widest = w
        axisY = y
        axisL = l
        axisR = r
      }
    }

    if (widest === 0) continue

    const halfHeight = Math.max(1, axisY - topY)

    // The diamond's centre: horizontal midpoint of the widest row, on that row.
    cell.diamond = {
      width: widest,
      height: halfHeight * 2,
      centerX: Math.round((axisL + axisR) / 2),
      centerY: axisY,
    }
    measured++
  }
}

sheet.measured = true
writeFileSync(outPath, JSON.stringify(sheet, null, 2))

const sample = sheet.rows[0]?.[0]?.diamond
console.log(`measured ${measured} tiles -> ${outPath}`)
if (sample) {
  console.log(
    `  sample diamond: ${sample.width}x${sample.height} ` +
      `(aspect ${(sample.width / sample.height).toFixed(2)}:1), centre (${sample.centerX}, ${sample.centerY})`,
  )
}
