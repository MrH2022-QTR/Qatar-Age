/**
 * Sprite-sheet auto-slicer.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * tools/pack-sprites.mjs handles the AoE2 DE scrape, where every frame is its
 * own PNG with exact metadata. This handles the opposite case: a single large
 * sheet where sprites are laid out approximately and the declared grid does not
 * survive contact with the actual pixels.
 *
 * The medieval slice pack is exactly that. Its manifest declares 8 columns x 4
 * rows at 128px cells; the images are 1536x1024 with 5 content rows, variable
 * row heights, and columns that touch. Slicing that on a fixed grid clips heads
 * off and leaves feet behind.
 *
 * So instead of trusting a grid, we find the sprites: threshold the alpha
 * channel, label connected components, and take each blob's bounding box. That
 * works on a tidy grid and on a hand-arranged sheet equally well.
 *
 * ── Anchors ──────────────────────────────────────────────────────────────────
 *
 * The anchor is the pixel that sits on the unit's world position. For a
 * standing figure that is the horizontal centre of the blob, at its lowest
 * opaque row — the feet. Getting this wrong makes units hover or sink, and it
 * is the single most visible sprite bug in an isometric game.
 *
 * Usage:
 *   node tools/slice-sheet.mjs --in pack/units/spearman_sheet.png --id spearman \
 *        --out public/assets/sprites [--rows idle,walk,attack,death,corpse]
 *   node tools/slice-sheet.mjs --pack <dir> --out public/assets/sprites
 *   node tools/slice-sheet.mjs --selftest
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import sharp from 'sharp'

/** Alpha above this counts as sprite content. Tuned to reject soft glow haze. */
const ALPHA_THRESHOLD = 64

/** Blobs smaller than this are noise, not sprites. */
const MIN_BLOB_PX = 400

/** Blobs whose bounding boxes overlap vertically by more than this merge into one row. */
const ROW_OVERLAP = 0.35

// ── Connected-component labelling ────────────────────────────────────────────

/**
 * Two-pass union-find labelling over the alpha mask.
 *
 * 8-connected, because sprite limbs frequently touch the body only diagonally
 * after thresholding, and 4-connectivity splits them into separate blobs.
 */
function findBlobs(alpha, W, H) {
  const labels = new Int32Array(W * H)
  const parent = [0]

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  let next = 1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (alpha[i] <= ALPHA_THRESHOLD) continue

      // Neighbours already visited: W, NW, N, NE
      const n = []
      if (x > 0 && labels[i - 1]) n.push(labels[i - 1])
      if (y > 0) {
        if (x > 0 && labels[i - W - 1]) n.push(labels[i - W - 1])
        if (labels[i - W]) n.push(labels[i - W])
        if (x < W - 1 && labels[i - W + 1]) n.push(labels[i - W + 1])
      }

      if (n.length === 0) {
        labels[i] = next
        parent[next] = next
        next++
      } else {
        const m = Math.min(...n)
        labels[i] = m
        for (const l of n) union(m, l)
      }
    }
  }

  // Collect bounding boxes per root label.
  const boxes = new Map()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!labels[i]) continue
      const r = find(labels[i])
      let b = boxes.get(r)
      if (!b) {
        b = { x0: x, y0: y, x1: x, y1: y, count: 0, bottomSum: 0, bottomCount: 0 }
        boxes.set(r, b)
      }
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y < b.y0) b.y0 = y
      if (y > b.y1) b.y1 = y
      b.count++
    }
  }

  return [...boxes.values()].filter((b) => b.count >= MIN_BLOB_PX)
}

/** Group blobs into rows by vertical overlap, then sort each row left to right. */
function groupIntoRows(blobs) {
  const sorted = [...blobs].sort((a, b) => a.y0 - b.y0)
  const rows = []

  for (const b of sorted) {
    const h = b.y1 - b.y0
    let placed = false
    for (const row of rows) {
      const overlap = Math.min(row.y1, b.y1) - Math.max(row.y0, b.y0)
      if (overlap > h * ROW_OVERLAP) {
        row.items.push(b)
        row.y0 = Math.min(row.y0, b.y0)
        row.y1 = Math.max(row.y1, b.y1)
        placed = true
        break
      }
    }
    if (!placed) rows.push({ y0: b.y0, y1: b.y1, items: [b] })
  }

  rows.sort((a, b) => a.y0 - b.y0)
  for (const r of rows) r.items.sort((a, b) => a.x0 - b.x0)
  return rows
}

/**
 * Find the anchor: horizontal centre of the blob, at the lowest row that still
 * carries a meaningful amount of content. Using the absolute lowest opaque
 * pixel picks up stray shadow fringe and sinks the unit.
 */
function findAnchor(alpha, W, box) {
  const bw = box.x1 - box.x0 + 1
  let bottomY = box.y1
  for (let y = box.y1; y >= box.y0; y--) {
    let run = 0
    for (let x = box.x0; x <= box.x1; x++) {
      if (alpha[y * W + x] > ALPHA_THRESHOLD) run++
    }
    if (run > bw * 0.08) {
      bottomY = y
      break
    }
  }

  // Horizontal centre of mass on the bottom few rows — steadier than the
  // bounding-box centre when a figure leans or carries a weapon out to one side.
  let sum = 0
  let count = 0
  for (let y = Math.max(box.y0, bottomY - 6); y <= bottomY; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (alpha[y * W + x] > ALPHA_THRESHOLD) {
        sum += x
        count++
      }
    }
  }
  const cx = count > 0 ? Math.round(sum / count) : Math.round((box.x0 + box.x1) / 2)

  return { x: cx - box.x0, y: bottomY - box.y0 }
}

// ── Slicing ──────────────────────────────────────────────────────────────────

export async function sliceSheet(file, opts = {}) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height

  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * 4 + 3]

  const blobs = findBlobs(alpha, W, H)
  const rows = groupIntoRows(blobs)

  const cells = rows.map((row) =>
    row.items.map((b) => ({
      x: b.x0,
      y: b.y0,
      w: b.x1 - b.x0 + 1,
      h: b.y1 - b.y0 + 1,
      ...(() => {
        const a = findAnchor(alpha, W, b)
        return { anchorX: a.x, anchorY: a.y }
      })(),
    })),
  )

  return { width: W, height: H, rows: cells }
}

/**
 * Turn a sliced sheet into a SpriteManifest entry.
 *
 * Row -> animation. Column -> facing. When a row has fewer columns than the
 * requested facing count, facings are distributed across what exists and the
 * remainder mirror — which is the honest thing to do with a pack that does not
 * ship a full rotation set.
 */
export function toManifest(id, sliced, sheetFile, rowNames, facings = 8) {
  const frames = []
  const animations = {}

  sliced.rows.forEach((cells, rowIndex) => {
    const name = rowNames[rowIndex] ?? `row${rowIndex}`
    const offset = frames.length

    for (const c of cells) {
      frames.push({ page: 0, x: c.x, y: c.y, w: c.w, h: c.h, anchorX: c.anchorX, anchorY: c.anchorY })
    }

    const n = cells.length
    if (n === 0) return

    // Map each requested facing onto an available column. With fewer columns
    // than facings, adjacent facings share art rather than leaving gaps.
    const lookup = []
    for (let a = 0; a < facings; a++) {
      const half = Math.floor(facings / 2)
      const mirrored = a > half
      const src = mirrored ? facings - a : a
      const col = Math.min(n - 1, Math.round((src / half) * (n - 1)))
      const idx = offset + col
      lookup.push([mirrored ? -(idx + 1) : idx])
    }

    animations[name] = {
      name,
      storedAngles: n,
      angles: facings,
      frameCount: 1,
      duration: name === 'walk' ? 0.6 : 0.8,
      loop: !/die|death|corpse|decay/i.test(name),
      lookup,
    }
  })

  return {
    id,
    pages: { main: [basename(sheetFile)] },
    pageWidth: sliced.width,
    pageHeight: sliced.height,
    frames,
    animations,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f, d = null) => {
    const i = a.indexOf(f)
    return i >= 0 && a[i + 1] ? a[i + 1] : d
  }
  return {
    in: get('--in'),
    pack: get('--pack'),
    id: get('--id'),
    out: get('--out', 'public/assets/sprites'),
    rows: (get('--rows', 'idle,walk,attack,death,corpse') ?? '').split(','),
    facings: Number(get('--facings', 8)),
    selftest: a.includes('--selftest'),
  }
}

async function selftest() {
  const tmp = join(process.cwd(), '.slice-selftest')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  // Build a sheet with a deliberately irregular layout: 3 rows, differing
  // column counts, varying sizes, and uneven spacing — i.e. what real packs
  // look like rather than what their manifests claim.
  const W = 600
  const H = 400
  const composites = []
  const expected = [4, 3, 5]
  const rowY = [20, 160, 300]

  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r]; c++) {
      const w = 40 + r * 6
      const h = 60 + c * 4
      composites.push({
        input: {
          create: { width: w, height: h, channels: 4, background: { r: 200, g: 80, b: 80, alpha: 1 } },
        },
        left: 25 + c * 110 + r * 7,
        top: rowY[r],
      })
    }
  }

  const file = join(tmp, 'test_sheet.png')
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toFile(file)

  const sliced = await sliceSheet(file)

  let failures = 0
  const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
    else {
      failures++
      console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }

  console.log('\n  Slicer self-test\n  ────────────────')
  check('found the right number of rows', sliced.rows.length === 3, `${sliced.rows.length} rows`)
  check(
    'found the right columns per row',
    JSON.stringify(sliced.rows.map((r) => r.length)) === JSON.stringify(expected),
    sliced.rows.map((r) => r.length).join(','),
  )
  check('every cell has non-zero size', sliced.rows.flat().every((c) => c.w > 0 && c.h > 0))
  check(
    'anchors sit at the bottom of each cell',
    sliced.rows.flat().every((c) => c.anchorY >= c.h - 2),
  )
  check(
    'anchors sit near the horizontal centre',
    sliced.rows.flat().every((c) => Math.abs(c.anchorX - c.w / 2) <= 2),
  )

  const m = toManifest('test', sliced, file, ['idle', 'walk', 'die'], 8)
  check('manifest names rows', Object.keys(m.animations).join(',') === 'idle,walk,die')
  check('die does not loop', m.animations.die.loop === false)
  check(
    'every lookup entry resolves',
    Object.values(m.animations).every((a) =>
      a.lookup.flat().every((v) => m.frames[v < 0 ? -(v + 1) : v] !== undefined),
    ),
  )
  check('8 facings produced from fewer columns', m.animations.walk.lookup.length === 8)

  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n  ${failures === 0 ? 'All slicer checks passed.' : `${failures} failure(s).`}\n`)
  return failures
}

const opts = parseArgs()

if (opts.selftest) {
  process.exit((await selftest()) === 0 ? 0 : 1)
} else if (opts.pack) {
  // Slice every unit sheet in a pack directory.
  mkdirSync(opts.out, { recursive: true })
  const library = { version: 1, generator: 'tools/slice-sheet.mjs', sprites: {} }
  const unitDir = join(opts.pack, 'units')
  const files = existsSync(unitDir) ? readdirSync(unitDir).filter((f) => f.endsWith('.png')) : []

  for (const f of files) {
    const id = basename(f, '.png').replace(/_sheet$/, '')
    const sliced = await sliceSheet(join(unitDir, f))
    library.sprites[id] = toManifest(id, sliced, f, opts.rows, opts.facings)
    console.log(
      `  ${id}: ${sliced.rows.length} rows [${sliced.rows.map((r) => r.length).join(',')}] -> ${library.sprites[id].frames.length} frames`,
    )
  }

  writeFileSync(join(opts.out, 'manifest.json'), JSON.stringify(library, null, 2))
  console.log(`\nwrote ${Object.keys(library.sprites).length} sprite(s) -> ${opts.out}/manifest.json`)
} else if (opts.in) {
  const sliced = await sliceSheet(opts.in)
  const id = opts.id ?? basename(opts.in, '.png').replace(/_sheet$/, '')
  console.log(JSON.stringify(toManifest(id, sliced, opts.in, opts.rows, opts.facings), null, 2))
} else {
  console.error('usage: node tools/slice-sheet.mjs --pack <dir> --out <dir>')
  console.error('   or: node tools/slice-sheet.mjs --in <sheet.png> [--id name]')
  console.error('   or: node tools/slice-sheet.mjs --selftest')
  process.exit(2)
}
