/**
 * Soft collision between units.
 *
 * ── Why this exists, and why it is the most important design call in the port ─
 *
 * docs/PATHFINDING_NOTES.md analyses a Meeting C++ 2025 talk by the Engineering
 * Director at Forgotten Empires, the studio that ships the official Age of
 * Empires Definitive Editions. Age of Empires II enforces strict collision:
 * units bump, stop, repath, and go around, with no pushing and no overlap
 * outside formations. That constraint is the root of 25 years of pathfinding
 * complaints, because it makes every mobile unit a dynamic obstacle that
 * invalidates paths and demands exact geometric predicates.
 *
 * Asked what he would do starting from a green field, his answer was:
 *
 *     "I would definitely keep to squares, but I would go with the StarCraft
 *      approach by just simplifying the problem at the very beginning.
 *      Players just like that better."
 *
 * We have a green field. So:
 *
 *   - Buildings and terrain are HARD obstructions, stamped into the cost grid
 *     and pathed around properly.
 *   - Units are SOFT. They repel each other and may briefly overlap while
 *     resolving. They are never obstacles to the pathfinder.
 *
 * That eliminates by construction the entire bug class the talk is about: no
 * dynamic obstacles invalidating paths, no hull geometry, no near-collinear
 * degeneracy, no 64-iteration flail when a unit is boxed in by its friends.
 *
 * ── The cost, stated honestly ────────────────────────────────────────────────
 *
 * We lose body-blocking as a tactic — the fishing-ship play the talk describes,
 * where a player plugs the last gap in a wall with a boat to trap raiding
 * knights. That is a real loss of tactical depth. It is a deliberate trade for
 * movement that reads as smooth to a broad audience, and it is revisitable:
 * keeping walls hard while units stay soft preserves most of the tactic.
 */

import type { Entity } from '../components'
import type { GameWorld } from '../world'

/** How hard units push apart. Tiles per second at full overlap. */
const SEPARATION_STRENGTH = 2.2

/** Units closer than (r1 + r2) * this factor start pushing. */
const PERSONAL_SPACE = 1.0

/**
 * Idle units resist being shoved, so a standing crowd does not slowly drift
 * apart. Moving units yield more readily, which is what lets a column squeeze
 * past a stationary group.
 */
const IDLE_RESISTANCE = 0.35

const scratch: number[] = []

export function steeringSystem(world: GameWorld, dt: number): void {
  for (const e of world.ecs.with('position', 'collider')) {
    // Buildings and resource nodes participate as pushers but are never pushed.
    if (e.building || e.resourceSpot) continue

    const pos = e.position
    const radius = e.collider.radius
    const queryR = radius * 2 + 1

    const ids = world.spatial.queryRadius(pos, queryR, scratch as unknown as number[])

    let pushNe = 0
    let pushSe = 0

    for (const id of ids) {
      if (id === e.id) continue
      const other = world.get(id) as Entity | undefined
      if (!other?.position || !other.collider) continue
      if (other.resourceSpot) continue

      const dne = pos.ne - other.position.ne
      const dse = pos.se - other.position.se
      const distSq = dne * dne + dse * dse

      const minDist = (radius + other.collider.radius) * PERSONAL_SPACE
      if (distSq >= minDist * minDist) continue

      if (distSq < 1e-8) {
        // Exactly coincident: nudge deterministically by id so two stacked
        // units separate instead of jittering. Uses no randomness, so this
        // stays reproducible.
        const bias = (e.id % 2 === 0 ? 1 : -1) * 0.01
        pushNe += bias
        pushSe += bias * 0.5
        continue
      }

      const dist = Math.sqrt(distSq)
      // Linear falloff: full strength at full overlap, zero at contact.
      const strength = (minDist - dist) / minDist
      pushNe += (dne / dist) * strength
      pushSe += (dse / dist) * strength
    }

    if (pushNe === 0 && pushSe === 0) continue

    const moving = e.movement && e.movement.path.length > 0
    const scale = SEPARATION_STRENGTH * dt * (moving ? 1 : IDLE_RESISTANCE)

    let nextNe = pos.ne + pushNe * scale
    let nextSe = pos.se + pushSe * scale

    // Separation must never push a unit into a wall or a building. If it would,
    // drop the offending axis rather than the whole correction, so units still
    // slide along walls instead of sticking to them.
    if (!world.terrain.isPassable(Math.floor(nextNe), Math.floor(pos.se))) nextNe = pos.ne
    if (!world.terrain.isPassable(Math.floor(nextNe), Math.floor(nextSe))) nextSe = pos.se

    // And never off the map.
    const maxNe = world.terrain.width - 0.01
    const maxSe = world.terrain.height - 0.01
    pos.ne = Math.min(Math.max(nextNe, 0), maxNe)
    pos.se = Math.min(Math.max(nextSe, 0), maxSe)
    e.renderDirty = true
  }
}
