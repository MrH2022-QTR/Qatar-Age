/**
 * Players, their resources, and — the important part — their data view.
 *
 * ── The idea being copied ────────────────────────────────────────────────────
 *
 * openage gives every Player its own nyan::View onto the shared game database
 * (libopenage/gamestate/player.h:85). Researching a tech applies patches to
 * that player's view, and every stat lookup a unit performs goes through its
 * owner's view. docs/SYSTEMS.md §8 works through why this is the best idea in
 * that codebase:
 *
 *   - No iterating over existing units to bump their stats after an upgrade.
 *   - Units created before and after an upgrade automatically agree.
 *   - Per-player divergence is free; no per-entity stat storage.
 *   - Civ bonuses are just patches applied at match start, which means
 *     CIVILISATIONS AND TECHS ARE THE SAME MECHANISM. You build one system and
 *     get both.
 *
 * ── The discipline that makes it work ────────────────────────────────────────
 *
 * Every stat read goes through `player.data.unit(typeId)`. Never import
 * BASE_DATA to read a stat, and never copy stats onto an entity at spawn time.
 *
 * docs/PORT_PLAN.md Phase 0 puts this first for a reason: done now it costs
 * nothing, done later it is a refactor across every call site, and entities
 * that cached their stats at spawn need invalidation logic that is easy to get
 * subtly wrong.
 */

import { BASE_DATA, type BuildingDef, type Patch, type ResourceKind, type UnitDef } from '../data'
import type { PlayerId } from './components'

export type Stockpile = Record<ResourceKind, number>

export function emptyStockpile(): Stockpile {
  return { food: 0, wood: 0, stone: 0, pearls: 0 }
}

export function startingStockpile(): Stockpile {
  return { food: 200, wood: 200, stone: 100, pearls: 0 }
}

/** Read a dotted path out of a definition object. */
function readPath(obj: unknown, path: string): number | undefined {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'number' ? cur : undefined
}

/** Write a dotted path into a definition object, creating intermediates. */
function writePath(obj: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    const next = cur[p]
    if (next == null || typeof next !== 'object') cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

function applyPatch<T extends object>(def: T, patch: Patch): T {
  // Structured clone keeps nested objects (cost, attack, gatherRate) from being
  // shared with the base definition — patching one player must never be visible
  // to another.
  const copy = structuredClone(def) as Record<string, unknown>
  const current = readPath(copy, patch.field) ?? 0
  let next: number
  switch (patch.op) {
    case 'set':
      next = patch.value
      break
    case 'add':
      next = current + patch.value
      break
    case 'mul':
      next = current * patch.value
      break
  }
  writePath(copy, patch.field, next)
  return copy as T
}

/**
 * A per-player layered view over the static tables.
 *
 * Patched results are memoised, and the cache entry for a target is dropped
 * when a patch touching it arrives. Patch order is preserved and applied
 * in sequence, so `add` then `mul` differs from `mul` then `add` — deliberately,
 * because that is how upgrade stacking is normally specified.
 */
export class PlayerDataView {
  private patchesByTarget = new Map<string, Patch[]>()
  private unitCache = new Map<string, UnitDef>()
  private buildingCache = new Map<string, BuildingDef>()

  unit(id: string): UnitDef {
    const cached = this.unitCache.get(id)
    if (cached) return cached

    const base = BASE_DATA.units[id]
    if (!base) throw new Error(`unknown unit type: ${id}`)

    let def = base
    for (const p of this.patchesByTarget.get(id) ?? []) {
      def = applyPatch(def, p)
    }
    this.unitCache.set(id, def)
    return def
  }

  building(id: string): BuildingDef {
    const cached = this.buildingCache.get(id)
    if (cached) return cached

    const base = BASE_DATA.buildings[id]
    if (!base) throw new Error(`unknown building type: ${id}`)

    let def = base
    for (const p of this.patchesByTarget.get(id) ?? []) {
      def = applyPatch(def, p)
    }
    this.buildingCache.set(id, def)
    return def
  }

  applyPatches(patches: readonly Patch[]): void {
    for (const p of patches) {
      const list = this.patchesByTarget.get(p.target)
      if (list) list.push(p)
      else this.patchesByTarget.set(p.target, [p])
      this.unitCache.delete(p.target)
      this.buildingCache.delete(p.target)
    }
  }

  /** For save/load: patches are the entire mutable state of the view. */
  serialise(): Patch[] {
    const out: Patch[] = []
    for (const list of this.patchesByTarget.values()) out.push(...list)
    return out
  }
}

export class Player {
  readonly id: PlayerId
  readonly civId: string
  readonly data = new PlayerDataView()

  resources: Stockpile = startingStockpile()
  age = 0
  researched = new Set<string>()
  researching: { techId: string; completesAt: number } | null = null

  popUsed = 0
  popCap = 0
  readonly popMax = 200

  /** Display colour for units and buildings. */
  readonly color: number

  constructor(id: PlayerId, civId: string, color: number) {
    this.id = id
    this.civId = civId
    this.color = color

    // A civilisation is just a named patch list applied at match start.
    const civ = BASE_DATA.civs[civId]
    if (civ) this.data.applyPatches(civ.bonuses)
  }

  canAfford(cost: Partial<Stockpile>): boolean {
    for (const [k, v] of Object.entries(cost) as [ResourceKind, number][]) {
      if (this.resources[k] < v) return false
    }
    return true
  }

  spend(cost: Partial<Stockpile>): boolean {
    if (!this.canAfford(cost)) return false
    for (const [k, v] of Object.entries(cost) as [ResourceKind, number][]) {
      this.resources[k] -= v
    }
    return true
  }

  gain(kind: ResourceKind, amount: number): void {
    this.resources[kind] += amount
  }

  /** Available population headroom. */
  get popFree(): number {
    return Math.min(this.popCap, this.popMax) - this.popUsed
  }

  completeResearch(techId: string): void {
    const tech = BASE_DATA.techs[techId]
    if (!tech) return
    this.researched.add(techId)
    this.data.applyPatches(tech.patches)
    // Age advancement is just a tech whose id we recognise.
    const ageIdx = BASE_DATA.ages.findIndex((a) => `age_${a.nameKey.split('.')[1]}` === techId)
    if (ageIdx > 0) this.age = Math.max(this.age, ageIdx)
  }

  canResearch(techId: string): boolean {
    const tech = BASE_DATA.techs[techId]
    if (!tech) return false
    if (this.researched.has(techId)) return false
    return tech.requires.every((r) => this.researched.has(r))
  }
}
