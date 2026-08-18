/**
 * Entity components.
 *
 * docs/SYSTEMS.md §3 works through the one genuinely consequential decision in
 * this port, and this file is where it lands. Restating it, because the naming
 * is a trap:
 *
 * openage says "component" and "system", but its own documentation admits it is
 * not a data-oriented ECS (doc/code/game_simulation/game_entity.md). Its
 * entities are hash maps of polymorphic heap objects, and its systems are
 * invoked per-entity by that entity's behaviour graph — never as a query over a
 * component array. miniplex is a real ECS. The two models do not compose.
 *
 * So we take openage's DATA model and reject its CONTROL-FLOW model:
 *
 *   - Data: plain-object components, and openage's two-tier split between
 *     immutable type data (looked up through the owning player's data view) and
 *     mutable runtime state (stored here). That split is what makes tech
 *     upgrades tractable — see player.ts.
 *
 *   - Control flow: ordinary miniplex queries, plus a small `state`
 *     discriminated union per unit. openage's activity graphs are a
 *     configurable behaviour-graph interpreter; that is the right tool when
 *     designers author behaviour, and overkill until then.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Entities reference each other by numeric id, NEVER by object reference.
 *      This is what makes save/load a JSON.stringify rather than a graph walk.
 *   2. Components are plain serialisable data. The one exception is `sprite`,
 *      which holds a renderer handle and is explicitly excluded from saves.
 */

import { type WorldPos } from './coords'

export type EntityId = number
export type PlayerId = number

// ── Unit behaviour state ─────────────────────────────────────────────────────
//
// A discriminated union rather than a pile of booleans. RTS units genuinely do
// need a state machine — "gather until full, walk to the drop site, deposit,
// come back, unless interrupted" is not expressible as flat queries without a
// tangle of flags — but they do not need a graph interpreter to get one.

export type UnitState =
  | { kind: 'idle' }
  | { kind: 'moving'; goal: WorldPos }
  | { kind: 'gathering'; targetId: EntityId; until: number }
  | { kind: 'returning'; dropSiteId: EntityId }
  | { kind: 'attacking'; targetId: EntityId; nextSwingAt: number }
  | { kind: 'building'; siteId: EntityId }

export interface Movement {
  /** Tiles per second. */
  speed: number
  /** Radians per second. Infinity means instant turning. */
  turnSpeed: number
  /**
   * Remaining path in world coordinates. Consumed front to back.
   *
   * Note this is a plain array we advance each frame, NOT openage's approach of
   * baking the whole journey into position-curve keyframes up front
   * (libopenage/gamestate/system/move.cpp:95). docs/SYSTEMS.md §4 explains the
   * trade: keyframes are better for network sync, which we do not have, and
   * worse for interruption and debugging, which we do.
   */
  path: WorldPos[]
  /** Set when a path request was deferred by the frame budget; retried next frame. */
  repathTo: WorldPos | null
}

export interface Health {
  current: number
  max: number
}

export interface Collider {
  /** In tiles. Drives soft separation, not hard blocking. */
  radius: number
}

export interface Selectable {
  /** Click/box-select radius, in tiles. */
  radius: number
}

export interface Building {
  /** Footprint in tiles, along the NE and SE axes. */
  widthNe: number
  heightSe: number
  /** North-west origin tile of the footprint. */
  originNe: number
  originSe: number
  /** 0..1. Below 1 the building is a construction site. */
  progress: number
}

export interface ResourceSpot {
  kind: ResourceKind
  remaining: number
}

export type ResourceKind = 'food' | 'wood' | 'stone' | 'pearls'

export interface Carrying {
  kind: ResourceKind | null
  amount: number
  capacity: number
}

/**
 * Renderer handle. The ONLY component the simulation must never read, and the
 * only one excluded from serialisation. Typed as unknown here so that
 * src/sim never gains a structural dependency on PixiJS — the render layer
 * casts it back.
 */
export interface SpriteRef {
  handle: unknown
}

export interface Entity {
  id: EntityId

  // Spatial
  position?: WorldPos
  /** Facing, radians, using the convention in coords.angleTo. */
  facing?: number
  movement?: Movement
  collider?: Collider

  // Identity
  /** Key into the static unit/building tables. Stats are read through the
   *  owning player's data view, never cached here — see player.ts. */
  typeId?: string
  owner?: PlayerId

  // Behaviour
  state?: UnitState

  // Capability tags
  selectable?: Selectable
  selected?: true
  health?: Health
  building?: Building
  resourceSpot?: ResourceSpot
  carrying?: Carrying

  // Presentation (never read by the simulation)
  sprite?: SpriteRef
  /** Set by any system that changes something the renderer mirrors. */
  renderDirty?: true
}

/** Components stripped before serialising. */
export const NON_SERIALISABLE_KEYS: ReadonlyArray<keyof Entity> = ['sprite', 'renderDirty']

export function serialisableEntity(e: Entity): Partial<Entity> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if ((NON_SERIALISABLE_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  return out as Partial<Entity>
}
