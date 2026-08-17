/**
 * Sprite-based terrain rendering.
 *
 * Replaces the flat-shaded diamonds in terrain-renderer.ts with real tile art.
 * This is the single largest visual difference between "programmer prototype"
 * and "looks like Age of Empires" — terrain is most of the screen, so whatever
 * it looks like, the game looks like.
 *
 * ── Chunk baking ─────────────────────────────────────────────────────────────
 *
 * A 96x96 map is 9,216 tiles. One Sprite per tile would batch (they all share
 * the atlas) but still costs 9,216 transform updates and a sort every frame.
 *
 * Instead each 16x16 chunk is drawn once into a RenderTexture and thereafter
 * displayed as a single Sprite. That turns 9,216 sprites into 36, and a chunk
 * is only re-baked when its terrain actually changes. openage chunks its
 * terrain renderer for exactly this reason (libopenage/renderer/stages/terrain/).
 *
 * ── Tile art with thickness ──────────────────────────────────────────────────
 *
 * The pack's tiles are drawn as plates with a visible earth edge below the
 * diamond face, not as flat lozenges. Drawn back-to-front that edge is hidden
 * by the tile in front, which reads as solid ground — and gives the terrain a
 * sense of depth that flat tiles never have. It does mean draw order within a
 * chunk matters: rows must go back to front, or the earth edges paint over the
 * tiles they should sit behind.
 */

import { Container, Sprite, Texture, Rectangle, RenderTexture, type Renderer } from 'pixi.js'
import { HALF_H, HALF_W, worldToScreen } from '../sim/coords'
import { TerrainType, type TerrainGrid } from '../sim/grid'
import type { Camera } from './camera'

const CHUNK = 16

/** One sliced cell from the terrain atlas. */
interface TileCell {
  x: number
  y: number
  w: number
  h: number
  anchorX: number
  anchorY: number
  /** True diamond geometry, from tools/measure-terrain.mjs. */
  diamond?: { width: number; height: number; centerX: number; centerY: number }
}

interface TerrainSheet {
  sheet: string
  width: number
  height: number
  rows: TileCell[][]
}

/**
 * Which atlas cell renders each terrain type, as [row, column].
 *
 * Chosen against the pack's actual layout:
 *   row 0  grass variants          row 3  grass/sand, stone, rock, mountain
 *   row 1  sand, dirt, road        row 4  water, forest
 *   row 2  stone floor, gravel     row 5  transitions
 *
 * Several types list alternates; the renderer picks between them with a
 * position hash so large flats do not tile visibly. AoE2 does the same thing
 * with its per-terrain variant sets.
 */
const TERRAIN_TILES: Record<TerrainType, Array<[number, number]>> = {
  [TerrainType.Sand]: [[1, 0], [1, 1], [5, 2]],
  [TerrainType.Desert]: [[1, 1], [1, 2], [1, 3]],
  [TerrainType.Gravel]: [[2, 2], [2, 1], [3, 2]],
  [TerrainType.Grass]: [[0, 0], [0, 1], [0, 2], [0, 4]],
  [TerrainType.ShallowWater]: [[4, 0], [4, 2]],
  [TerrainType.DeepWater]: [[4, 1]],
  [TerrainType.Rock]: [[3, 3], [3, 5], [2, 3]],
}

export class TerrainSpriteRenderer {
  readonly container = new Container()

  private grid: TerrainGrid
  private sheet: TerrainSheet
  private atlas: Texture
  private renderer: Renderer

  private chunkSprites = new Map<string, Sprite>()
  private chunkTextures = new Map<string, RenderTexture>()
  private chunkCols: number
  private chunkRows: number
  private lastRevision = -1

  /**
   * Per-axis scale. Terrain art rarely matches the engine's tile aspect ratio
   * exactly - this pack's diamond faces are 2.27:1 against our 2:1 - and a
   * uniform scale leaves a few pixels of gap on every tile, which reads as a
   * grid of seams. Scaling each axis onto the engine tile makes faces meet.
   */
  private readonly scaleX: number
  private readonly scaleY: number

  constructor(grid: TerrainGrid, sheet: TerrainSheet, atlas: Texture, renderer: Renderer) {
    this.grid = grid
    this.sheet = sheet
    this.atlas = atlas
    this.renderer = renderer
    this.chunkCols = Math.ceil(grid.width / CHUNK)
    this.chunkRows = Math.ceil(grid.height / CHUNK)

    // Derive scale from the measured diamond rather than the bounding box, so
    // the earth thickness below the face overhangs instead of being squashed
    // into the tile.
    const sample = sheet.rows[0]?.[0]
    const d = sample?.diamond
    this.scaleX = d ? (HALF_W * 2) / d.width : sample ? (HALF_W * 2) / sample.w : 1
    this.scaleY = d ? (HALF_H * 2) / d.height : this.scaleX

    this.bakeAll()
  }

  /** Deterministic variant choice, so the map looks identical every load. */
  private variantFor(type: TerrainType, ne: number, se: number): [number, number] {
    const options = TERRAIN_TILES[type] ?? TERRAIN_TILES[TerrainType.Sand]
    if (options.length === 1) return options[0]!
    const h = ((ne * 73856093) ^ (se * 19349663)) >>> 0
    return options[h % options.length]!
  }

  private cellTexture(row: number, col: number): Texture | null {
    const cell = this.sheet.rows[row]?.[col]
    if (!cell) return null
    return new Texture({
      source: this.atlas.source,
      frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
    })
  }

  private bakeAll(): void {
    for (let cy = 0; cy < this.chunkRows; cy++) {
      for (let cx = 0; cx < this.chunkCols; cx++) this.bakeChunk(cx, cy)
    }
    this.lastRevision = this.grid.revision
  }

  private bakeChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`
    const startNe = cx * CHUNK
    const startSe = cy * CHUNK
    const endNe = Math.min(startNe + CHUNK, this.grid.width)
    const endSe = Math.min(startSe + CHUNK, this.grid.height)

    // Screen bounds of this chunk. A chunk of tiles forms a diamond, so the
    // texture must cover the full diamond plus the tile art's overhang.
    const corners = [
      worldToScreen({ ne: startNe, se: startSe }),
      worldToScreen({ ne: endNe, se: startSe }),
      worldToScreen({ ne: startNe, se: endSe }),
      worldToScreen({ ne: endNe, se: endSe }),
    ]
    const minX = Math.min(...corners.map((c) => c.x)) - HALF_W
    const maxX = Math.max(...corners.map((c) => c.x)) + HALF_W
    const minY = Math.min(...corners.map((c) => c.y)) - HALF_H * 3
    const maxY = Math.max(...corners.map((c) => c.y)) + HALF_H * 3

    const w = Math.ceil(maxX - minX)
    const h = Math.ceil(maxY - minY)
    if (w <= 0 || h <= 0) return

    const staging = new Container()

    // Back to front: increasing (ne + se) walks away from the viewer toward it,
    // so the earth edges of nearer tiles correctly overlap those behind.
    const tiles: Array<{ ne: number; se: number; depth: number }> = []
    for (let se = startSe; se < endSe; se++) {
      for (let ne = startNe; ne < endNe; ne++) tiles.push({ ne, se, depth: ne + se })
    }
    tiles.sort((a, b) => a.depth - b.depth)

    for (const t of tiles) {
      const type = this.grid.getTerrain(t.ne, t.se) as TerrainType
      const [row, col] = this.variantFor(type, t.ne, t.se)
      const tex = this.cellTexture(row, col)
      if (!tex) continue

      const cell = this.sheet.rows[row]![col]!
      const s = new Sprite(tex)
      s.scale.set(this.scaleX, this.scaleY)

      // Anchor on the diamond's centre - the point that must land on the
      // tile's world centre. Using the bounding-box centre instead would sink
      // every tile by half its earth thickness.
      const d = cell.diamond
      const ax = d ? d.centerX : cell.w / 2
      const ay = d ? d.centerY : cell.h / 2
      s.anchor.set(ax / cell.w, ay / cell.h)

      const p = worldToScreen({ ne: t.ne + 0.5, se: t.se + 0.5 })
      s.position.set(p.x - minX, p.y - minY)
      staging.addChild(s)
    }

    let rt = this.chunkTextures.get(key)
    if (!rt || rt.width !== w || rt.height !== h) {
      rt?.destroy(true)
      rt = RenderTexture.create({ width: w, height: h, antialias: false })
      this.chunkTextures.set(key, rt)
    }

    this.renderer.render({ container: staging, target: rt, clear: true })
    staging.destroy({ children: true })

    let sprite = this.chunkSprites.get(key)
    if (!sprite) {
      sprite = new Sprite(rt)
      this.chunkSprites.set(key, sprite)
      this.container.addChild(sprite)
    } else {
      sprite.texture = rt
    }
    sprite.position.set(minX, minY)
  }

  /** Re-bake when the cost grid changes — a building went up or came down. */
  syncIfDirty(): void {
    if (this.grid.revision === this.lastRevision) return
    this.bakeAll()
  }

  cull(camera: Camera): void {
    const v = camera.visibleWorldBounds(CHUNK)
    for (let cy = 0; cy < this.chunkRows; cy++) {
      for (let cx = 0; cx < this.chunkCols; cx++) {
        const s = this.chunkSprites.get(`${cx},${cy}`)
        if (!s) continue
        const minNe = cx * CHUNK
        const minSe = cy * CHUNK
        s.visible =
          minNe + CHUNK >= v.minNe && minNe <= v.maxNe && minSe + CHUNK >= v.minSe && minSe <= v.maxSe
      }
    }
  }

  destroy(): void {
    for (const t of this.chunkTextures.values()) t.destroy(true)
    this.chunkTextures.clear()
    this.container.destroy({ children: true })
  }
}

/** Fetch the terrain slice metadata written by tools/slice-sheet.mjs. */
export async function loadTerrainSheet(baseUrl: string): Promise<TerrainSheet | null> {
  try {
    const res = await fetch(`${baseUrl}/terrain.json`)
    if (!res.ok) return null
    return (await res.json()) as TerrainSheet
  } catch {
    return null
  }
}
