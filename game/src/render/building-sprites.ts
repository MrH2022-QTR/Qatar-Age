/**
 * Building sprites with damage states.
 *
 * The art pack ships each building in three conditions — pristine, damaged,
 * rubble — which is how Age of Empires communicates a building's health without
 * a health bar: you can read a base's condition at a glance from across the map.
 *
 * Thresholds follow the pack's own convention:
 *     > 66%  pristine
 *   33-66%   damaged
 *     <= 33% rubble
 *
 * ── Scale ────────────────────────────────────────────────────────────────────
 *
 * Buildings scale to their footprint rather than by a fixed factor. A 4x4 town
 * hall must cover 4x4 tiles; a 2x2 house must cover 2x2. Deriving the scale
 * from the footprint means new buildings drop in correctly sized without anyone
 * tuning a magic number, and a different art pack works unchanged.
 */

import { Sprite, Texture, Rectangle } from 'pixi.js'
import { HALF_W } from '../sim/coords'

interface Cell {
  x: number
  y: number
  w: number
  h: number
  anchorX: number
  anchorY: number
}

export interface BuildingSheet {
  sheet: string
  width: number
  height: number
  rows: Cell[][]
}

/** Damage column indices within a row. */
export const enum Condition {
  Pristine = 0,
  Damaged = 1,
  Rubble = 2,
}

/**
 * Which sheet row renders each building type.
 *
 * Pack rows:  0 thatched house · 1 red-roof longhouse · 2 stone tower
 *             3 roofed watchtower · 4 great hall · 5 wall segment
 *
 * Qatari buildings are matched on silhouette and role rather than name — the
 * majlis takes the great hall, the barzan tower takes the stone tower. This
 * table is the seam where purpose-made Qatari art replaces the generic pack.
 */
export const BUILDING_ROWS: Record<string, number> = {
  majlis: 4,
  bayt: 0,
  barzan_tower: 2,
  souq: 1,
  barracks: 1,
  dhow_yard: 1,
  wall: 5,
}

export function conditionFor(hpFraction: number): Condition {
  if (hpFraction > 0.66) return Condition.Pristine
  if (hpFraction > 0.33) return Condition.Damaged
  return Condition.Rubble
}

export class BuildingSpriteFactory {
  private sheet: BuildingSheet
  private atlas: Texture
  private cache = new Map<string, Texture>()

  constructor(sheet: BuildingSheet, atlas: Texture) {
    this.sheet = sheet
    this.atlas = atlas
  }

  has(typeId: string): boolean {
    const row = BUILDING_ROWS[typeId]
    return row !== undefined && this.sheet.rows[row] !== undefined
  }

  private texture(row: number, col: number): Texture | null {
    const key = `${row}:${col}`
    const cached = this.cache.get(key)
    if (cached) return cached

    const cell = this.sheet.rows[row]?.[col]
    if (!cell) return null

    const tex = new Texture({
      source: this.atlas.source,
      frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
    })
    this.cache.set(key, tex)
    return tex
  }

  /**
   * Build a sprite for a building type at a given footprint and condition.
   * Returns null when the pack has no art for that type.
   */
  create(typeId: string, widthNe: number, heightSe: number, condition: Condition): Sprite | null {
    const row = BUILDING_ROWS[typeId]
    if (row === undefined) return null

    const cell = this.sheet.rows[row]?.[condition]
    const tex = this.texture(row, condition)
    if (!cell || !tex) return null

    const s = new Sprite(tex)

    // The footprint's screen width is the diamond's full span: half a tile per
    // step along each axis.
    const targetWidth = (widthNe + heightSe) * HALF_W
    const scale = targetWidth / cell.w
    s.scale.set(scale)

    // Anchor at the base centre so the building sits on its footprint rather
    // than floating above it.
    s.anchor.set(cell.anchorX / cell.w, cell.anchorY / cell.h)

    return s
  }

  /** Swap an existing sprite's texture when a building's condition changes. */
  applyCondition(sprite: Sprite, typeId: string, condition: Condition): void {
    const row = BUILDING_ROWS[typeId]
    if (row === undefined) return
    const cell = this.sheet.rows[row]?.[condition]
    const tex = this.texture(row, condition)
    if (!cell || !tex) return

    sprite.texture = tex
    sprite.anchor.set(cell.anchorX / cell.w, cell.anchorY / cell.h)
  }
}

export async function loadBuildingSheet(baseUrl: string): Promise<BuildingSheet | null> {
  try {
    const res = await fetch(`${baseUrl}/buildings.json`)
    if (!res.ok) return null
    return (await res.json()) as BuildingSheet
  } catch {
    return null
  }
}
