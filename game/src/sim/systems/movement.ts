/**
 * Movement: consume the path, turn, advance.
 *
 * ── How this differs from openage, and why ───────────────────────────────────
 *
 * openage computes the entire journey at command time and writes it into a
 * position *curve* as keyframes (libopenage/gamestate/system/move.cpp:95-187).
 * By the time move_default() returns, a unit's whole multi-second walk already
 * exists and nothing touches it again. That is elegant, and it is the right
 * design for their goal: keyframes can be inserted at any past time, which is
 * how they intend to survive network latency without lockstep.
 *
 * We advance a plain path array each frame instead. docs/SYSTEMS.md §4 works
 * through the trade — the keyframe approach wins on network sync, which we do
 * not have, and loses on interruption handling and debuggability, which we care
 * about now. A new order simply replaces `path`.
 *
 * ── What is worth stealing, and is stolen ────────────────────────────────────
 *
 * The turn-rate model. openage inserts an explicit pause before each leg while
 * the unit rotates (move.cpp:140-160), costing angle_diff / turn_speed seconds.
 * It is a handful of lines and it is a large part of why Age of Empires units
 * feel weighty rather than gliding. Implemented below as: if we are not facing
 * roughly the right way, rotate and do not translate this frame.
 */

import { angleTo, distance, type WorldPos } from '../coords'
import { rotateToward, angleDelta } from '../math'
import type { GameWorld } from '../world'

/** Within this many tiles of a waypoint, treat it as reached. */
const WAYPOINT_EPSILON = 0.08

/** Above this heading error (radians) a unit rotates in place instead of moving. */
const TURN_BEFORE_MOVE = 0.35

export function movementSystem(world: GameWorld, dt: number): void {
  for (const e of world.ecs.with('position', 'movement')) {
    const mv = e.movement

    // A path request deferred by the frame budget: retry now.
    if (mv.repathTo && mv.path.length === 0) {
      const goal = mv.repathTo
      mv.repathTo = null
      issueMove(world, e.id, goal, 'ai')
    }

    if (mv.path.length === 0) continue

    let budget = mv.speed * dt
    let guard = 0

    while (budget > 0 && mv.path.length > 0) {
      // Defensive: a corrupt path should not hang the frame.
      if (guard++ > 64) break

      const target = mv.path[0]!
      const desired = angleTo(e.position, target)

      // Rotate first if we are facing far enough away. Infinity turnSpeed
      // (buildings, projectiles) skips this entirely.
      if (Number.isFinite(mv.turnSpeed)) {
        const err = Math.abs(angleDelta(e.facing ?? 0, desired))
        if (err > TURN_BEFORE_MOVE) {
          e.facing = rotateToward(e.facing ?? 0, desired, mv.turnSpeed * dt)
          e.renderDirty = true
          break // spend the frame turning
        }
      }
      e.facing = desired

      const remaining = distance(e.position, target)
      if (remaining <= WAYPOINT_EPSILON || remaining <= budget) {
        // Snap to the waypoint and continue with what is left of the budget.
        e.position.ne = target.ne
        e.position.se = target.se
        budget -= remaining
        mv.path.shift()
      } else {
        const t = budget / remaining
        e.position.ne += (target.ne - e.position.ne) * t
        e.position.se += (target.se - e.position.se) * t
        budget = 0
      }
      e.renderDirty = true
    }

    // Arrived: drop back to idle unless a higher-level state owns this unit.
    if (mv.path.length === 0 && e.state?.kind === 'moving') {
      e.state = { kind: 'idle' }
    }
  }
}

/**
 * Issue a move order.
 *
 * Returns false when the pathfinder deferred the request under its per-frame
 * budget — the caller's entity keeps `repathTo` set and retries next frame.
 * Player-issued orders are never deferred (docs/PATHFINDING_NOTES.md §7.5:
 * AoE2 exempts human commands from the path budget because responsiveness
 * matters more than an even frame time).
 */
export function issueMove(
  world: GameWorld,
  entityId: number,
  goal: WorldPos,
  priority: 'player' | 'ai' = 'player',
): boolean {
  const e = world.get(entityId)
  if (!e?.position || !e.movement) return false

  const startTile = { ne: Math.floor(e.position.ne), se: Math.floor(e.position.se) }
  const goalTile = { ne: Math.floor(goal.ne), se: Math.floor(goal.se) }

  const path = world.pathfinder.request({ start: startTile, goal: goalTile, priority })

  if (path === null) {
    // Budget-deferred. Remember the intent and try again next frame.
    e.movement.repathTo = { ...goal }
    return false
  }

  e.movement.repathTo = null

  if (path.waypoints.length === 0) {
    e.movement.path = []
    e.state = { kind: 'idle' }
    return false
  }

  // Convert tile waypoints to world positions. Skip the first (it is the tile
  // we are standing on) and replace the last with the exact requested point so
  // units stop where the player clicked rather than at a tile centre.
  const pts: WorldPos[] = []
  for (let i = 1; i < path.waypoints.length; i++) {
    const t = path.waypoints[i]!
    pts.push({ ne: t.ne + 0.5, se: t.se + 0.5 })
  }

  if (pts.length > 0 && world.terrain.isPassable(goalTile.ne, goalTile.se)) {
    pts[pts.length - 1] = { ...goal }
  }

  e.movement.path = pts
  e.state = { kind: 'moving', goal: { ...goal } }
  return true
}

export function stopEntity(world: GameWorld, entityId: number): void {
  const e = world.get(entityId)
  if (!e?.movement) return
  e.movement.path = []
  e.movement.repathTo = null
  e.state = { kind: 'idle' }
}
