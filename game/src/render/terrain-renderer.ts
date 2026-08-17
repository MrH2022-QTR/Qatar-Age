/**
 * Terrain rendering.
 *
 * Chunked, following openage's approach (libopenage/renderer/stages/terrain/)
 * for the same reason: a single Graphics holding every tile on a 128x128 map is
 * 16,384 polygons that must be rebuilt in full whenever one tile changes.
 * Chunking makes an edit cost one chunk rebuild, and lets us cull off-screen
 * chunks entirely.
 *
 * Placeholder art: flat-shaded diamonds tinted per terrain type. Swapping in
 * real tile textures later means replacing the fill in `buildChunk` with a
 * TilingSprite or a mesh — nothing else here changes.
 */

import { Container, Graphics } from 'pixi.js'
import { HALF_H, HALF_W, worldToScreen } from '../sim/coords'
import { TERRAIN, type TerrainGrid, type TerrainType } from '../sim/grid'
import type { Camera } from './camera'

const CHUNK = 16

/** Slightly vary tile shade by position so large flats do not look like plastic. */
function shadeFor(base: number, ne: number, se: number): number {
  // Deterministic hash — no RNG, so the map looks identical on every load.
  const h = ((ne * 73856093) ^ (se * 19349663)) >>> 0
  const jitter = ((h % 17) - 8) * 1.2

  const r = Math.min(255, Math.max(0, ((base >> 16) & 0xff) + jitter))
  const g = Math.min(255, Math.max(0, ((base >> 8) & 0xff) + jitter))
  const b = Math.min(255, Math.max(0, (base & 0xff) + jitter))
  return (r << 16) | (g << 8) | b
}

export class TerrainRenderer {
  readonly container = new Container()

  private grid: TerrainGrid
  private chunks = new Map<string, Graphics>()
  private chunkCols: number
  private chunkRows: number
  private lastRevision = -1

  constructor(grid: TerrainGrid) {
    this.grid = grid
    this.chunkCols = Math.ceil(grid.width / CHUNK)
    this.chunkRows = Math.ceil(grid.height / CHUNK)
    this.container.sortableChildren = false
    this.rebuildAll()
  }

  rebuildAll(): void {
    for (const g of this.chunks.values()) g.destroy()
    this.chunks.clear()
    this.container.removeChildren()

    for (let cy = 0; cy < this.chunkRows; cy++) {
      for (let cx = 0; cx < this.chunkCols; cx++) {
        const g = this.buildChunk(cx, cy)
        this.chunks.set(`${cx},${cy}`, g)
        this.container.addChild(g)
      }
    }
    this.lastRevision = this.grid.revision
  }

  private buildChunk(cx: number, cy: number): Graphics {
    const g = new Graphics()

    const startNe = cx * CHUNK
    const startSe = cy * CHUNK
    const endNe = Math.min(startNe + CHUNK, this.grid.width)
    const endSe = Math.min(startSe + CHUNK, this.grid.height)

    for (let se = startSe; se < endSe; se++) {
      for (let ne = startNe; ne < endNe; ne++) {
        const type = this.grid.getTerrain(ne, se) as TerrainType
        const def = TERRAIN[type]
        if (!def) continue

        // Diamond for tile (ne, se): west, north, east, south corners.
        const w = worldToScreen({ ne, se })
        const n = worldToScreen({ ne: ne + 1, se })
        const e = worldToScreen({ ne: ne + 1, se: se + 1 })
        const s = worldToScreen({ ne, se: se + 1 })

        g.poly([w.x, w.y, n.x, n.y, e.x, e.y, s.x, s.y])
        g.fill({ color: shadeFor(def.debugColor, ne, se) })
      }
    }
    return g
  }

  /** Rebuild if the cost grid changed (a building went up or came down). */
  syncIfDirty(): void {
    if (this.grid.revision === this.lastRevision) return
    // Terrain type changes are rare outside map generation; a full rebuild is
    // simpler than tracking which chunks are affected, and fast enough because
    // it only happens on genuine terrain edits.
    this.rebuildAll()
  }

  /** Hide chunks outside the view. Cheap and effective on large maps. */
  cull(camera: Camera): void {
    const v = camera.visibleWorldBounds(CHUNK)
    for (let cy = 0; cy < this.chunkRows; cy++) {
      for (let cx = 0; cx < this.chunkCols; cx++) {
        const g = this.chunks.get(`${cx},${cy}`)
        if (!g) continue
        const minNe = cx * CHUNK
        const minSe = cy * CHUNK
        g.visible =
          minNe + CHUNK >= v.minNe &&
          minNe <= v.maxNe &&
          minSe + CHUNK >= v.minSe &&
          minSe <= v.maxSe
      }
    }
  }

  /** Grid overlay, for debugging coordinate math. */
  buildGridOverlay(): Graphics {
    const g = new Graphics()
    for (let ne = 0; ne <= this.grid.width; ne++) {
      const a = worldToScreen({ ne, se: 0 })
      const b = worldToScreen({ ne, se: this.grid.height })
      g.moveTo(a.x, a.y).lineTo(b.x, b.y)
    }
    for (let se = 0; se <= this.grid.height; se++) {
      const a = worldToScreen({ ne: 0, se })
      const b = worldToScreen({ ne: this.grid.width, se })
      g.moveTo(a.x, a.y).lineTo(b.x, b.y)
    }
    g.stroke({ width: 1, color: 0x000000, alpha: 0.12 })
    return g
  }

  get tileSize(): { w: number; h: number } {
    return { w: HALF_W * 2, h: HALF_H * 2 }
  }
}
