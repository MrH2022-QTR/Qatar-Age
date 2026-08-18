/**
 * Static content types.
 *
 * These mirror the structure of openage's nyan API (doc/nyan/api_reference/,
 * 5,188 lines) at a fraction of its generality. docs/DATA_INVENTORY.md explains
 * why we are authoring rather than porting: the repository ships no game
 * content at all, so what we inherit is a schema, not a dataset.
 *
 * The subset chosen here follows docs/SYSTEMS.md §7 — adopt the *structure* of
 * nyan's effect/resistance model (typed attack values meeting typed armour
 * values) without its full generality (no effect batches, no chaining, no
 * hyperbolic stacking). That covers essentially all of what Age of Empires
 * itself actually uses.
 */

export type ResourceKind = 'food' | 'wood' | 'stone' | 'pearls'

export type DamageType = 'melee' | 'pierce' | 'siege'

export type Cost = Partial<Record<ResourceKind, number>>

export type Attack = Partial<Record<DamageType, number>>
export type Armor = Partial<Record<DamageType, number>>

export interface UnitDef {
  id: string
  /** Localisation key. Never a display string — see docs/SYSTEMS.md §16. */
  nameKey: string
  cost: Cost
  buildTime: number
  hp: number
  /** Tiles per second. */
  speed: number
  /** Radians per second; null means instant. */
  turnSpeed: number | null
  /** Collision/separation radius in tiles. */
  radius: number
  attack?: Attack
  armor?: Armor
  /** Tiles. */
  range?: number
  /** Seconds between swings. */
  attackSpeed?: number
  lineOfSight: number
  /** Resource carrying capacity, for gatherers. */
  carryCapacity?: number
  /** Gather rate per second, by resource. */
  gatherRate?: Partial<Record<ResourceKind, number>>
  /** Placeholder colour until real art exists, as "#rrggbb". */
  debugColor: string
  /** Population cost. */
  pop: number
}

export interface BuildingDef {
  id: string
  nameKey: string
  cost: Cost
  buildTime: number
  hp: number
  /** Footprint in tiles along NE and SE. */
  widthNe: number
  heightSe: number
  armor?: Armor
  lineOfSight: number
  /** Unit ids this building can train. */
  trains?: string[]
  /** Tech ids this building can research. */
  researches?: string[]
  /** Resource kinds this building accepts as a drop site. */
  dropSite?: ResourceKind[]
  /** Population this building provides. */
  popProvided?: number
  debugColor: string
}

/**
 * A patch: one declarative modification to a static definition.
 *
 * This is our stand-in for nyan's patch system. openage gives each player their
 * own nyan::View onto the shared database (libopenage/gamestate/player.h:85) and
 * researching a tech applies patches to that view. The consequence, spelled out
 * in docs/SYSTEMS.md §8, is that civs and techs become the *same mechanism*,
 * and no per-entity stat recalculation is ever needed.
 */
export interface Patch {
  /** Unit or building id to modify. */
  target: string
  /** Dotted path into the definition, e.g. "attack.pierce" or "speed". */
  field: string
  op: 'set' | 'add' | 'mul'
  value: number
}

export interface TechDef {
  id: string
  nameKey: string
  cost: Cost
  researchTime: number
  /** Tech ids that must be researched first. */
  requires: string[]
  patches: Patch[]
  /** Age this tech belongs to; gates availability. */
  age: number
}

export interface CivDef {
  id: string
  nameKey: string
  /** Applied at match start. A civ is just a named patch list. */
  bonuses: Patch[]
  /** Unit/tech ids this civ cannot access. */
  excludes?: string[]
  /** Unique unit id, if any. */
  uniqueUnit?: string
}

export interface AgeDef {
  index: number
  nameKey: string
  cost: Cost
  advanceTime: number
}

export interface GameData {
  units: Record<string, UnitDef>
  buildings: Record<string, BuildingDef>
  techs: Record<string, TechDef>
  civs: Record<string, CivDef>
  ages: AgeDef[]
}
