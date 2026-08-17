/**
 * HUD — rendered in the DOM, deliberately.
 *
 * docs/SYSTEMS.md §10 argues we have a better option than openage does here.
 * openage bridges engine objects into QML through QObject property wrappers
 * (libopenage/renderer/gui/, 3,754 lines). We can absolutely position DOM over
 * the canvas instead, which gives us CSS layout, real text rendering, and —
 * the one that matters for this project — correct Arabic shaping and bidi,
 * which canvas text rendering handles poorly.
 *
 * Only world-space overlays stay in PixiJS: selection rings, health bars, the
 * placement ghost, and paths.
 */

import { formatNumber, t } from '../i18n'
import type { GameWorld } from '../sim/world'
import type { Simulation } from '../sim/simulation'
import type { GameInput } from './input'
import { TerrainType } from '../sim/grid'

/** Minimap colours per terrain type — readable at 1px, not realistic. */
const MINIMAP_COLORS: Record<number, number> = {
  [TerrainType.Sand]: 0xc8a870,
  [TerrainType.Desert]: 0xb89358,
  [TerrainType.Gravel]: 0x9c8f74,
  [TerrainType.Grass]: 0x6f8f4a,
  [TerrainType.ShallowWater]: 0x5b93ad,
  [TerrainType.DeepWater]: 0x2f5f7d,
  [TerrainType.Rock]: 0x7a7568,
}

const RESOURCES = ['food', 'wood', 'stone', 'pearls'] as const

/**
 * The chrome art's resource plaques run wood, food, gold, stone left to right.
 * Our resources are food, wood, stone, pearls — so the display order is
 * remapped to sit under the right icon rather than reordering the model.
 */
const CHROME_SLOT_ORDER = ['wood', 'food', 'pearls', 'stone'] as const

export class Hud {
  private root: HTMLElement
  private resourceEls = new Map<string, HTMLElement>()
  private popEl!: HTMLElement
  private ageEl!: HTMLElement
  private selectionEl!: HTMLElement
  private debugEl!: HTMLElement
  private portraitEl!: HTMLElement
  private minimapCanvas!: HTMLCanvasElement
  private commandButtons: HTMLButtonElement[] = []

  private world: GameWorld
  private sim: Simulation
  private input: GameInput
  private localPlayerId: number

  showDebug = false

  private frameTimes: number[] = []
  private lastFrame = performance.now()

  constructor(
    root: HTMLElement,
    world: GameWorld,
    sim: Simulation,
    input: GameInput,
    localPlayerId: number,
  ) {
    this.root = root
    this.world = world
    this.sim = sim
    this.input = input
    this.localPlayerId = localPlayerId
    this.build()
  }

  private build(): void {
    this.root.innerHTML = ''
    this.root.classList.add('chrome')

    // ── Resource bar ────────────────────────────────────────────────────────
    const res = document.createElement('div')
    res.className = 'chrome-resources'
    for (const kind of CHROME_SLOT_ORDER) {
      const v = document.createElement('span')
      v.className = 'chrome-resource-value'
      v.textContent = '0'
      res.appendChild(v)
      this.resourceEls.set(kind, v)
    }

    // ── Age / population, clear of the bar ──────────────────────────────────
    const topRight = document.createElement('div')
    topRight.className = 'chrome-topright'
    this.popEl = document.createElement('span')
    this.ageEl = document.createElement('span')
    topRight.append(this.popEl, this.ageEl)

    // ── Status line ─────────────────────────────────────────────────────────
    this.selectionEl = document.createElement('div')
    this.selectionEl.className = 'chrome-status'

    // ── Bottom bar: minimap, command panel, portrait ────────────────────────
    const bottom = document.createElement('div')
    bottom.className = 'chrome-bottom'

    const minimap = document.createElement('div')
    minimap.className = 'chrome-minimap'
    this.minimapCanvas = document.createElement('canvas')
    this.minimapCanvas.width = 128
    this.minimapCanvas.height = 128
    minimap.appendChild(this.minimapCanvas)

    const command = document.createElement('div')
    command.className = 'chrome-command'
    // Ten recesses in the stone; wired to actions as they are implemented.
    for (let i = 0; i < 10; i++) {
      const b = document.createElement('button')
      b.className = 'chrome-button'
      b.disabled = true
      b.dataset.slot = String(i)
      command.appendChild(b)
      this.commandButtons.push(b)
    }

    const portrait = document.createElement('div')
    portrait.className = 'chrome-portrait'
    this.portraitEl = document.createElement('div')
    this.portraitEl.className = 'chrome-portrait-label'
    portrait.appendChild(this.portraitEl)

    bottom.append(minimap, command, portrait)

    // ── Debug overlay ───────────────────────────────────────────────────────
    this.debugEl = document.createElement('div')
    this.debugEl.className = 'hud-debug'
    this.debugEl.hidden = true

    this.root.append(res, topRight, this.selectionEl, bottom, this.debugEl)
  }

  update(): void {
    const now = performance.now()
    this.frameTimes.push(now - this.lastFrame)
    if (this.frameTimes.length > 60) this.frameTimes.shift()
    this.lastFrame = now

    const player = this.world.player(this.localPlayerId)
    if (!player) return

    for (const kind of RESOURCES) {
      const el = this.resourceEls.get(kind)
      if (el) el.textContent = formatNumber(Math.floor(player.resources[kind]))
    }

    this.popEl.textContent = `${t('hud.population')} ${player.popUsed}/${Math.min(player.popCap, player.popMax)}`

    const age = this.world.players.get(this.localPlayerId)?.age ?? 0
    const ageKey = ['age.settlement.name', 'age.pearling.name', 'age.trade.name', 'age.unification.name'][age]
    this.ageEl.textContent = `${t('hud.age')}: ${t(ageKey ?? 'age.settlement.name')}`

    // Selection summary.
    const sel = this.input.selected
    if (sel.length === 0) {
      this.selectionEl.textContent = t('hud.nothing_selected')
    } else if (sel.length === 1) {
      const e = this.world.get(sel[0]!)
      const name = e?.typeId
        ? t(
            e.building
              ? `building.${e.typeId}.name`
              : `unit.${e.typeId}.name`,
          )
        : t('hud.selected')
      const hp = e?.health ? ` — ${Math.ceil(e.health.current)}/${e.health.max}` : ''
      this.selectionEl.textContent = `${name}${hp}`
    } else {
      this.selectionEl.textContent = t('hud.units_selected', { count: sel.length })
    }

    this.updatePortrait()
    this.drawMinimap()

    if (this.showDebug) this.updateDebug()
  }

  private updateDebug(): void {
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length)
    const fps = 1000 / Math.max(avg, 0.0001)
    const stats = this.world.pathfinder.getStats()

    const rows: [string, string][] = [
      [t('debug.fps'), fps.toFixed(0)],
      [t('debug.entities'), String(this.world.entityCount)],
      [t('debug.sim_time'), `${this.sim.clock.now().toFixed(1)}s`],
      [t('debug.paths_frame'), `${stats.requestsThisFrame} (${stats.deferredThisFrame} deferred)`],
      [t('debug.nodes_total'), formatNumber(stats.totalNodesExpanded)],
      ['events pending', String(this.sim.events.pending)],
    ]

    for (const [name, ms] of Object.entries(this.sim.timings)) {
      rows.push([`  ${name}`, `${ms.toFixed(2)}ms`])
    }

    this.debugEl.innerHTML =
      `<div class="hud-debug-title">${t('debug.title')}</div>` +
      rows
        .map(
          ([k, v]) =>
            `<div class="hud-debug-row"><span>${k}</span><span>${v}</span></div>`,
        )
        .join('')
  }

  toggleDebug(): void {
    this.showDebug = !this.showDebug
    this.debugEl.hidden = !this.showDebug
  }

  /** Name of the current selection, shown in the portrait scroll. */
  private updatePortrait(): void {
    const sel = this.input.selected
    if (sel.length === 0) {
      this.portraitEl.textContent = ''
      return
    }
    const e = this.world.get(sel[0]!)
    if (!e?.typeId) {
      this.portraitEl.textContent = ''
      return
    }
    const key = e.building ? `building.${e.typeId}.name` : `unit.${e.typeId}.name`
    this.portraitEl.textContent = sel.length > 1 ? `${t(key)}\n×${sel.length}` : t(key)
  }

  /**
   * Minimap: terrain colours plus entity dots, drawn straight to a 2D canvas.
   *
   * Redrawn every frame at 128x128, which is cheap enough not to bother
   * throttling — the whole thing is 16k pixels and the terrain half only
   * changes when the cost grid revision does.
   */
  private terrainImage: ImageData | null = null
  private terrainImageRevision = -1

  private drawMinimap(): void {
    const ctx = this.minimapCanvas.getContext('2d')
    if (!ctx) return

    const size = this.minimapCanvas.width
    const grid = this.world.terrain
    const sx = grid.width / size
    const sy = grid.height / size

    // Terrain layer is cached until the grid changes.
    if (!this.terrainImage || this.terrainImageRevision !== grid.revision) {
      const img = ctx.createImageData(size, size)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const t = grid.getTerrain(Math.floor(x * sx), Math.floor(y * sy))
          const c = MINIMAP_COLORS[t] ?? 0x555555
          const i = (y * size + x) * 4
          img.data[i] = (c >> 16) & 0xff
          img.data[i + 1] = (c >> 8) & 0xff
          img.data[i + 2] = c & 0xff
          img.data[i + 3] = 255
        }
      }
      this.terrainImage = img
      this.terrainImageRevision = grid.revision
    }
    ctx.putImageData(this.terrainImage, 0, 0)

    // Entities on top.
    for (const e of this.world.ecs.with('position')) {
      const x = Math.floor(e.position.ne / sx)
      const y = Math.floor(e.position.se / sy)
      if (x < 0 || y < 0 || x >= size || y >= size) continue

      if (e.resourceSpot) {
        ctx.fillStyle = '#4a7a3a'
        ctx.fillRect(x, y, 1, 1)
        continue
      }
      const owner = e.owner !== undefined ? this.world.player(e.owner) : undefined
      if (!owner) continue
      ctx.fillStyle = `#${owner.color.toString(16).padStart(6, '0')}`
      const r = e.building ? 3 : 2
      ctx.fillRect(x - (r >> 1), y - (r >> 1), r, r)
    }
  }

  /** Rebuild static text after a language change. */
  relocalise(): void {
    this.build()
    this.debugEl.hidden = !this.showDebug
  }
}
