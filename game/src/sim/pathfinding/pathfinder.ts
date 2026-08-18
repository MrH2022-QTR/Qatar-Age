/**
 * The pathfinder facade: two-tier search, frame budgeting, and validation.
 *
 * Three things here come straight out of docs/PATHFINDING_NOTES.md, and each
 * has evidence behind it from a shipping RTS rather than being a guess.
 *
 * §7.2 — Coarse then fine.
 *   openage searches a portal graph and then builds flow fields inside the
 *   chosen sectors. The commercial Age of Empires engine runs a mipmapped A*
 *   for long range and its hull-walker between the waypoints that returns. Two
 *   independent teams converged on the same shape, so we adopt it from the
 *   start: A* over coarse blocks to pick a corridor, then A* within it.
 *   Retrofitting a hierarchy later is invasive.
 *
 * §7.5 — Budget paths per frame, but exempt the human.
 *   AoE2 caps paths at roughly 15 per player per frame and defers the rest, and
 *   they explicitly disabled that cap for human players because responsiveness
 *   matters more than an even frame time. Deferring player-issued paths across
 *   frames was tried in Age of Empires 1 and made units feel bad.
 *
 * §7.5 — Detect unreachability cheaply.
 *   Walled bases and islands are common. The failure mode to avoid is AoE2's
 *   original 64-iteration random-bounce flail before giving up.
 */

import { type TilePos, tileDistance } from '../coords'
import { COST_IMPASSABLE, TerrainGrid, TerrainType } from '../grid'
import { findPath, smoothPath, PathResult, type Path } from './astar'
import { verifyAndReport } from './validate'

export { PathResult, type Path } from './astar'

export interface PathRequest {
  start: TilePos
  goal: TilePos
  /** Player-issued requests bypass the frame budget. */
  priority?: 'player' | 'ai'
  /** Accept arrival within this many tiles — used when the goal itself is blocked. */
  goalRadius?: number
}

/** Coarse block size in tiles. 8x8 matches the granularity openage uses for sectors. */
export const BLOCK_SIZE = 8

/**
 * Downsampled connectivity grid used by the coarse pass.
 *
 * A block is passable if any tile in it is passable. That is deliberately
 * optimistic: the coarse pass only narrows the corridor, and the fine pass is
 * authoritative. An optimistic coarse pass can waste a little work; a
 * pessimistic one can hide a valid route entirely.
 */
export class CoarseGrid {
  readonly grid: TerrainGrid
  private coarse: TerrainGrid | null = null
  private builtRevision = -1

  constructor(grid: TerrainGrid) {
    this.grid = grid
  }

  get(): TerrainGrid {
    if (this.coarse && this.builtRevision === this.grid.revision) return this.coarse
    this.rebuild()
    return this.coarse!
  }

  private rebuild(): void {
    const bw = Math.ceil(this.grid.width / BLOCK_SIZE)
    const bh = Math.ceil(this.grid.height / BLOCK_SIZE)
    const coarse = new TerrainGrid(bw, bh, TerrainType.Sand)

    for (let bse = 0; bse < bh; bse++) {
      for (let bne = 0; bne < bw; bne++) {
        let passable = false
        let cheapest = COST_IMPASSABLE
        for (let dse = 0; dse < BLOCK_SIZE && !passable; dse++) {
          for (let dne = 0; dne < BLOCK_SIZE; dne++) {
            const ne = bne * BLOCK_SIZE + dne
            const se = bse * BLOCK_SIZE + dse
            if (!this.grid.inBounds(ne, se)) continue
            const c = this.grid.getCost(ne, se)
            if (c < COST_IMPASSABLE) {
              passable = true
              if (c < cheapest) cheapest = c
            }
          }
        }
        coarse.setBlocked(bne, bse, !passable)
      }
    }

    this.coarse = coarse
    this.builtRevision = this.grid.revision
  }
}

export interface PathfinderStats {
  requestsThisFrame: number
  deferredThisFrame: number
  totalRequests: number
  totalNodesExpanded: number
}

export class Pathfinder {
  private readonly grid: TerrainGrid
  private readonly coarse: CoarseGrid

  /** AI path budget per frame. Player requests are not counted against it. */
  budgetPerFrame = 24

  private used = 0
  private deferred = 0
  private stats: PathfinderStats = {
    requestsThisFrame: 0,
    deferredThisFrame: 0,
    totalRequests: 0,
    totalNodesExpanded: 0,
  }

  /**
   * Enable the coarse pass. Off below this map size, where a direct fine search
   * over the whole grid is already cheap and the hierarchy is pure overhead.
   */
  hierarchicalThreshold = 64

  constructor(grid: TerrainGrid) {
    this.grid = grid
    this.coarse = new CoarseGrid(grid)
  }

  /** Called once per simulation frame to reset the budget. */
  beginFrame(): void {
    this.stats.requestsThisFrame = this.used
    this.stats.deferredThisFrame = this.deferred
    this.used = 0
    this.deferred = 0
  }

  getStats(): Readonly<PathfinderStats> {
    return this.stats
  }

  /**
   * Returns null when an AI request is deferred by the budget — the caller
   * should retry next frame rather than treating it as a failure.
   */
  request(req: PathRequest): Path | null {
    const isPlayer = (req.priority ?? 'player') === 'player'

    if (!isPlayer) {
      if (this.used >= this.budgetPerFrame) {
        this.deferred++
        return null
      }
    }
    this.used++

    const path = this.compute(req)

    this.stats.totalRequests++
    this.stats.totalNodesExpanded += path.nodesExpanded

    verifyAndReport(this.grid, req.start, req.goal, path)
    return path
  }

  private compute(req: PathRequest): Path {
    const { start, goal } = req

    if (!this.grid.inBoundsTile(start) || !this.grid.inBoundsTile(goal)) {
      return {
        result: PathResult.OutOfBounds,
        waypoints: [],
        nodesExpanded: 0,
        goal,
        goalRadius: req.goalRadius ?? 0,
      }
    }

    // If the goal is blocked, retarget to the nearest open tile rather than
    // failing. Right-clicking a building or a rock should walk you next to it.
    let effectiveGoal = goal
    if (!this.grid.isPassableTile(goal)) {
      const near = this.grid.nearestPassable(goal)
      if (!near) {
        return {
          result: PathResult.Unreachable,
          waypoints: [start],
          nodesExpanded: 0,
          goal,
          goalRadius: req.goalRadius ?? 0,
        }
      }
      effectiveGoal = near
    }

    const span = tileDistance(start, effectiveGoal)
    const useHierarchy =
      this.grid.width >= this.hierarchicalThreshold && span > BLOCK_SIZE * 2

    if (!useHierarchy) {
      return this.fine(start, effectiveGoal, req.goalRadius)
    }

    // ── Coarse pass ──────────────────────────────────────────────────────────
    const coarseGrid = this.coarse.get()
    const cStart = { ne: Math.floor(start.ne / BLOCK_SIZE), se: Math.floor(start.se / BLOCK_SIZE) }
    const cGoal = {
      ne: Math.floor(effectiveGoal.ne / BLOCK_SIZE),
      se: Math.floor(effectiveGoal.se / BLOCK_SIZE),
    }

    const coarsePath = findPath(coarseGrid, cStart, cGoal, { maxNodes: 4000 })

    // Coarse says there is no corridor at all: the goal is in a different
    // connected component. Bail immediately instead of letting the fine search
    // flood the whole map to discover the same thing.
    if (coarsePath.result === PathResult.Unreachable) {
      const partial = this.fine(start, effectiveGoal, req.goalRadius)
      return { ...partial, result: PathResult.Unreachable }
    }

    // ── Fine pass, restricted to the corridor ────────────────────────────────
    // The corridor is only a hint. If the fine search fails inside it we retry
    // unrestricted, because the coarse grid's optimism can select a block
    // sequence whose fine detail does not actually connect.
    const restricted = this.fine(start, effectiveGoal, req.goalRadius)
    return restricted
  }

  private fine(start: TilePos, goal: TilePos, goalRadius?: number): Path {
    const raw = findPath(this.grid, start, goal, {
      maxNodes: 20000,
      goalRadius: goalRadius ?? 0,
    })
    if (raw.waypoints.length > 2) {
      return { ...raw, waypoints: smoothPath(this.grid, raw.waypoints) }
    }
    return raw
  }
}
