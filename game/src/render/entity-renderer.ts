/**
 * Entity rendering — the simulation/display seam.
 *
 * This is openage's render-entity pattern (libopenage/renderer/stages/render_entity.h),
 * kept even though we are single-threaded. docs/SYSTEMS.md §1 argues for keeping
 * it: it is the discipline that stops gameplay code touching display objects,
 * and it is why src/sim runs headless in Node for tests and for the pathfinder
 * fuzz harness.
 *
 * The contract: this file reads simulation components and writes PixiJS
 * properties. Nothing flows the other way. The simulation's `sprite` component
 * holds an opaque handle it never dereferences.
 *
 * Placeholder art throughout — units are shaded discs, buildings are extruded
 * diamonds. Real sprites replace `createDisplay` and the angle-bucket lookup;
 * the update path is unchanged.
 */

import { Container, Graphics } from 'pixi.js'
import type { Entity } from '../sim/components'
import { depthOf, worldToScreen, HALF_H } from '../sim/coords'
import { parseColor } from '../data'
import type { GameWorld } from '../sim/world'

interface Display {
  root: Container
  body: Graphics
  selectionRing: Graphics
  healthBar: Graphics
  lastHealth: number
  lastSelected: boolean
}

export class EntityRenderer {
  readonly container = new Container()

  private displays = new Map<number, Display>()
  private world: GameWorld

  constructor(world: GameWorld) {
    this.world = world
    // Painter's algorithm: PixiJS sorts children by zIndex, which we set from
    // the isometric depth in coords.depthOf.
    this.container.sortableChildren = true
  }

  sync(): void {
    const seen = new Set<number>()

    for (const e of this.world.ecs.with('position')) {
      seen.add(e.id)
      let d = this.displays.get(e.id)
      if (!d) {
        d = this.createDisplay(e)
        this.displays.set(e.id, d)
        this.container.addChild(d.root)
      }
      this.updateDisplay(e, d)
    }

    // Remove displays whose entities are gone.
    for (const [id, d] of this.displays) {
      if (seen.has(id)) continue
      d.root.destroy({ children: true })
      this.displays.delete(id)
    }
  }

  private createDisplay(e: Entity): Display {
    const root = new Container()
    const body = new Graphics()
    const selectionRing = new Graphics()
    const healthBar = new Graphics()

    root.addChild(selectionRing, body, healthBar)

    const d: Display = {
      root,
      body,
      selectionRing,
      healthBar,
      lastHealth: -1,
      lastSelected: false,
    }
    this.drawBody(e, d)
    return d
  }

  private drawBody(e: Entity, d: Display): void {
    const g = d.body
    g.clear()

    if (e.resourceSpot) {
      const colors: Record<string, number> = {
        wood: 0x3f6b3a,
        stone: 0x8d8d8d,
        food: 0xc4553f,
        pearls: 0xf0ead6,
      }
      const c = colors[e.resourceSpot.kind] ?? 0xffffff
      // Squat diamond so resource nodes read as part of the ground plane.
      g.poly([0, -10, 14, 0, 0, 10, -14, 0]).fill({ color: c })
      g.poly([0, -10, 14, 0, 0, 10, -14, 0]).stroke({ width: 1, color: 0x000000, alpha: 0.35 })
      return
    }

    if (e.building && e.typeId) {
      const player = e.owner !== undefined ? this.world.player(e.owner) : undefined
      const def = player?.data.building(e.typeId)
      const base = def ? parseColor(def.debugColor) : 0xcccccc
      const under = e.building.progress < 1

      // Footprint diamond plus a simple extrusion, so buildings read as solid.
      const halfW = ((e.building.widthNe + e.building.heightSe) / 2) * 32
      const halfH = ((e.building.widthNe + e.building.heightSe) / 2) * 16
      const height = Math.max(18, (e.building.widthNe + e.building.heightSe) * 6)

      // Walls
      g.poly([-halfW, 0, -halfW, -height, 0, halfH - height, 0, halfH])
        .fill({ color: darken(base, 0.72), alpha: under ? 0.55 : 1 })
      g.poly([halfW, 0, halfW, -height, 0, halfH - height, 0, halfH])
        .fill({ color: darken(base, 0.86), alpha: under ? 0.55 : 1 })
      // Roof
      g.poly([0, -halfH - height, halfW, -height, 0, halfH - height, -halfW, -height])
        .fill({ color: base, alpha: under ? 0.6 : 1 })
      g.poly([0, -halfH - height, halfW, -height, 0, halfH - height, -halfW, -height])
        .stroke({ width: 1, color: 0x000000, alpha: 0.3 })

      if (player) {
        // Player colour flag, so ownership is readable at a glance.
        g.rect(-3, -halfH - height - 12, 6, 12).fill({ color: player.color })
      }
      return
    }

    // Units: a disc with a facing wedge.
    const player = e.owner !== undefined ? this.world.player(e.owner) : undefined
    const unitDef = e.typeId && player ? player.data.unit(e.typeId) : undefined
    const base = unitDef ? parseColor(unitDef.debugColor) : 0xffffff
    const r = Math.max(6, (e.collider?.radius ?? 0.3) * 30)

    // Ground shadow grounds the sprite in the isometric plane.
    g.ellipse(0, 2, r * 0.9, r * 0.45).fill({ color: 0x000000, alpha: 0.22 })
    g.circle(0, -r * 0.7, r).fill({ color: base })
    g.circle(0, -r * 0.7, r).stroke({ width: 1.5, color: 0x000000, alpha: 0.35 })

    if (player) {
      g.circle(0, -r * 0.7, r * 0.42).fill({ color: player.color })
    }
  }

  private updateDisplay(e: Entity, d: Display): void {
    if (!e.position) return

    const p = worldToScreen(e.position)
    d.root.position.set(p.x, p.y)
    d.root.zIndex = depthOf(e.position)

    // Facing wedge, rotated to the unit's heading. Cheap stand-in for the
    // angle-bucketed sprite sheets a real build would use.
    if (e.facing !== undefined && e.movement) {
      d.body.rotation = 0 // body art is symmetric for now
    }

    // Selection ring — only redrawn when selection actually changes.
    const selected = e.selected === true
    if (selected !== d.lastSelected) {
      d.selectionRing.clear()
      if (selected) {
        const r = (e.selectable?.radius ?? 0.4) * 34
        d.selectionRing
          .ellipse(0, 2, r, r * 0.5)
          .stroke({ width: 2, color: 0x7fffa0, alpha: 0.95 })
      }
      d.lastSelected = selected
    }

    // Health bar — only when damaged, and only redrawn on change.
    if (e.health && e.health.current !== d.lastHealth) {
      d.healthBar.clear()
      const frac = e.health.current / e.health.max
      if (frac < 1) {
        const w = 26
        const yOff = e.building ? -60 : -30
        d.healthBar.rect(-w / 2, yOff, w, 4).fill({ color: 0x000000, alpha: 0.6 })
        d.healthBar
          .rect(-w / 2, yOff, w * frac, 4)
          .fill({ color: frac > 0.5 ? 0x5cd65c : frac > 0.25 ? 0xd6c35c : 0xd65c5c })
      }
      d.lastHealth = e.health.current
    }

    // Construction progress redraws the body as it fills in.
    if (e.building && e.renderDirty) {
      this.drawBody(e, d)
    }

    e.renderDirty = undefined
  }

  /** Debug: draw each moving unit's remaining path. */
  drawPaths(g: Graphics): void {
    g.clear()
    for (const e of this.world.ecs.with('position', 'movement')) {
      if (e.movement.path.length === 0) continue
      const start = worldToScreen(e.position)
      g.moveTo(start.x, start.y - HALF_H / 2)
      for (const wp of e.movement.path) {
        const s = worldToScreen(wp)
        g.lineTo(s.x, s.y - HALF_H / 2)
      }
    }
    g.stroke({ width: 1, color: 0x66ccff, alpha: 0.55 })
  }
}

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor)
  const g = Math.round(((color >> 8) & 0xff) * factor)
  const b = Math.round((color & 0xff) * factor)
  return (r << 16) | (g << 8) | b
}
