/**
 * Coordinate systems.
 *
 * This is the module docs/PORT_PLAN.md §6 nominates as the right first thing to
 * build, for a specific reason: every other system speaks in these units, and
 * coordinate bugs in an isometric game surface late, look like rendering
 * glitches, and cost days. It is small, fully testable in isolation, and
 * openage already documented the correct math in doc/code/coordinate-systems.md.
 *
 * ── Spaces ───────────────────────────────────────────────────────────────────
 *
 *  World  (ne, se)  Continuous position in tile units. Floats. What the
 *                   simulation thinks in. Named after openage's NE/SE axes.
 *  Tile   (ne, se)  Integer tile indices. Pathfinding and terrain think in these.
 *  Screen (x,  y)   Pixels, before the camera transform. Rendering only.
 *
 * ── Orientation ──────────────────────────────────────────────────────────────
 *
 * The map is a diamond. The origin is the WEST corner of tile (0,0), following
 * openage. From there:
 *
 *      +NE runs toward the north corner  →  up and to the right on screen
 *      +SE runs toward the south corner  →  down and to the right on screen
 *
 *                        N  (0,0)+ne
 *                       / \
 *                      /   \
 *          W (0,0) ──►/     \◄── E
 *                      \   /
 *                       \ /
 *                        S  (0,0)+se
 *
 * So both axes push right in x, and they disagree in y. That gives:
 *
 *      x = (ne + se) * TILE_W/2
 *      y = (se - ne) * TILE_H/2
 *
 * TILE_W:TILE_H is 2:1, the classic isometric ratio Age of Empires uses.
 *
 * ── A note on the 3D case ────────────────────────────────────────────────────
 *
 * openage renders a real 3D scene and converts with
 *     Eigen(x, y, z) = (SE, UP / sqrt(8), -NE)
 * where the sqrt(8) is dimetric foreshortening of the elevation axis. We render
 * flat 2D sprites and have deliberately deferred elevation (see
 * docs/SYSTEMS.md §13), so we need the 2D projection only. If elevation is ever
 * added, `up` enters as a straight vertical screen offset scaled by
 * TILE_H / sqrt(8), and nothing else here changes.
 */

/** Tile footprint in pixels at zoom 1. The 2:1 ratio is load-bearing. */
export const TILE_W = 64
export const TILE_H = 32
export const HALF_W = TILE_W / 2
export const HALF_H = TILE_H / 2

export interface WorldPos {
  ne: number
  se: number
}

export interface TilePos {
  ne: number
  se: number
}

export interface ScreenPos {
  x: number
  y: number
}

export const world = (ne: number, se: number): WorldPos => ({ ne, se })
export const tile = (ne: number, se: number): TilePos => ({ ne, se })

/** World → screen pixels (pre-camera). */
export function worldToScreen(p: WorldPos): ScreenPos {
  return {
    x: (p.ne + p.se) * HALF_W,
    y: (p.se - p.ne) * HALF_H,
  }
}

/**
 * Screen pixels → world. Exact inverse of worldToScreen.
 *
 * Derivation, since this is the one people get wrong:
 *     x / HALF_W = ne + se
 *     y / HALF_H = se - ne
 *   sum  → se = (x/HALF_W + y/HALF_H) / 2
 *   diff → ne = (x/HALF_W - y/HALF_H) / 2
 */
export function screenToWorld(p: ScreenPos): WorldPos {
  const a = p.x / HALF_W
  const b = p.y / HALF_H
  return {
    ne: (a - b) / 2,
    se: (a + b) / 2,
  }
}

/** Containing tile of a world position. */
export function worldToTile(p: WorldPos): TilePos {
  return { ne: Math.floor(p.ne), se: Math.floor(p.se) }
}

/** Centre of a tile, in world units. Where units stand when they occupy a tile. */
export function tileCenter(t: TilePos): WorldPos {
  return { ne: t.ne + 0.5, se: t.se + 0.5 }
}

/** Screen position of a tile's centre. */
export function tileToScreen(t: TilePos): ScreenPos {
  return worldToScreen(tileCenter(t))
}

/**
 * Painter's-algorithm depth for a ground point.
 *
 * For a fixed isometric camera the depth axis is simply screen y: whatever sits
 * lower on screen is nearer the viewer and draws on top. Two objects at equal
 * depth are on the same visual row and cannot overlap, so ties are harmless.
 *
 * Returned unscaled (not multiplied by HALF_H) because PixiJS zIndex only needs
 * a consistent ordering, and keeping the magnitude small keeps the sort cheap.
 */
export function depthOf(p: WorldPos): number {
  return p.se - p.ne
}

// ── Distance ─────────────────────────────────────────────────────────────────
//
// Distances are measured in the (ne, se) plane, NOT in screen space. This
// matters: two units that look equally far apart on screen are not, because the
// projection squashes one axis. Gameplay always uses world distance.

export function distanceSq(a: WorldPos, b: WorldPos): number {
  const dne = a.ne - b.ne
  const dse = a.se - b.se
  return dne * dne + dse * dse
}

export function distance(a: WorldPos, b: WorldPos): number {
  return Math.sqrt(distanceSq(a, b))
}

/** Chebyshev distance in tiles — the natural metric for 8-way grid movement. */
export function tileDistance(a: TilePos, b: TilePos): number {
  return Math.max(Math.abs(a.ne - b.ne), Math.abs(a.se - b.se))
}

/**
 * Facing angle from `a` to `b`, in radians, in world space.
 *
 * Zero points along +SE and increases toward +NE. Sprite angle buckets are
 * derived from this, so the convention has to stay stable — changing it
 * silently rotates every unit in the game.
 */
export function angleTo(a: WorldPos, b: WorldPos): number {
  return Math.atan2(b.ne - a.ne, b.se - a.se)
}

/** Quantise a facing angle into one of `count` sprite buckets. */
export function angleToBucket(angle: number, count: number): number {
  const tau = Math.PI * 2
  const norm = ((angle % tau) + tau) % tau
  return Math.round((norm / tau) * count) % count
}

export function tileKey(t: TilePos): number {
  // Packed for Map/Set keys. Supports maps up to 65536 tiles per side.
  return t.ne * 65536 + t.se
}

export function tileEquals(a: TilePos, b: TilePos): boolean {
  return a.ne === b.ne && a.se === b.se
}
