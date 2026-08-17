/**
 * Grid A* — the fine-grained pathfinder.
 *
 * docs/PORT_PLAN.md Phase 3 chooses A* over openage's flow fields deliberately.
 * Flow fields (libopenage/pathfinding/, 7,695 lines) are the right answer when
 * 100+ units share a destination, because the expensive field is computed once
 * and reused. That is a late problem. A* over a few-hundred-square grid runs in
 * well under a millisecond, and openage itself kept A* around for years
 * (libopenage/pathfinding/legacy/a_star.cpp) while flow fields were built.
 *
 * When flow fields do become necessary, the seam is `findPath` — swap the
 * implementation, keep the signature.
 *
 * Notes on the specifics:
 *
 *  - 8-way movement with an octile heuristic. The heuristic is admissible
 *    (never overestimates), so paths are optimal.
 *  - Diagonal moves cost sqrt(2), and are forbidden when they would cut a
 *    corner between two blocked tiles. Without that check units clip through
 *    building corners, which is the cheap version of the bug that took the
 *    real Age of Empires 25 years to fix.
 *  - Unreachable targets are detected by exhausting the open set rather than by
 *    an iteration cap, and the closest reached node is returned instead. See
 *    docs/PATHFINDING_NOTES.md §7.5: AoE2's original short-range pathfinder
 *    flailed for up to 64 random-bounce iterations and then gave up, which is
 *    the canonical example of getting this wrong.
 */

import { type TilePos } from '../coords'
import { COST_IMPASSABLE, type TerrainGrid } from '../grid'
import { BinaryHeap } from './heap'

export enum PathResult {
  Found = 'found',
  /** No route exists. `waypoints` ends at the reachable tile closest to the goal. */
  Unreachable = 'unreachable',
  /** Start or goal outside the map. */
  OutOfBounds = 'out_of_bounds',
  /** Search hit its node budget. Partial path returned. */
  Exhausted = 'exhausted',
}

export interface Path {
  result: PathResult
  waypoints: TilePos[]
  /** Nodes expanded. Used by the profiler and the fuzz harness. */
  nodesExpanded: number
  /**
   * The tile the search actually aimed at.
   *
   * This is NOT always the tile the caller asked for. When the requested goal
   * is blocked — right-clicking a building, a rock, or another unit's tile —
   * the pathfinder retargets to the nearest open tile. Callers need to know
   * where the unit will really end up, and the validator needs it to avoid
   * reporting a correct path as broken.
   *
   * Added after the fuzz harness flagged 4402 spurious "last waypoint != goal"
   * violations that were entirely this missing piece of contract.
   */
  goal: TilePos
  /** Arrival tolerance in tiles; the path may legitimately stop this far short. */
  goalRadius: number
}

export interface AStarOptions {
  /** Hard ceiling on expanded nodes, so one pathological request cannot stall a frame. */
  maxNodes?: number
  /**
   * Treat the goal as reached within this many tiles. Used when the target
   * itself is blocked — attacking a building, or walking to an occupied tile.
   */
  goalRadius?: number
}

const SQRT2 = Math.SQRT2

// 8-way neighbours: 4 cardinal first so ties prefer straight lines.
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
]

/**
 * Reusable search scratch space.
 *
 * A* allocating three big arrays per call would dominate its own cost when
 * hundreds of units path in a frame, so buffers are retained and invalidated
 * with a generation counter instead of being cleared.
 */
class SearchBuffers {
  gScore: Float64Array
  cameFrom: Int32Array
  visitGen: Int32Array
  closed: Uint8Array
  generation = 0
  heap = new BinaryHeap()

  constructor(size: number) {
    this.gScore = new Float64Array(size)
    this.cameFrom = new Int32Array(size)
    this.visitGen = new Int32Array(size)
    this.closed = new Uint8Array(size)
  }

  begin(): number {
    this.generation++
    this.heap.clear()
    return this.generation
  }
}

const bufferCache = new WeakMap<TerrainGrid, SearchBuffers>()

function buffersFor(grid: TerrainGrid): SearchBuffers {
  let b = bufferCache.get(grid)
  if (!b) {
    b = new SearchBuffers(grid.width * grid.height)
    bufferCache.set(grid, b)
  }
  return b
}

/** Octile distance — exact 8-way movement cost across open ground. */
export function octileHeuristic(ane: number, ase: number, bne: number, bse: number): number {
  const dne = Math.abs(ane - bne)
  const dse = Math.abs(ase - bse)
  return dne < dse ? dne * SQRT2 + (dse - dne) : dse * SQRT2 + (dne - dse)
}

export function findPath(
  grid: TerrainGrid,
  start: TilePos,
  goal: TilePos,
  options: AStarOptions = {},
): Path {
  const maxNodes = options.maxNodes ?? 20000
  const goalRadius = options.goalRadius ?? 0

  if (!grid.inBoundsTile(start) || !grid.inBoundsTile(goal)) {
    return { result: PathResult.OutOfBounds, waypoints: [], nodesExpanded: 0, goal, goalRadius }
  }

  const startIdx = grid.index(start.ne, start.se)
  const goalIdx = grid.index(goal.ne, goal.se)

  if (startIdx === goalIdx) {
    return { result: PathResult.Found, waypoints: [start], nodesExpanded: 0, goal, goalRadius }
  }

  const b = buffersFor(grid)
  const gen = b.begin()
  const { gScore, cameFrom, visitGen, closed, heap } = b
  const width = grid.width

  gScore[startIdx] = 0
  cameFrom[startIdx] = -1
  visitGen[startIdx] = gen
  closed[startIdx] = 0
  heap.push(startIdx, octileHeuristic(start.ne, start.se, goal.ne, goal.se))

  let expanded = 0
  // Track the closest node reached, so an unreachable goal still yields a
  // useful "get as near as you can" path rather than nothing.
  let bestIdx = startIdx
  let bestH = octileHeuristic(start.ne, start.se, goal.ne, goal.se)

  while (!heap.isEmpty()) {
    const current = heap.pop()
    if (closed[current] === 1 && visitGen[current] === gen) continue
    closed[current] = 1
    visitGen[current] = gen
    expanded++

    const cne = current % width
    const cse = (current - cne) / width

    const h = octileHeuristic(cne, cse, goal.ne, goal.se)
    if (h < bestH) {
      bestH = h
      bestIdx = current
    }

    if (current === goalIdx || h <= goalRadius) {
      return {
        result: PathResult.Found,
        waypoints: reconstruct(cameFrom, current, width),
        nodesExpanded: expanded,
        goal,
        goalRadius,
      }
    }

    if (expanded >= maxNodes) {
      return {
        result: PathResult.Exhausted,
        waypoints: reconstruct(cameFrom, bestIdx, width),
        nodesExpanded: expanded,
        goal,
        goalRadius,
      }
    }

    for (const [dne, dse, stepCost] of NEIGHBORS) {
      const nne = cne + dne
      const nse = cse + dse
      if (!grid.inBounds(nne, nse)) continue

      const tileCost = grid.getCost(nne, nse)
      if (tileCost >= COST_IMPASSABLE) continue

      // Corner-cutting guard: a diagonal is only legal if both orthogonal
      // neighbours it squeezes between are passable. Skipping this lets units
      // slide through the corner joint of two buildings.
      if (dne !== 0 && dse !== 0) {
        if (!grid.isPassable(cne + dne, cse) || !grid.isPassable(cne, cse + dse)) continue
      }

      const nIdx = nne + nse * width
      if (visitGen[nIdx] === gen && closed[nIdx] === 1) continue

      // Terrain cost scales the step. COST_MIN (1) is free ground.
      const tentative = gScore[current]! + stepCost * tileCost

      const seen = visitGen[nIdx] === gen
      if (seen && tentative >= gScore[nIdx]!) continue

      gScore[nIdx] = tentative
      cameFrom[nIdx] = current
      visitGen[nIdx] = gen
      if (!seen) closed[nIdx] = 0
      heap.push(nIdx, tentative + octileHeuristic(nne, nse, goal.ne, goal.se))
    }
  }

  // Open set exhausted without reaching the goal: genuinely unreachable.
  return {
    result: PathResult.Unreachable,
    waypoints: reconstruct(cameFrom, bestIdx, width),
    nodesExpanded: expanded,
    goal,
    goalRadius,
  }
}

function reconstruct(cameFrom: Int32Array, end: number, width: number): TilePos[] {
  const out: TilePos[] = []
  let cur = end
  while (cur !== -1) {
    const ne = cur % width
    out.push({ ne, se: (cur - ne) / width })
    cur = cameFrom[cur]!
  }
  out.reverse()
  return out
}

/**
 * String-pulling: drop intermediate waypoints that a straight line already
 * clears. Both openage and the shipping Age of Empires pathfinder finish with a
 * brute-force smoothing pass like this, and it is what stops units walking a
 * visible staircase across open ground.
 */
export function smoothPath(grid: TerrainGrid, waypoints: TilePos[]): TilePos[] {
  if (waypoints.length <= 2) return waypoints

  const out: TilePos[] = [waypoints[0]!]
  let anchor = 0

  for (let probe = 2; probe < waypoints.length; probe++) {
    if (!hasLineOfSight(grid, waypoints[anchor]!, waypoints[probe]!)) {
      // The previous waypoint was the last one we could see; keep it.
      out.push(waypoints[probe - 1]!)
      anchor = probe - 1
    }
  }
  out.push(waypoints[waypoints.length - 1]!)
  return out
}

/**
 * Supercover line walk between tile centres, rejecting diagonal squeezes.
 *
 * "Supercover" means every tile the segment touches is tested, not just those a
 * Bresenham line would light up — otherwise a path can be smoothed through a
 * wall it merely grazes.
 */
export function hasLineOfSight(grid: TerrainGrid, a: TilePos, b: TilePos): boolean {
  let x = a.ne
  let y = a.se
  const dx = Math.abs(b.ne - a.ne)
  const dy = Math.abs(b.se - a.se)
  const sx = a.ne < b.ne ? 1 : -1
  const sy = a.se < b.se ? 1 : -1
  let err = dx - dy

  for (;;) {
    if (!grid.isPassable(x, y)) return false
    if (x === b.ne && y === b.se) return true

    const e2 = 2 * err
    if (e2 > -dy && e2 < dx) {
      // Moving diagonally: both orthogonal neighbours must be clear.
      if (!grid.isPassable(x + sx, y) || !grid.isPassable(x, y + sy)) return false
      x += sx
      y += sy
      err += dx - dy
    } else if (e2 > -dy) {
      x += sx
      err -= dy
    } else {
      y += sy
      err += dx
    }
  }
}
