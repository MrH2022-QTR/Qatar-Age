/**
 * Generic sheet library.
 *
 * The art library is 59 sheets across a dozen categories, all sliced by the
 * same connected-component pass into one manifest (tools/build-assets.mjs).
 * This is the runtime side: fetch the manifest, lazily upload atlas pages, and
 * hand out textures by (sheet, row, column).
 *
 * Deliberately dumb. It knows nothing about units, resources or doodads — it
 * just returns a texture and its anchor. Meaning lives in the callers, which is
 * what lets one loader serve resources, decorations, wildlife, projectiles and
 * icons without a bespoke class each.
 */

import { Assets, Rectangle, Sprite, Texture } from 'pixi.js'

export interface SheetCell {
  x: number
  y: number
  w: number
  h: number
  anchorX: number
  anchorY: number
}

interface SheetRow {
  name: string
  cells: SheetCell[]
}

interface SheetDef {
  id: string
  category: string
  file: string
  width: number
  height: number
  rows: SheetRow[]
}

interface SheetsManifest {
  version: 2
  sheets: Record<string, SheetDef>
}

export class SheetLibrary {
  private manifest: SheetsManifest | null = null
  private baseUrl = ''
  private textures = new Map<string, Texture>()
  private cellCache = new Map<string, Texture>()

  async load(baseUrl: string): Promise<boolean> {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    try {
      const res = await fetch(`${this.baseUrl}/sheets.json`)
      if (!res.ok) return false
      const m = (await res.json()) as SheetsManifest
      if (m.version !== 2) return false
      this.manifest = m
      return true
    } catch {
      return false
    }
  }

  get loaded(): boolean {
    return this.manifest !== null
  }

  has(sheet: string): boolean {
    return !!this.manifest?.sheets[sheet]
  }

  /** Row/column counts, for callers that want to spread over what exists. */
  shape(sheet: string): number[] {
    const s = this.manifest?.sheets[sheet]
    return s ? s.rows.map((r) => r.cells.length) : []
  }

  /** Upload a sheet's atlas page. Safe to call repeatedly. */
  async preload(sheets: string[]): Promise<void> {
    if (!this.manifest) return
    await Promise.all(
      sheets.map(async (key) => {
        const def = this.manifest!.sheets[key]
        if (!def || this.textures.has(key)) return
        const tex = await Assets.load<Texture>(`${this.baseUrl}/${def.file}`)
        this.textures.set(key, tex)
      }),
    )
  }

  cell(sheet: string, row: number, col: number): SheetCell | null {
    const def = this.manifest?.sheets[sheet]
    const r = def?.rows[row]
    if (!r) return null
    // Wrap rather than fail: sheets have uneven row lengths, and a caller
    // asking for column 7 of a 5-wide row should get something sensible.
    return r.cells[col % r.cells.length] ?? null
  }

  texture(sheet: string, row: number, col: number): Texture | null {
    const def = this.manifest?.sheets[sheet]
    const page = this.textures.get(sheet)
    const cell = this.cell(sheet, row, col)
    if (!def || !page || !cell) return null

    const key = `${sheet}:${row}:${col}`
    const cached = this.cellCache.get(key)
    if (cached) return cached

    const tex = new Texture({
      source: page.source,
      frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
    })
    this.cellCache.set(key, tex)
    return tex
  }

  /**
   * Build a sprite anchored on its cell's foot point and scaled so its width
   * covers `targetWidth` screen pixels. Returns null when the art is absent,
   * which every caller treats as "fall back to a placeholder".
   */
  sprite(sheet: string, row: number, col: number, targetWidth: number): Sprite | null {
    const tex = this.texture(sheet, row, col)
    const cell = this.cell(sheet, row, col)
    if (!tex || !cell) return null

    const s = new Sprite(tex)
    s.anchor.set(cell.anchorX / cell.w, cell.anchorY / cell.h)
    s.scale.set(targetWidth / cell.w)
    return s
  }

  report(): string {
    if (!this.manifest) return 'no sheet manifest'
    const total = Object.keys(this.manifest.sheets).length
    return `${this.textures.size}/${total} sheets resident`
  }
}

// ── Placement tables ─────────────────────────────────────────────────────────
//
// Which sheet cell renders each piece of game content. Kept here rather than
// scattered through the renderers so re-pointing at different art is a single
// edit — the same seam TYPE_TO_SPRITE and BUILDING_ROWS provide.

/** Resource nodes: [sheet, row]. Column is chosen by remaining amount. */
export const RESOURCE_ART: Record<string, { sheet: string; row: number }> = {
  wood: { sheet: 'resources/depletion_states', row: 0 },
  food: { sheet: 'resources/depletion_states', row: 1 },
  stone: { sheet: 'resources/depletion_states', row: 2 },
  pearls: { sheet: 'resources/depletion_states', row: 3 },
}

/**
 * Scatter decoration: rows of terrain/decorations and doodads/map_dressing
 * that suit each terrain type. Breaking up repeated tiles is what stops a
 * procedurally generated map reading as graph paper.
 */
export const DOODAD_ROWS: Record<number, Array<{ sheet: string; row: number }>> = {
  // TerrainType.Sand / Desert / Gravel — sparse rocks and scrub
  0: [{ sheet: 'terrain/decorations', row: 2 }, { sheet: 'doodads/map_dressing', row: 1 }],
  1: [{ sheet: 'terrain/decorations', row: 2 }],
  2: [{ sheet: 'terrain/decorations', row: 3 }],
  // Grass — denser vegetation
  3: [{ sheet: 'terrain/decorations', row: 0 }, { sheet: 'terrain/decorations', row: 1 }],
}
