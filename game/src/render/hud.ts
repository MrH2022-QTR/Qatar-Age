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

const RESOURCES = ['food', 'wood', 'stone', 'pearls'] as const

export class Hud {
  private root: HTMLElement
  private resourceEls = new Map<string, HTMLElement>()
  private popEl!: HTMLElement
  private ageEl!: HTMLElement
  private selectionEl!: HTMLElement
  private debugEl!: HTMLElement

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

    // ── Top bar: resources, population, age ──────────────────────────────────
    const top = document.createElement('div')
    top.className = 'hud-top'

    for (const kind of RESOURCES) {
      const item = document.createElement('div')
      item.className = 'hud-resource'

      const swatch = document.createElement('span')
      swatch.className = `hud-swatch hud-swatch-${kind}`

      const label = document.createElement('span')
      label.className = 'hud-resource-label'
      label.textContent = t(`resource.${kind}`)

      const value = document.createElement('span')
      value.className = 'hud-resource-value'
      value.textContent = '0'

      item.append(swatch, label, value)
      top.appendChild(item)
      this.resourceEls.set(kind, value)
    }

    const spacer = document.createElement('div')
    spacer.className = 'hud-spacer'
    top.appendChild(spacer)

    this.popEl = document.createElement('div')
    this.popEl.className = 'hud-stat'
    top.appendChild(this.popEl)

    this.ageEl = document.createElement('div')
    this.ageEl.className = 'hud-stat'
    top.appendChild(this.ageEl)

    // ── Bottom bar: selection and controls help ──────────────────────────────
    const bottom = document.createElement('div')
    bottom.className = 'hud-bottom'

    this.selectionEl = document.createElement('div')
    this.selectionEl.className = 'hud-selection'
    bottom.appendChild(this.selectionEl)

    const help = document.createElement('div')
    help.className = 'hud-help'
    help.textContent = t('help.controls')
    bottom.appendChild(help)

    // ── Debug overlay ────────────────────────────────────────────────────────
    this.debugEl = document.createElement('div')
    this.debugEl.className = 'hud-debug'
    this.debugEl.hidden = true

    this.root.append(top, bottom, this.debugEl)
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

  /** Rebuild static text after a language change. */
  relocalise(): void {
    this.build()
    this.debugEl.hidden = !this.showDebug
  }
}
