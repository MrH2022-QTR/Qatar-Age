import { beforeEach, describe, expect, it } from 'vitest'
import { TerrainGrid, TerrainType } from '../src/sim/grid'
import { findPath, hasLineOfSight, PathResult, smoothPath } from '../src/sim/pathfinding/astar'
import { Pathfinder } from '../src/sim/pathfinding/pathfinder'
import { validatePath } from '../src/sim/pathfinding/validate'

function openMap(size = 32): TerrainGrid {
  return new TerrainGrid(size, size, TerrainType.Sand)
}

/** Draw a wall of rock along a column, leaving an optional gap. */
function wallAt(grid: TerrainGrid, ne: number, gapAt?: number): void {
  for (let se = 0; se < grid.height; se++) {
    if (se === gapAt) continue
    grid.setTerrain(ne, se, TerrainType.Rock)
  }
}

describe('A* basics', () => {
  it('finds a straight path across open ground', () => {
    const g = openMap()
    const p = findPath(g, { ne: 0, se: 0 }, { ne: 10, se: 0 })
    expect(p.result).toBe(PathResult.Found)
    expect(p.waypoints[0]).toEqual({ ne: 0, se: 0 })
    expect(p.waypoints[p.waypoints.length - 1]).toEqual({ ne: 10, se: 0 })
  })

  it('returns a single waypoint when already at the goal', () => {
    const g = openMap()
    const p = findPath(g, { ne: 4, se: 4 }, { ne: 4, se: 4 })
    expect(p.result).toBe(PathResult.Found)
    expect(p.waypoints).toEqual([{ ne: 4, se: 4 }])
  })

  it('rejects out-of-bounds requests', () => {
    const g = openMap()
    expect(findPath(g, { ne: -1, se: 0 }, { ne: 5, se: 5 }).result).toBe(PathResult.OutOfBounds)
    expect(findPath(g, { ne: 0, se: 0 }, { ne: 999, se: 5 }).result).toBe(PathResult.OutOfBounds)
  })

  it('never routes through impassable tiles', () => {
    const g = openMap()
    wallAt(g, 10, 16)
    const p = findPath(g, { ne: 2, se: 2 }, { ne: 20, se: 2 })
    expect(p.result).toBe(PathResult.Found)
    for (const w of p.waypoints) {
      expect(g.isPassable(w.ne, w.se)).toBe(true)
    }
  })

  it('routes through the only gap in a wall', () => {
    const g = openMap()
    wallAt(g, 10, 16)
    const p = findPath(g, { ne: 2, se: 2 }, { ne: 20, se: 2 })
    expect(p.result).toBe(PathResult.Found)
    // Must pass through the gap tile.
    expect(p.waypoints.some((w) => w.ne === 10 && w.se === 16)).toBe(true)
  })
})

describe('unreachability', () => {
  it('reports unreachable when a wall fully separates start and goal', () => {
    const g = openMap()
    wallAt(g, 10) // no gap
    const p = findPath(g, { ne: 2, se: 2 }, { ne: 20, se: 2 })
    expect(p.result).toBe(PathResult.Unreachable)
  })

  it('still returns the closest reachable tile rather than nothing', () => {
    // docs/PATHFINDING_NOTES.md §7.5 — the failure mode to avoid is AoE2's
    // original behaviour of flailing and then giving up with no answer.
    const g = openMap()
    wallAt(g, 10)
    const p = findPath(g, { ne: 2, se: 2 }, { ne: 20, se: 2 })
    expect(p.waypoints.length).toBeGreaterThan(0)
    const last = p.waypoints[p.waypoints.length - 1]!
    expect(g.isPassable(last.ne, last.se)).toBe(true)
    // Should have got near the wall rather than staying put.
    expect(last.ne).toBeGreaterThan(5)
  })

  it('terminates promptly when the unit is fully enclosed', () => {
    const g = openMap()
    for (const [ne, se] of [[4, 5], [6, 5], [5, 4], [5, 6], [4, 4], [6, 6], [4, 6], [6, 4]]) {
      g.setTerrain(ne!, se!, TerrainType.Rock)
    }
    const p = findPath(g, { ne: 5, se: 5 }, { ne: 20, se: 20 })
    expect(p.result).toBe(PathResult.Unreachable)
    // The whole search should collapse almost immediately — not flood the map.
    expect(p.nodesExpanded).toBeLessThan(10)
  })
})

describe('corner cutting', () => {
  it('does not squeeze diagonally between two blocked tiles', () => {
    // Rocks at (1,0) and (0,1) form a diagonal pinch at the (0,0)->(1,1) joint.
    const g = openMap(8)
    g.setTerrain(1, 0, TerrainType.Rock)
    g.setTerrain(0, 1, TerrainType.Rock)

    const p = findPath(g, { ne: 0, se: 0 }, { ne: 1, se: 1 })
    // (0,0) and (1,1) are diagonally adjacent, but the move is illegal, so any
    // valid route must be longer than two waypoints — or not exist at all.
    if (p.result === PathResult.Found) {
      expect(p.waypoints.length).toBeGreaterThan(2)
    } else {
      expect(p.result).toBe(PathResult.Unreachable)
    }
  })

  it('applies the same rule to line-of-sight checks', () => {
    const g = openMap(8)
    g.setTerrain(1, 0, TerrainType.Rock)
    g.setTerrain(0, 1, TerrainType.Rock)
    expect(hasLineOfSight(g, { ne: 0, se: 0 }, { ne: 1, se: 1 })).toBe(false)
  })
})

describe('smoothing', () => {
  it('collapses a staircase across open ground', () => {
    const g = openMap()
    const raw = findPath(g, { ne: 0, se: 0 }, { ne: 12, se: 6 })
    const smoothed = smoothPath(g, raw.waypoints)
    expect(smoothed.length).toBeLessThan(raw.waypoints.length)
    expect(smoothed[0]).toEqual(raw.waypoints[0])
    expect(smoothed[smoothed.length - 1]).toEqual(raw.waypoints[raw.waypoints.length - 1])
  })

  it('never smooths a path through an obstruction', () => {
    const g = openMap()
    wallAt(g, 10, 16)
    const raw = findPath(g, { ne: 2, se: 2 }, { ne: 20, se: 2 })
    const smoothed = smoothPath(g, raw.waypoints)
    for (let i = 1; i < smoothed.length; i++) {
      expect(hasLineOfSight(g, smoothed[i - 1]!, smoothed[i]!)).toBe(true)
    }
  })
})

describe('self-verification', () => {
  /**
   * The invariant harness from docs/PATHFINDING_NOTES.md §5.2. The point is not
   * that these particular cases pass — it is that every path the game ever
   * produces can be checked this cheaply, which is what makes the fuzz harness
   * in src/sim/tools/fuzz-pathfinder.ts possible.
   */
  it('accepts well-formed paths', () => {
    const g = openMap()
    wallAt(g, 10, 16)
    const start = { ne: 2, se: 2 }
    const goal = { ne: 20, se: 2 }
    const p = findPath(g, start, goal)
    expect(validatePath(g, start, goal, p)).toEqual([])
  })

  it('flags a path that crosses an obstruction', () => {
    const g = openMap()
    wallAt(g, 10)
    const start = { ne: 2, se: 2 }
    const goal = { ne: 20, se: 2 }
    const bogus = {
      result: PathResult.Found,
      waypoints: [start, goal],
      nodesExpanded: 0,
      goal,
      goalRadius: 0,
    }
    const violations = validatePath(g, start, goal, bogus)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join(' ')).toMatch(/obstruction/)
  })

  it('flags a path that does not start where the unit is', () => {
    const g = openMap()
    const bogus = {
      result: PathResult.Found,
      waypoints: [{ ne: 5, se: 5 }, { ne: 6, se: 5 }],
      nodesExpanded: 0,
      goal: { ne: 6, se: 5 },
      goalRadius: 0,
    }
    const violations = validatePath(g, { ne: 0, se: 0 }, { ne: 6, se: 5 }, bogus)
    expect(violations.join(' ')).toMatch(/!= start/)
  })
})

describe('Pathfinder facade', () => {
  let grid: TerrainGrid
  let pf: Pathfinder

  beforeEach(() => {
    grid = openMap(96)
    pf = new Pathfinder(grid)
    pf.beginFrame()
  })

  it('retargets to an adjacent tile when the goal itself is blocked', () => {
    grid.setTerrain(20, 20, TerrainType.Rock)
    const p = pf.request({ start: { ne: 2, se: 2 }, goal: { ne: 20, se: 20 } })
    expect(p).not.toBeNull()
    expect(p!.result).toBe(PathResult.Found)
    const last = p!.waypoints[p!.waypoints.length - 1]!
    expect(grid.isPassable(last.ne, last.se)).toBe(true)
  })

  it('defers AI requests past the frame budget but never player requests', () => {
    pf.budgetPerFrame = 2
    const req = { start: { ne: 1, se: 1 }, goal: { ne: 40, se: 40 } }

    expect(pf.request({ ...req, priority: 'ai' })).not.toBeNull()
    expect(pf.request({ ...req, priority: 'ai' })).not.toBeNull()
    // Third AI request this frame is over budget.
    expect(pf.request({ ...req, priority: 'ai' })).toBeNull()
    // Player requests bypass it entirely.
    expect(pf.request({ ...req, priority: 'player' })).not.toBeNull()
  })

  it('resets the budget each frame', () => {
    pf.budgetPerFrame = 1
    const req = { start: { ne: 1, se: 1 }, goal: { ne: 30, se: 30 }, priority: 'ai' as const }
    expect(pf.request(req)).not.toBeNull()
    expect(pf.request(req)).toBeNull()
    pf.beginFrame()
    expect(pf.request(req)).not.toBeNull()
  })

  it('produces valid paths on a large map with the hierarchy active', () => {
    for (let se = 10; se < 80; se++) grid.setTerrain(48, se, TerrainType.Rock)
    const start = { ne: 5, se: 45 }
    const goal = { ne: 90, se: 45 }
    const p = pf.request({ start, goal })
    expect(p).not.toBeNull()
    expect(validatePath(grid, start, goal, p!)).toEqual([])
  })
})

describe('building footprints', () => {
  it('blocks pathing once stamped and clears once removed', () => {
    const g = openMap()
    const before = findPath(g, { ne: 0, se: 5 }, { ne: 10, se: 5 })
    expect(before.result).toBe(PathResult.Found)

    // Wall the map in two, via footprint stamping rather than terrain edits.
    for (let se = 0; se < g.height; se++) g.stampFootprint({ ne: 5, se }, 1, 1, true)
    expect(findPath(g, { ne: 0, se: 5 }, { ne: 10, se: 5 }).result).toBe(PathResult.Unreachable)

    for (let se = 0; se < g.height; se++) g.stampFootprint({ ne: 5, se }, 1, 1, false)
    expect(findPath(g, { ne: 0, se: 5 }, { ne: 10, se: 5 }).result).toBe(PathResult.Found)
  })
})
