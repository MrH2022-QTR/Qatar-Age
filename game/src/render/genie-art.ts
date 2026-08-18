/**
 * Genie type codes → art.
 *
 * The adopted simulation uses Age of Empires' own internal identifiers: FOAK is
 * an oak forest, VMBAS a base male villager, RTWC a town centre, GOLDM a gold
 * mine. They are opaque unless you already know them, so this table is the
 * translation layer — and the seam where Qatari art replaces generic art
 * without touching the simulation or the renderer.
 *
 * Three destinations:
 *   unit      an angle-bucketed animated sprite (sprites/library)
 *   building  the damage-state sheet
 *   sheet     a single cell from any sliced sheet (trees, mines, animals)
 */

export type ArtRef =
  | { kind: 'unit'; sprite: string }
  | { kind: 'building'; type: string }
  | { kind: 'sheet'; sheet: string; row: number; col: number; width: number }

/**
 * Matched in order, first hit wins. Prefixes rather than exact codes, because
 * Genie encodes upgrades as suffixes — VMBAS, VMFARM, VMLUM are all villagers
 * doing different jobs, and all should render as a villager.
 */
const RULES: Array<[RegExp, ArtRef]> = [
  // ── Units ────────────────────────────────────────────────────────────────
  [/^V[MF]/, { kind: 'unit', sprite: 'villager' }],
  [/^(SCOUT|CAVAL|KNIGH|CAMEL|HUSSA|PALAD)/, { kind: 'unit', sprite: 'cavalry' }],
  [/^(ARCHR|ARBAL|XBOW|SKIRM|CAVAR)/, { kind: 'unit', sprite: 'archer' }],
  [/^(SPEAR|PIKEM|HALBD)/, { kind: 'unit', sprite: 'spearman' }],
  [/^(MILIT|MAA|LONGS|TWOHS|CHAMP)/, { kind: 'unit', sprite: 'spearman' }],
  [/^(RAM|MANGO|SCORP|TREBU|BOMBA|SIEGE)/, { kind: 'unit', sprite: 'siege' }],

  // ── Buildings ────────────────────────────────────────────────────────────
  [/^RTWC|^TOWNC/, { kind: 'building', type: 'majlis' }],
  [/^HOUS/, { kind: 'building', type: 'bayt' }],
  [/^BRACK|^BARRA/, { kind: 'building', type: 'barracks' }],
  [/^(WCTWR|WATCH|TOWER)/, { kind: 'building', type: 'barzan_tower' }],
  [/^(MARKT|MARKE)/, { kind: 'building', type: 'souq' }],
  [/^(DOCK|HARBO)/, { kind: 'building', type: 'dhow_yard' }],
  [/^(MILL|FARM|LUMBR|MINEC|STORE|BLKSM|CHURC|MONAS|CSTLE|CASTL|WALL|GATE)/,
    { kind: 'building', type: 'bayt' }],

  // ── Gaia: trees, mines, forage, wildlife ─────────────────────────────────
  // Forests are the most numerous entity on an Arabia map by a wide margin, so
  // they get the tree cell from the decoration sheet rather than a marker.
  [/^(FOAK|FORES|TREE|PINET|PALMT|JUNGL|BAMBO)/,
    { kind: 'sheet', sheet: 'terrain/decorations', row: 0, col: 0, width: 78 }],
  [/^GOLDM/, { kind: 'sheet', sheet: 'resources/depletion_states', row: 3, col: 0, width: 62 }],
  [/^STONM/, { kind: 'sheet', sheet: 'resources/depletion_states', row: 2, col: 0, width: 62 }],
  [/^(FORAG|BUSH)/, { kind: 'sheet', sheet: 'resources/depletion_states', row: 1, col: 0, width: 54 }],
  [/^(SHEEP|GOAT|TURKE)/, { kind: 'sheet', sheet: 'wildlife/animals', row: 0, col: 0, width: 46 }],
  [/^(DEER|IBEX|ZEBRA)/, { kind: 'sheet', sheet: 'wildlife/animals', row: 1, col: 0, width: 54 }],
  [/^(BOAR|RHINO|ELEPH|LION|WOLF)/, { kind: 'sheet', sheet: 'wildlife/animals', row: 2, col: 0, width: 58 }],
]

const cache = new Map<string, ArtRef | null>()

export function artFor(genieName: string): ArtRef | null {
  const cached = cache.get(genieName)
  if (cached !== undefined) return cached
  let found: ArtRef | null = null
  for (const [re, ref] of RULES) {
    if (re.test(genieName)) {
      found = ref
      break
    }
  }
  cache.set(genieName, found)
  return found
}

/** Sheets any rule can reach, so the loader can preload exactly these. */
export function requiredSheets(): string[] {
  const out = new Set<string>()
  for (const [, ref] of RULES) if (ref.kind === 'sheet') out.add(ref.sheet)
  return [...out]
}
