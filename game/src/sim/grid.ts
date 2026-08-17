/**
 * Terrain and the movement cost grid.
 *
 * The cost encoding is taken verbatim from openage
 * (libopenage/pathfinding/definitions.h), because it is well chosen and there
 * is no reason to invent another:
 *
 *      0        uninitialised — never valid during pathing
 *      1..254   passable, higher is more expensive
 *      255      impassable
 *
 * Storage is a flat Uint8Array rather than an array of objects. That is not
 * premature optimisation: pathfinding touches this grid tens of thousands of
 * times per second, and typed arrays are where JavaScript's performance
 * actually lives.
 *
 * Terrain type and movement cost are kept in *separate* arrays. openage does
 * the same thing and is explicit about why (doc/code/pathfinding/README.md):
 * pathfinding is deliberately decoupled from terrain, so cost can be modified
 * by things that are not terrain at all — most importantly building footprints,
 * which stamp cost into this grid when construction completes.
 */

import { type TilePos } from './coords'

export const COST_UNINITIALIZED = 0
export const COST_MIN = 1
export const COST_MAX = 254
export const COST_IMPASSABLE = 255

export enum TerrainType {
  Sand = 0,
  Desert = 1,
  Gravel = 2,
  Grass = 3,
  ShallowWater = 4,
  DeepWater = 5,
  Rock = 6,
}

export interface TerrainDef {
  readonly name: string
  readonly cost: number
  /** Colour used until real tile art exists. */
  readonly debugColor: number
}

/**
 * Terrain palette, themed for the Qatari peninsula: coastal sabkha and sand
 * flats, inland desert and gravel plain, sparse grass at oases, and the
 * shallow-then-deep Gulf water that pearling routes cross.
 */
export const TERRAIN: Record<TerrainType, TerrainDef> = {
  [TerrainType.Sand]: { name: 'sand', cost: 1, debugColor: 0xe8d5a3 },
  [TerrainType.Desert]: { name: 'desert', cost: 2, debugColor: 0xd9b877 },
  [TerrainType.Gravel]: { name: 'gravel', cost: 2, debugColor: 0xbfa980 },
  [TerrainType.Grass]: { name: 'grass', cost: 1, debugColor: 0x8faa5a },
  [TerrainType.ShallowWater]: { name: 'shallow_water', cost: COST_IMPASSABLE, debugColor: 0x6fb6c9 },
  [TerrainType.DeepWater]: { name: 'deep_water', cost: COST_IMPASSABLE, debugColor: 0x35708f },
  [TerrainType.Rock]: { name: 'rock', cost: COST_IMPASSABLE, debugColor: 0x8a8375 },
}

export class TerrainGrid {
  readonly width: number
  readonly height: number

  /** Terrain type per tile. */
  readonly terrain: Uint8Array

  /** Movement cost per tile, derived from terrain then modified by structures. */
  readonly cost: Uint8Array

  /**
   * Cost contributed by static obstructions (buildings, rocks placed at
   * runtime), kept separate so terrain changes and building changes do not
   * clobber each other.
   */
  private readonly blocked: Uint8Array

  /** Bumped whenever cost changes, so path caches can cheaply detect staleness. */
  private _revision = 0

  constructor(width: number, height: number, fill: TerrainType = TerrainType.Sand) {
    this.width = width
    this.height = height
    const n = width * height
    this.terrain = new Uint8Array(n).fill(fill)
    this.cost = new Uint8Array(n).fill(TERRAIN[fill].cost)
    this.blocked = new Uint8Array(n)
  }

  get revision(): number {
    return this._revision
  }

  index(ne: number, se: number): number {
    return se * this.width + ne
  }

  inBounds(ne: number, se: number): boolean {
    return ne >= 0 && se >= 0 && ne < this.width && se < this.height
  }

  inBoundsTile(t: TilePos): boolean {
    return this.inBounds(t.ne, t.se)
  }

  getTerrain(ne: number, se: number): TerrainType {
    if (!this.inBounds(ne, se)) return TerrainType.DeepWater
    return this.terrain[this.index(ne, se)] as TerrainType
  }

  setTerrain(ne: number, se: number, type: TerrainType): void {
    if (!this.inBounds(ne, se)) return
    const i = this.index(ne, se)
    this.terrain[i] = type
    this.recomputeCost(i, type)
  }

  /** Cost of entering a tile. Out of bounds reads as impassable. */
  getCost(ne: number, se: number): number {
    if (!this.inBounds(ne, se)) return COST_IMPASSABLE
    return this.cost[this.index(ne, se)]!
  }

  isPassable(ne: number, se: number): boolean {
    return this.getCost(ne, se) < COST_IMPASSABLE
  }

  isPassableTile(t: TilePos): boolean {
    return this.isPassable(t.ne, t.se)
  }

  /**
   * Stamp or clear a static obstruction footprint.
   *
   * docs/SYSTEMS.md §6 flags this as the one piece of building/pathfinding
   * coupling that must exist from the start. Leave it until later and units
   * walk through buildings, and by then the fix also has to touch path caching.
   */
  setBlocked(ne: number, se: number, blocked: boolean): void {
    if (!this.inBounds(ne, se)) return
    const i = this.index(ne, se)
    const v = blocked ? 1 : 0
    if (this.blocked[i] === v) return
    this.blocked[i] = v
    this.recomputeCost(i, this.terrain[i] as TerrainType)
  }

  stampFootprint(origin: TilePos, wNe: number, hSe: number, blocked: boolean): void {
    for (let dse = 0; dse < hSe; dse++) {
      for (let dne = 0; dne < wNe; dne++) {
        this.setBlocked(origin.ne + dne, origin.se + dse, blocked)
      }
    }
  }

  private recomputeCost(i: number, type: TerrainType): void {
    const base = TERRAIN[type]?.cost ?? COST_IMPASSABLE
    this.cost[i] = this.blocked[i] ? COST_IMPASSABLE : base
    this._revision++
  }

  /** Nearest passable tile to `from`, searched in expanding rings. */
  nearestPassable(from: TilePos, maxRadius = 32): TilePos | null {
    if (this.isPassableTile(from)) return from
    for (let r = 1; r <= maxRadius; r++) {
      for (let dne = -r; dne <= r; dne++) {
        for (let dse = -r; dse <= r; dse++) {
          // Ring only, not the filled square.
          if (Math.abs(dne) !== r && Math.abs(dse) !== r) continue
          const ne = from.ne + dne
          const se = from.se + dse
          if (this.isPassable(ne, se)) return { ne, se }
        }
      }
    }
    return null
  }

  /** Serialisable form. Plain data, per the save/load discipline in Phase 0. */
  toJSON(): { width: number; height: number; terrain: number[] } {
    return { width: this.width, height: this.height, terrain: Array.from(this.terrain) }
  }

  static fromJSON(data: { width: number; height: number; terrain: number[] }): TerrainGrid {
    const g = new TerrainGrid(data.width, data.height)
    for (let i = 0; i < data.terrain.length; i++) {
      g.terrain[i] = data.terrain[i]!
      g.cost[i] = TERRAIN[data.terrain[i] as TerrainType]?.cost ?? COST_IMPASSABLE
    }
    return g
  }
}
