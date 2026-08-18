/**
 * Elevated isometric terrain.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A perfectly flat isometric plane is what reads as "2D and basic", no matter
 * how good the tile art is. Age of Empires has never been flat: its maps carry
 * per-tile elevation, hills cast their own silhouette, and units walking uphill
 * visibly climb. That height is most of what makes the world feel like a place
 * rather than a chessboard.
 *
 * The adopted simulation already carries it — `GameMap.elevation` is a
 * Uint8Array per tile — so the data was there all along; nothing was drawing it.
 *
 * ── How elevation works in an isometric projection ───────────────────────────
 *
 * Height is a pure vertical screen offset. A tile at elevation `e` draws
 * `e * ELEVATION_STEP` pixels higher than the same tile at zero, and everything
 * standing on it shifts by the same amount. That single rule gives hills,
 * plateaus and valleys.
 *
 * Two consequences that are easy to get wrong:
 *
 * 1. **Depth ordering changes.** Raising a tile does not change where it sits
 *    in the world, so depth must still come from (ne + se), NOT from screen y.
 *    Sorting by screen y makes a hilltop draw behind the valley in front of it.
 *
 * 2. **Cliff faces must be drawn.** Where a tile is higher than its downhill
 *    neighbour, the gap between them is a vertical wall. Without it, raised
 *    terrain looks like it is floating. We draw that face as a darkened skirt
 *    beneath the tile, which is exactly what the tile art's own earth edge
 *    already does for flat ground — here it just gets taller.
 */

import { Container, Graphics, Sprite, Texture, Rectangle, RenderTexture, type Renderer } from 'pixi.js'
import { HALF_H, HALF_W, worldToScreen } from '../sim/coords'

/** Screen pixels per elevation step. AoE2's own step is a shade under half a
 *  tile height; this matches that proportion. */
export const ELEVATION_STEP = 14

const CHUNK = 16

export interface ElevCell {
  x: number
  y: number
  w: number
  h: number
  anchorX: number
  anchorY: number
  diamond?: { width: number; height: number; centerX: number; centerY: number }
}

export interface ElevSheet {
  sheet: string
  width: number
  height: number
  rows: ElevCell[][]
}

/** Terrain source the renderer reads. Deliberately narrow so it can be fed
 *  either our TerrainGrid or the adopted simulation's GameMap. */
export interface ElevationSource {
  width: number
  height: number
  /** Atlas [row, col] for the tile at (ne, se). */
  tileAt(ne: number, se: number): [number, number]
  /** Elevation step count at (ne, se). */
  elevationAt(ne: number, se: number): number
  /** Bumped when anything changes, so chunks re-bake. */
  revision: number
}

export function screenYForElevation(elev: number): number {
  return -elev * ELEVATION_STEP
}

export class ElevatedTerrainRenderer {
  readonly container = new Container()

  private src: ElevationSource
  private sheet: ElevSheet
  private atlas: Texture
  private renderer: Renderer

  private chunkSprites = new Map<string, Sprite>()
  private chunkTextures = new Map<string, RenderTexture>()
  private cols: number
  private rows: number
  private lastRevision = -1

  private readonly scaleX: number
  private readonly scaleY: number

  constructor(src: ElevationSource, sheet: ElevSheet, atlas: Texture, renderer: Renderer) {
    this.src = src
    this.sheet = sheet
    this.atlas = atlas
    this.renderer = renderer
    this.cols = Math.ceil(src.width / CHUNK)
    this.rows = Math.ceil(src.height / CHUNK)

    const sample = sheet.rows[0]?.[0]
    const d = sample?.diamond
    this.scaleX = d ? (HALF_W * 2) / d.width : 1
    this.scaleY = d ? (HALF_H * 2) / d.height : this.scaleX

    this.bakeAll()
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
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) this.bakeChunk(cx, cy)
    }
    this.lastRevision = this.src.revision
  }

  private bakeChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`
    const startNe = cx * CHUNK
    const startSe = cy * CHUNK
    const endNe = Math.min(startNe + CHUNK, this.src.width)
    const endSe = Math.min(startSe + CHUNK, this.src.height)

    // Find the tallest tile in this chunk so the texture is tall enough to hold
    // it plus its cliff skirt.
    let maxElev = 0
    for (let se = startSe; se < endSe; se++) {
      for (let ne = startNe; ne < endNe; ne++) {
        const e = this.src.elevationAt(ne, se)
        if (e > maxElev) maxElev = e
      }
    }

    const corners = [
      worldToScreen({ ne: startNe, se: startSe }),
      worldToScreen({ ne: endNe, se: startSe }),
      worldToScreen({ ne: startNe, se: endSe }),
      worldToScreen({ ne: endNe, se: endSe }),
    ]
    const minX = Math.min(...corners.map((c) => c.x)) - HALF_W
    const maxX = Math.max(...corners.map((c) => c.x)) + HALF_W
    const minY = Math.min(...corners.map((c) => c.y)) - HALF_H * 3 - maxElev * ELEVATION_STEP
    const maxY = Math.max(...corners.map((c) => c.y)) + HALF_H * 4

    const w = Math.ceil(maxX - minX)
    const h = Math.ceil(maxY - minY)
    if (w <= 0 || h <= 0) return

    const staging = new Container()

    // Back to front by (ne + se). Depth must come from world position, not
    // screen y — see the header note.
    const order: Array<{ ne: number; se: number }> = []
    for (let se = startSe; se < endSe; se++) {
      for (let ne = startNe; ne < endNe; ne++) order.push({ ne, se })
    }
    order.sort((a, b) => a.ne + a.se - (b.ne + b.se))

    for (const t of order) {
      const elev = this.src.elevationAt(t.ne, t.se)
      const [row, col] = this.src.tileAt(t.ne, t.se)
      const tex = this.cellTexture(row, col)
      const cell = this.sheet.rows[row]?.[col]
      if (!tex || !cell) continue

      const p = worldToScreen({ ne: t.ne + 0.5, se: t.se + 0.5 })
      const px = p.x - minX
      const py = p.y - minY + screenYForElevation(elev)

      // Cliff skirt: where this tile stands above the neighbours in front of
      // it, fill the gap so raised ground does not appear to float.
      const downhill = Math.max(
        elev - this.src.elevationAt(t.ne + 1, t.se),
        elev - this.src.elevationAt(t.ne, t.se + 1),
        0,
      )
      if (downhill > 0) {
        const drop = downhill * ELEVATION_STEP
        const g = new Graphics()
        // Two quads matching the diamond's lower edges, darkened like a shaded
        // rock face.
        g.poly([px - HALF_W, py, px, py + HALF_H, px, py + HALF_H + drop, px - HALF_W, py + drop])
          .fill({ color: 0x6b5a42 })
        g.poly([px + HALF_W, py, px, py + HALF_H, px, py + HALF_H + drop, px + HALF_W, py + drop])
          .fill({ color: 0x54462f })
        staging.addChild(g)
      }

      const s = new Sprite(tex)
      s.scale.set(this.scaleX, this.scaleY)
      const d = cell.diamond
      s.anchor.set((d ? d.centerX : cell.w / 2) / cell.w, (d ? d.centerY : cell.h / 2) / cell.h)
      s.position.set(px, py)

      // Subtle height shading: higher ground catches more light. Cheap, and it
      // makes relief readable even where the silhouette is ambiguous.
      if (elev > 0) s.tint = tintForElevation(elev)

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
    // Chunks sort by their far corner so neighbouring chunks stack correctly
    // once elevation makes them overlap.
    sprite.zIndex = startNe + startSe
  }

  syncIfDirty(): void {
    if (this.src.revision === this.lastRevision) return
    this.bakeAll()
  }

  destroy(): void {
    for (const t of this.chunkTextures.values()) t.destroy(true)
    this.chunkTextures.clear()
    this.container.destroy({ children: true })
  }
}

/** Brighten with height — a stand-in for real directional lighting. */
function tintForElevation(elev: number): number {
  const f = Math.min(1, 1 + elev * 0.055)
  const c = Math.min(255, Math.round(255 * f))
  return (c << 16) | (c << 8) | c
}
