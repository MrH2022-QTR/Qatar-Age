/**
 * Sprite packer: AoE2 DE scrape → PixiJS-ready atlases + manifest.
 *
 * Reads the exact layout documented in age-of-kings-qatar's
 * assets/raw/SCRAPE_INDEX.md:
 *
 *     <scrape>/gfx/graphics/<sprite_id>/
 *       meta.json          { frames: [ { w, h, hotspot:{x,y}, layers:{ main:{file,bbox}, ... } } ] }
 *       f000.png           main RGBA
 *       f000_s.png         shadow alpha
 *       f000_p.png         player-colour mask
 *       f000_d.png         damage overlay
 *
 * and emits, per sprite group:
 *
 *     <out>/<group>.main.0.png     packed atlas pages, one set per layer
 *     <out>/<group>.shadow.0.png
 *     <out>/<group>.player.0.png
 *     <out>/manifest.json          SpriteLibraryManifest (see src/render/sprites/types.ts)
 *
 * ── Why pack at all ──────────────────────────────────────────────────────────
 *
 * The scrape is 6.54 million individual PNGs. A browser cannot open those as
 * files, and PixiJS batches draw calls per texture — so every sprite sharing an
 * atlas is one draw call instead of hundreds. Atlas discipline is the single
 * biggest determinant of frame rate in a sprite-heavy RTS.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node tools/pack-sprites.mjs --scrape /path/to/assets/raw --out public/aoe-assets \
 *        --sprites u_cav_knight,u_inf_spearman,b_feudal_town_center
 *
 *   node tools/pack-sprites.mjs --selftest      # synthetic frames, no scrape needed
 *
 * The self-test builds fake sprites in a temp dir and runs the whole pipeline,
 * so the packer and manifest format are provable before any real art arrives.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import sharp from 'sharp'

const MAX_PAGE = 4096
const PADDING = 2

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f, d = null) => {
    const i = a.indexOf(f)
    return i >= 0 && a[i + 1] ? a[i + 1] : d
  }
  return {
    scrape: get('--scrape'),
    out: get('--out', 'public/aoe-assets'),
    sprites: get('--sprites'),
    angles: Number(get('--angles', 8)),
    selftest: a.includes('--selftest'),
    verbose: a.includes('--verbose'),
  }
}

// ── Shelf packer ─────────────────────────────────────────────────────────────
//
// Frames from one animation are near-identical in size, so a shelf packer gets
// within a few percent of optimal here and is a fraction of the complexity of
// MaxRects. Sorting by height first is what makes shelves tight.

function packRects(rects, maxSize = MAX_PAGE) {
  const sorted = [...rects].sort((a, b) => b.h - a.h || b.w - a.w)
  const pages = []
  let page = { w: 0, h: 0, shelfY: 0, shelfH: 0, cursorX: 0, items: [] }

  const flush = () => {
    if (page.items.length) pages.push(page)
    page = { w: 0, h: 0, shelfY: 0, shelfH: 0, cursorX: 0, items: [] }
  }

  for (const r of sorted) {
    const w = r.w + PADDING
    const h = r.h + PADDING

    if (w > maxSize || h > maxSize) {
      throw new Error(`frame ${r.id} is ${r.w}x${r.h}, larger than the ${maxSize}px page limit`)
    }

    if (page.cursorX + w > maxSize) {
      // New shelf.
      page.shelfY += page.shelfH
      page.shelfH = 0
      page.cursorX = 0
    }
    if (page.shelfY + h > maxSize) {
      flush()
    }

    page.items.push({ ...r, x: page.cursorX, y: page.shelfY })
    page.cursorX += w
    page.shelfH = Math.max(page.shelfH, h)
    page.w = Math.max(page.w, page.cursorX)
    page.h = Math.max(page.h, page.shelfY + page.shelfH)
  }
  flush()

  // Round page dimensions up to powers of two — some GPUs still prefer it and
  // it keeps mipmapping well-behaved if we ever enable it.
  for (const p of pages) {
    p.w = Math.min(maxSize, nextPow2(p.w))
    p.h = Math.min(maxSize, nextPow2(p.h))
  }
  return pages
}

const nextPow2 = (n) => {
  let p = 1
  while (p < n) p *= 2
  return p
}

// ── Scrape reading ───────────────────────────────────────────────────────────

const LAYER_SUFFIX = { main: '', shadow: '_s', player: '_p', damage: '_d' }

/**
 * AoE2 sprite ids look like `u_cav_knight_attackA_x1`.
 * Split into the base unit (`u_cav_knight`) and the animation (`attackA`).
 */
function splitSpriteId(dirName) {
  const noVariant = dirName.replace(/_x\d+$/, '')
  const parts = noVariant.split('_')
  // The animation is the last segment; everything before is the unit id.
  const anim = parts.length > 1 ? parts[parts.length - 1] : 'idle'
  const base = parts.length > 1 ? parts.slice(0, -1).join('_') : noVariant
  return { base, anim }
}

function readSpriteDir(dir) {
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (!Array.isArray(meta.frames) || meta.frames.length === 0) return null
  return meta
}

// ── Packing one animation ────────────────────────────────────────────────────

async function packAnimation(dir, meta, layersWanted) {
  const frames = meta.frames
  const rects = frames.map((fr, i) => ({
    id: i,
    w: Math.max(1, fr.w ?? fr.canvas?.w ?? 1),
    h: Math.max(1, fr.h ?? fr.canvas?.h ?? 1),
    hotspot: fr.hotspot ?? { x: 0, y: 0 },
    layers: fr.layers ?? {},
  }))

  const pages = packRects(rects)

  // Frame table in source order, not packed order.
  const frameTable = new Array(frames.length)
  for (let p = 0; p < pages.length; p++) {
    for (const item of pages[p].items) {
      frameTable[item.id] = {
        page: p,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        anchorX: item.hotspot.x ?? 0,
        anchorY: item.hotspot.y ?? 0,
      }
    }
  }

  // Composite each layer's pages.
  const layerBuffers = {}
  for (const layer of layersWanted) {
    const suffix = LAYER_SUFFIX[layer]
    const pageBuffers = []

    for (let p = 0; p < pages.length; p++) {
      const composites = []
      for (const item of pages[p].items) {
        const declared = item.layers[layer]?.file
        const file = declared
          ? join(dir, basename(declared))
          : join(dir, `f${String(item.id).padStart(3, '0')}${suffix}.png`)
        if (!existsSync(file)) continue

        // bbox tells us where the trimmed layer sits on the full canvas.
        const bbox = item.layers[layer]?.bbox
        const offX = Array.isArray(bbox) ? bbox[0] : 0
        const offY = Array.isArray(bbox) ? bbox[1] : 0

        composites.push({
          input: file,
          left: item.x + offX,
          top: item.y + offY,
        })
      }

      if (composites.length === 0) {
        pageBuffers.push(null)
        continue
      }

      const buf = await sharp({
        create: {
          width: pages[p].w,
          height: pages[p].h,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(composites)
        .png({ compressionLevel: 9 })
        .toBuffer()

      pageBuffers.push(buf)
    }

    if (pageBuffers.some(Boolean)) layerBuffers[layer] = pageBuffers
  }

  return { pages, frameTable, layerBuffers }
}

/**
 * Build the angle × frame lookup table.
 *
 * AoE2 stores a subset of facings and mirrors the rest. With `storedAngles`
 * distinct directions covering half the compass, directions past the halfway
 * point reuse the mirrored frame — encoded as -(index+1).
 */
function buildLookup(totalFrames, angles, storedAngles) {
  const perAngle = Math.max(1, Math.floor(totalFrames / storedAngles))
  const lookup = []
  for (let a = 0; a < angles; a++) {
    const row = []
    const mirrored = a >= storedAngles
    const srcAngle = mirrored ? (angles - a) % storedAngles : a
    for (let f = 0; f < perAngle; f++) {
      const idx = srcAngle * perAngle + f
      row.push(mirrored ? -(idx + 1) : idx)
    }
    lookup.push(row)
  }
  return { lookup, perAngle }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function packSprites(opts) {
  const gfxRoot = join(opts.scrape, 'gfx', 'graphics')
  if (!existsSync(gfxRoot)) {
    throw new Error(`no gfx/graphics under ${opts.scrape} — is this the scrape root?`)
  }

  const wanted = opts.sprites ? new Set(opts.sprites.split(',').map((s) => s.trim())) : null
  const dirs = readdirSync(gfxRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  mkdirSync(opts.out, { recursive: true })

  const library = { version: 1, generator: 'tools/pack-sprites.mjs', sprites: {} }
  let packed = 0

  for (const dirName of dirs) {
    const { base, anim } = splitSpriteId(dirName)
    if (wanted && !wanted.has(base)) continue

    const dir = join(gfxRoot, dirName)
    const meta = readSpriteDir(dir)
    if (!meta) continue

    const result = await packAnimation(dir, meta, ['main', 'shadow', 'player', 'damage'])
    const { lookup, perAngle } = buildLookup(meta.frames.length, opts.angles, Math.ceil(opts.angles / 2) + 1)

    const sprite = (library.sprites[base] ??= {
      id: base,
      pages: { main: [] },
      pageWidth: result.pages[0]?.w ?? 0,
      pageHeight: result.pages[0]?.h ?? 0,
      frames: [],
      animations: {},
    })

    // Offset this animation's frames into the sprite's shared frame table.
    const frameOffset = sprite.frames.length
    const pageOffset = sprite.pages.main.length

    for (const f of result.frameTable) {
      if (!f) continue
      sprite.frames.push({ ...f, page: f.page + pageOffset })
    }

    for (const [layer, buffers] of Object.entries(result.layerBuffers)) {
      sprite.pages[layer] ??= []
      for (let p = 0; p < buffers.length; p++) {
        if (!buffers[p]) continue
        const name = `${base}.${layer}.${pageOffset + p}.png`
        writeFileSync(join(opts.out, name), buffers[p])
        sprite.pages[layer].push(name)
      }
    }

    sprite.animations[anim] = {
      name: anim,
      storedAngles: Math.ceil(opts.angles / 2) + 1,
      angles: opts.angles,
      frameCount: perAngle,
      duration: (meta.duration ?? perAngle * 0.1),
      loop: !/die|death|decay/i.test(anim),
      lookup: lookup.map((row) => row.map((v) => (v < 0 ? v - frameOffset : v + frameOffset))),
    }

    packed++
    if (opts.verbose) console.log(`  ${base}.${anim}: ${meta.frames.length} frames -> ${result.pages.length} page(s)`)
  }

  writeFileSync(join(opts.out, 'manifest.json'), JSON.stringify(library, null, 2))
  return { packed, sprites: Object.keys(library.sprites).length }
}

// ── Self-test ────────────────────────────────────────────────────────────────
//
// Generates a synthetic scrape and runs the real pipeline over it. This is what
// lets the packer, the manifest format and the renderer be proven correct
// before any actual AoE2 art is available in the session.

async function selftest() {
  const tmp = join(process.cwd(), '.selftest-scrape')
  const out = join(process.cwd(), '.selftest-out')
  rmSync(tmp, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })

  const ANGLES = 5
  const PER_ANGLE = 6
  const SIZE = 48

  for (const anim of ['idle', 'walk', 'attackA', 'die']) {
    const dir = join(tmp, 'gfx', 'graphics', `u_test_knight_${anim}_x1`)
    mkdirSync(dir, { recursive: true })

    const frames = []
    for (let i = 0; i < ANGLES * PER_ANGLE; i++) {
      const hue = Math.floor((i / (ANGLES * PER_ANGLE)) * 255)
      // main: a solid square, colour varying by frame so mis-ordering is visible
      await sharp({
        create: { width: SIZE, height: SIZE, channels: 4, background: { r: hue, g: 120, b: 200, alpha: 1 } },
      })
        .png()
        .toFile(join(dir, `f${String(i).padStart(3, '0')}.png`))

      // player mask: a small centred block
      await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
      })
        .png()
        .toFile(join(dir, `f${String(i).padStart(3, '0')}_p.png`))

      // shadow
      await sharp({
        create: { width: SIZE, height: 12, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.4 } },
      })
        .png()
        .toFile(join(dir, `f${String(i).padStart(3, '0')}_s.png`))

      frames.push({
        w: SIZE,
        h: SIZE,
        hotspot: { x: SIZE / 2, y: SIZE - 4 },
        layers: {
          main: { file: `f${String(i).padStart(3, '0')}.png`, bbox: [0, 0, SIZE, SIZE] },
          player: { file: `f${String(i).padStart(3, '0')}_p.png`, bbox: [16, 16, 32, 32] },
          shadow: { file: `f${String(i).padStart(3, '0')}_s.png`, bbox: [0, SIZE - 12, SIZE, SIZE] },
        },
      })
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ frames }, null, 2))
  }

  const res = await packSprites({ scrape: tmp, out, sprites: 'u_test_knight', angles: 8, verbose: true })

  // ── Assertions ─────────────────────────────────────────────────────────────
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  const sprite = manifest.sprites.u_test_knight
  let failures = 0
  const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
    else {
      failures++
      console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }

  console.log('\n  Packer self-test\n  ────────────────')
  check('sprite present', !!sprite)
  check('all four animations packed', Object.keys(sprite.animations).length === 4,
    Object.keys(sprite.animations).join(', '))
  check('main pages written', sprite.pages.main.length > 0, `${sprite.pages.main.length} page(s)`)
  check('player-colour mask preserved', (sprite.pages.player ?? []).length > 0)
  check('shadow layer preserved', (sprite.pages.shadow ?? []).length > 0)
  check('frame table populated', sprite.frames.length === 4 * ANGLES * PER_ANGLE,
    `${sprite.frames.length} frames`)
  check('hotspots carried through', sprite.frames.every((f) => f.anchorY === SIZE - 4))
  check('die does not loop', sprite.animations.die.loop === false)
  check('walk loops', sprite.animations.walk.loop === true)
  check('8 angle rows per animation', sprite.animations.walk.lookup.length === 8)

  // Every lookup entry must resolve to a real frame.
  let bad = 0
  for (const anim of Object.values(sprite.animations)) {
    for (const row of anim.lookup) {
      for (const v of row) {
        const idx = v < 0 ? -(v + 1) : v
        if (!sprite.frames[idx]) bad++
      }
    }
  }
  check('every lookup entry resolves to a real frame', bad === 0, `${bad} dangling`)

  // Mirrored entries should exist (angles > storedAngles).
  const mirrored = sprite.animations.walk.lookup.flat().filter((v) => v < 0).length
  check('mirrored angles are used', mirrored > 0, `${mirrored} mirrored entries`)

  rmSync(tmp, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })

  console.log(`\n  ${failures === 0 ? 'All packer checks passed.' : `${failures} failure(s).`}\n`)
  return failures
}

// ── Entry ────────────────────────────────────────────────────────────────────

const opts = parseArgs()

if (opts.selftest) {
  const failures = await selftest()
  process.exit(failures === 0 ? 0 : 1)
} else if (!opts.scrape) {
  console.error('usage: node tools/pack-sprites.mjs --scrape <assets/raw> --out <dir> [--sprites a,b,c]')
  console.error('   or: node tools/pack-sprites.mjs --selftest')
  process.exit(2)
} else {
  const res = await packSprites(opts)
  console.log(`packed ${res.packed} animation(s) across ${res.sprites} sprite(s) -> ${opts.out}`)
}
