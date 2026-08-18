/**
 * Path self-verification.
 *
 * This is the idea from docs/PATHFINDING_NOTES.md §5.2 that I most wanted to
 * steal. Faced with a 25-year-old bug where units walked through walls, the
 * Age of Empires engineering director's breakthrough was not a cleverer
 * algorithm — it was giving the algorithm a cheap invariant it could check
 * against its own output, so that broken paths announced themselves instead of
 * being discovered by players months later.
 *
 * His phrase for it was a "self-verifiable algorithm". On failure the whole
 * request was dumped with everything needed to reproduce it, loaded into a small
 * standalone debugger, and fixed. Running the game with eight AI players at
 * maximum speed then generated millions of paths and harvested roughly 100
 * regression cases over a few months. His assessment of the harness:
 *
 *     "I would not have known where to even start if I did not have this system."
 *
 * We can do this more cheaply than a native codebase can, because src/sim is
 * headless by construction — the fuzz harness is just a Node script
 * (tools/fuzz-pathfinder.ts).
 *
 * Validation is off in production. Turn it on in dev, in tests, and in the
 * fuzzer.
 */

import { type TilePos, tileDistance } from '../coords'
import { type TerrainGrid } from '../grid'
import { hasLineOfSight, PathResult, type Path } from './astar'

export interface PathRequestSnapshot {
  start: TilePos
  goal: TilePos
  gridWidth: number
  gridHeight: number
  /** Full terrain state, so a failure reproduces exactly. */
  terrain: number[]
  path: TilePos[]
  result: string
  violations: string[]
}

export type PathFailureHandler = (snapshot: PathRequestSnapshot) => void

let validationEnabled = false
let failureHandler: PathFailureHandler | null = null
const collected: PathRequestSnapshot[] = []

export function enablePathValidation(handler?: PathFailureHandler): void {
  validationEnabled = true
  failureHandler = handler ?? null
}

export function disablePathValidation(): void {
  validationEnabled = false
  failureHandler = null
}

export function isPathValidationEnabled(): boolean {
  return validationEnabled
}

export function collectedFailures(): readonly PathRequestSnapshot[] {
  return collected
}

export function clearCollectedFailures(): void {
  collected.length = 0
}

/**
 * The invariants. Each is cheap enough to run on every path in dev.
 *
 * Returns the list of violations; empty means the path is sound.
 */
export function validatePath(
  grid: TerrainGrid,
  start: TilePos,
  goal: TilePos,
  path: Path,
): string[] {
  const v: string[] = []
  const wp = path.waypoints

  if (path.result === PathResult.OutOfBounds) {
    // Nothing to check; the request itself was rejected.
    return v
  }

  if (wp.length === 0) {
    if (path.result === PathResult.Found) v.push('result=found but no waypoints')
    return v
  }

  // 1. Endpoints. A found path must start where the unit is and end at the goal.
  const first = wp[0]!
  if (first.ne !== start.ne || first.se !== start.se) {
    v.push(`first waypoint (${first.ne},${first.se}) != start (${start.ne},${start.se})`)
  }

  // Check against the goal the search actually aimed at, not the one the caller
  // asked for. They differ legitimately when the requested tile is blocked and
  // the pathfinder retargets — see the `goal` field on Path.
  const last = wp[wp.length - 1]!
  if (path.result === PathResult.Found) {
    const reached = tileDistance(last, path.goal)
    if (reached > path.goalRadius) {
      v.push(
        `result=found but last waypoint (${last.ne},${last.se}) is ${reached} tiles from ` +
          `the targeted goal (${path.goal.ne},${path.goal.se}), tolerance ${path.goalRadius}`,
      )
    }
  }

  // 2. Every waypoint is inside the map and on passable ground.
  for (let i = 0; i < wp.length; i++) {
    const t = wp[i]!
    if (!grid.inBoundsTile(t)) {
      v.push(`waypoint ${i} (${t.ne},${t.se}) out of bounds`)
      continue
    }
    if (!grid.isPassableTile(t)) {
      v.push(`waypoint ${i} (${t.ne},${t.se}) is impassable`)
    }
  }

  // 3. Consecutive waypoints must actually be traversable between each other.
  //    After smoothing they need not be adjacent, but they must be mutually
  //    visible — this is the check that catches a smoothing pass cutting a
  //    corner through a building.
  for (let i = 1; i < wp.length; i++) {
    const a = wp[i - 1]!
    const b = wp[i]!
    if (!grid.inBoundsTile(a) || !grid.inBoundsTile(b)) continue
    if (tileDistance(a, b) > 1 && !hasLineOfSight(grid, a, b)) {
      v.push(`segment ${i - 1}->${i} (${a.ne},${a.se})->(${b.ne},${b.se}) crosses an obstruction`)
    }
  }

  // 4. No repeated tiles. A loop means the search or the smoother is broken.
  const seen = new Set<number>()
  for (const t of wp) {
    const key = t.ne * 65536 + t.se
    if (seen.has(key)) {
      v.push(`path revisits tile (${t.ne},${t.se})`)
      break
    }
    seen.add(key)
  }

  return v
}

/**
 * Validate, and on failure capture a complete reproduction snapshot.
 * Called from the pathfinder when validation is on.
 */
export function verifyAndReport(
  grid: TerrainGrid,
  start: TilePos,
  goal: TilePos,
  path: Path,
): void {
  if (!validationEnabled) return

  const violations = validatePath(grid, start, goal, path)
  if (violations.length === 0) return

  const snapshot: PathRequestSnapshot = {
    start,
    goal,
    gridWidth: grid.width,
    gridHeight: grid.height,
    terrain: Array.from(grid.terrain),
    path: path.waypoints,
    result: path.result,
    violations,
  }

  collected.push(snapshot)
  if (failureHandler) failureHandler(snapshot)
}
