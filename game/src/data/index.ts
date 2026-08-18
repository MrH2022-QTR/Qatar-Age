/**
 * Static data loading.
 *
 * docs/PORT_PLAN.md calls this "trivial", and it is — the interesting work is
 * in player.ts, which layers per-player patches on top of what this returns.
 *
 * The one discipline that matters here: nothing in the simulation should import
 * BASE_DATA directly to read a stat. Stats are always read through a player's
 * data view. See player.ts for why.
 */

import unitsJson from './units.json'
import buildingsJson from './buildings.json'
import progressionJson from './progression.json'
import type { AgeDef, BuildingDef, CivDef, GameData, TechDef, UnitDef } from './types'

export * from './types'

/** Parse "#rrggbb" into the 0xRRGGBB integer PixiJS wants. */
export function parseColor(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

const units = unitsJson as unknown as Record<string, UnitDef>
const buildings = buildingsJson as unknown as Record<string, BuildingDef>
const progression = progressionJson as unknown as {
  ages: AgeDef[]
  techs: Record<string, TechDef>
  civs: Record<string, CivDef>
}

export const BASE_DATA: GameData = Object.freeze({
  units,
  buildings,
  techs: progression.techs,
  civs: progression.civs,
  ages: progression.ages,
})

export function unitDef(id: string): UnitDef {
  const d = BASE_DATA.units[id]
  if (!d) throw new Error(`unknown unit type: ${id}`)
  return d
}

export function buildingDef(id: string): BuildingDef {
  const d = BASE_DATA.buildings[id]
  if (!d) throw new Error(`unknown building type: ${id}`)
  return d
}

export function isBuildingType(id: string): boolean {
  return id in BASE_DATA.buildings
}
