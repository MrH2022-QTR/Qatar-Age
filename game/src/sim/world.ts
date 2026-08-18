/**
 * The game world: entity store, players, terrain, and spatial index.
 *
 * This is the equivalent of openage's GameState (libopenage/gamestate/game_state.h)
 * — the object that owns everything the simulation can reach. Kept deliberately
 * plain so that serialising it is close to JSON.stringify.
 */

import { World as MiniplexWorld } from 'miniplex'
import type { Entity, EntityId, PlayerId, ResourceKind } from './components'
import { type WorldPos, distanceSq } from './coords'
import { TerrainGrid } from './grid'
import { Pathfinder } from './pathfinding/pathfinder'
import { Player } from './player'
import { Rng } from './random'
import { BASE_DATA, isBuildingType } from '../data'

/**
 * Uniform-grid spatial index.
 *
 * Needed by target acquisition, drop-site lookup, box selection, and the
 * separation steering in systems/steering.ts — all of which otherwise degrade
 * to O(n²) over every entity. Rebuilt each frame: with a few thousand entities
 * that is cheaper and far simpler than incremental maintenance, and it cannot
 * drift out of sync with reality.
 */
export class SpatialIndex {
  private readonly cellSize: number
  private readonly cols: number
  private readonly rows: number
  private cells: EntityId[][] = []

  constructor(width: number, height: number, cellSize = 4) {
    this.cellSize = cellSize
    this.cols = Math.ceil(width / cellSize)
    this.rows = Math.ceil(height / cellSize)
    this.cells = Array.from({ length: this.cols * this.rows }, () => [])
  }

  clear(): void {
    for (const c of this.cells) c.length = 0
  }

  insert(id: EntityId, pos: WorldPos): void {
    const cx = Math.floor(pos.ne / this.cellSize)
    const cy = Math.floor(pos.se / this.cellSize)
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return
    this.cells[cy * this.cols + cx]!.push(id)
  }

  /** Entity ids within `radius` of `pos`. May include a few just outside it. */
  queryRadius(pos: WorldPos, radius: number, out: EntityId[] = []): EntityId[] {
    out.length = 0
    const minX = Math.max(0, Math.floor((pos.ne - radius) / this.cellSize))
    const maxX = Math.min(this.cols - 1, Math.floor((pos.ne + radius) / this.cellSize))
    const minY = Math.max(0, Math.floor((pos.se - radius) / this.cellSize))
    const maxY = Math.min(this.rows - 1, Math.floor((pos.se + radius) / this.cellSize))
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cell = this.cells[y * this.cols + x]!
        for (const id of cell) out.push(id)
      }
    }
    return out
  }
}

export class GameWorld {
  readonly ecs = new MiniplexWorld<Entity>()
  readonly terrain: TerrainGrid
  readonly pathfinder: Pathfinder
  readonly players = new Map<PlayerId, Player>()
  readonly rng: Rng
  readonly spatial: SpatialIndex

  /** Entity id → entity, for the id-not-reference discipline in components.ts. */
  private readonly byId = new Map<EntityId, Entity>()
  private nextId = 1

  constructor(terrain: TerrainGrid, seed = 12345) {
    this.terrain = terrain
    this.pathfinder = new Pathfinder(terrain)
    this.rng = new Rng(seed)
    this.spatial = new SpatialIndex(terrain.width, terrain.height)
  }

  addPlayer(id: PlayerId, civId: string, color: number): Player {
    const p = new Player(id, civId, color)
    this.players.set(id, p)
    return p
  }

  player(id: PlayerId): Player | undefined {
    return this.players.get(id)
  }

  get(id: EntityId): Entity | undefined {
    return this.byId.get(id)
  }

  /** Add a raw entity. Prefer spawnUnit / spawnBuilding. */
  add(partial: Omit<Entity, 'id'>): Entity {
    const e = { ...partial, id: this.nextId++ } as Entity
    this.ecs.add(e)
    this.byId.set(e.id, e)
    return e
  }

  remove(e: Entity): void {
    // Buildings must un-stamp their footprint or the map keeps a permanent hole.
    if (e.building) {
      this.terrain.stampFootprint(
        { ne: e.building.originNe, se: e.building.originSe },
        e.building.widthNe,
        e.building.heightSe,
        false,
      )
    }
    if (e.owner !== undefined && e.typeId) {
      const p = this.players.get(e.owner)
      if (p) {
        if (isBuildingType(e.typeId)) {
          const def = p.data.building(e.typeId)
          p.popCap -= def.popProvided ?? 0
        } else {
          p.popUsed -= p.data.unit(e.typeId).pop
        }
      }
    }
    this.byId.delete(e.id)
    this.ecs.remove(e)
  }

  spawnUnit(typeId: string, pos: WorldPos, owner: PlayerId): Entity {
    const player = this.players.get(owner)
    if (!player) throw new Error(`spawnUnit: unknown player ${owner}`)
    const def = player.data.unit(typeId)

    player.popUsed += def.pop

    return this.add({
      typeId,
      owner,
      position: { ...pos },
      facing: 0,
      movement: {
        speed: def.speed,
        turnSpeed: def.turnSpeed ?? Infinity,
        path: [],
        repathTo: null,
      },
      collider: { radius: def.radius },
      selectable: { radius: Math.max(def.radius, 0.4) },
      health: { current: def.hp, max: def.hp },
      state: { kind: 'idle' },
      ...(def.carryCapacity
        ? { carrying: { kind: null, amount: 0, capacity: def.carryCapacity } }
        : {}),
      renderDirty: true,
    })
  }

  spawnBuilding(typeId: string, originNe: number, originSe: number, owner: PlayerId, progress = 1): Entity {
    const player = this.players.get(owner)
    if (!player) throw new Error(`spawnBuilding: unknown player ${owner}`)
    const def = player.data.building(typeId)

    // Stamp the footprint into the cost grid. docs/SYSTEMS.md §6 is emphatic
    // that this must happen from the start, not be retrofitted.
    this.terrain.stampFootprint({ ne: originNe, se: originSe }, def.widthNe, def.heightSe, true)

    if (progress >= 1) player.popCap += def.popProvided ?? 0

    return this.add({
      typeId,
      owner,
      position: { ne: originNe + def.widthNe / 2, se: originSe + def.heightSe / 2 },
      facing: 0,
      health: { current: progress >= 1 ? def.hp : Math.max(1, def.hp * progress), max: def.hp },
      selectable: { radius: Math.max(def.widthNe, def.heightSe) / 2 },
      building: {
        widthNe: def.widthNe,
        heightSe: def.heightSe,
        originNe,
        originSe,
        progress,
      },
      renderDirty: true,
    })
  }

  spawnResourceSpot(kind: ResourceKind, ne: number, se: number, amount: number): Entity {
    this.terrain.setBlocked(ne, se, true)
    return this.add({
      position: { ne: ne + 0.5, se: se + 0.5 },
      resourceSpot: { kind, remaining: amount },
      selectable: { radius: 0.5 },
      renderDirty: true,
    })
  }

  /** Rebuild the spatial index. Called once per frame before systems run. */
  reindex(): void {
    this.spatial.clear()
    for (const e of this.ecs.with('position')) {
      this.spatial.insert(e.id, e.position)
    }
  }

  /** Nearest entity matching `pred` within `radius`. */
  nearest(
    pos: WorldPos,
    radius: number,
    pred: (e: Entity) => boolean,
  ): Entity | null {
    const ids = this.spatial.queryRadius(pos, radius)
    let best: Entity | null = null
    let bestD = radius * radius
    for (const id of ids) {
      const e = this.byId.get(id)
      if (!e?.position || !pred(e)) continue
      const d = distanceSq(pos, e.position)
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  /** Population cap including the free headroom every player starts with. */
  recomputePopCaps(): void {
    for (const p of this.players.values()) p.popCap = 0
    for (const e of this.ecs.with('building', 'owner', 'typeId')) {
      if (e.building.progress < 1) continue
      const p = this.players.get(e.owner)
      if (!p) continue
      p.popCap += p.data.building(e.typeId).popProvided ?? 0
    }
  }

  get entityCount(): number {
    return this.byId.size
  }

  allEntities(): Iterable<Entity> {
    return this.byId.values()
  }
}

export { BASE_DATA }
