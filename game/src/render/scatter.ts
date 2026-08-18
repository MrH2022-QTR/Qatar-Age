/**
 * Terrain scatter: rocks, scrub and small props strewn across the ground.
 *
 * The single most "procedurally generated" thing about a tiled map is that it
 * looks tiled. Terrain variants help, but the eye still finds the grid because
 * every cell is exactly one tile and the boundaries all align. Scatter breaks
 * that by placing props at fractional positions that straddle tile edges, so
 * there is visible content that does not respect the lattice.
 *
 * Age of Empires does the same thing and calls them doodads. Cheap, static, and
 * disproportionately effective.
 *
 * Placement is derived from a position hash rather than the game RNG, for two
 * reasons: the map looks identical on every load, and scatter cannot perturb
 * the simulation's random stream.
 */

import { Container, type Sprite } from 'pixi.js'
import { worldToScreen, depthOf } from '../sim/coords'
import { TerrainType, type TerrainGrid } from '../sim/grid'
import { DOODAD_ROWS, type SheetLibrary } from './sheets'

/** Roughly one prop per this many tiles. Higher is sparser. */
const DENSITY = 26

/** Deterministic hash → [0,1). No RNG, so the map is stable across loads. */
function hash01(ne: number, se: number, salt: number): number {
  let h = (ne * 73856093) ^ (se * 19349663) ^ (salt * 83492791)
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export class TerrainScatter {
  readonly container = new Container()

  private grid: TerrainGrid
  private sheets: SheetLibrary
  private placed = 0

  constructor(grid: TerrainGrid, sheets: SheetLibrary) {
    this.grid = grid
    this.sheets = sheets
    this.container.sortableChildren = true
    this.build()
  }

  get count(): number {
    return this.placed
  }

  private build(): void {
    const { width, height } = this.grid

    for (let se = 0; se < height; se++) {
      for (let ne = 0; ne < width; ne++) {
        if (hash01(ne, se, 1) > 1 / DENSITY) continue

        // Never scatter on water, rock, or anything a building has claimed —
        // props are decoration, and decoration on impassable ground reads as
        // an obstacle the player cannot interact with.
        const type = this.grid.getTerrain(ne, se) as TerrainType
        if (!this.grid.isPassable(ne, se)) continue

        const options = DOODAD_ROWS[type]
        if (!options || options.length === 0) continue

        const pick = options[Math.floor(hash01(ne, se, 2) * options.length)]!
        if (!this.sheets.has(pick.sheet)) continue

        const cols = this.sheets.shape(pick.sheet)[pick.row] ?? 1
        const col = Math.floor(hash01(ne, se, 3) * cols)

        // Sub-tile offset is the point: props that sit exactly on tile centres
        // reinforce the grid instead of hiding it.
        const offNe = 0.15 + hash01(ne, se, 4) * 0.7
        const offSe = 0.15 + hash01(ne, se, 5) * 0.7

        const size = 34 + hash01(ne, se, 6) * 26
        const spr = this.sheets.sprite(pick.sheet, pick.row, col, size)
        if (!spr) continue

        this.place(spr, ne + offNe, se + offSe)
        this.placed++
      }
    }
  }

  private place(spr: Sprite, ne: number, se: number): void {
    const p = worldToScreen({ ne, se })
    spr.position.set(p.x, p.y)
    // Share the world's depth convention so units correctly walk in front of
    // and behind props.
    spr.zIndex = depthOf({ ne, se })
    this.container.addChild(spr)
  }
}
