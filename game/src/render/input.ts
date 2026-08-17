/**
 * Input: selection, orders, and camera control.
 *
 * The one idea borrowed from openage here is the input *context stack*
 * (libopenage/input/input_context.h). docs/SYSTEMS.md §10 notes that openage's
 * input architecture is better than its GUI architecture: the top context gets
 * first refusal on each event and may consume it or pass it down. That is
 * exactly how you want "Escape cancels placement, or closes the menu, or
 * deselects" to behave, and it is about a hundred lines.
 */

import { Container, Graphics } from 'pixi.js'
import type { Entity, EntityId } from '../sim/components'
import { distance, type WorldPos } from '../sim/coords'
import { issueMove, stopEntity } from '../sim/systems/movement'
import type { GameWorld } from '../sim/world'
import type { Camera } from './camera'

export interface InputContext {
  name: string
  /** Return true to consume the event. */
  onPointerDown?(x: number, y: number, button: number): boolean
  onPointerUp?(x: number, y: number, button: number): boolean
  onPointerMove?(x: number, y: number): boolean
  onKeyDown?(key: string): boolean
}

export class InputManager {
  private contexts: InputContext[] = []

  push(ctx: InputContext): void {
    this.contexts.push(ctx)
  }

  pop(): InputContext | undefined {
    return this.contexts.pop()
  }

  remove(name: string): void {
    this.contexts = this.contexts.filter((c) => c.name !== name)
  }

  pointerDown(x: number, y: number, button: number): boolean {
    return this.walk((c) => c.onPointerDown?.(x, y, button) ?? false)
  }

  pointerMove(x: number, y: number): boolean {
    return this.walk((c) => c.onPointerMove?.(x, y) ?? false)
  }

  pointerUp(x: number, y: number, button: number): boolean {
    return this.walk((c) => c.onPointerUp?.(x, y, button) ?? false)
  }

  keyDown(key: string): boolean {
    return this.walk((c) => c.onKeyDown?.(key) ?? false)
  }

  /** Top-down: the first context to return true consumes the event. */
  private walk(fn: (ctx: InputContext) => boolean): boolean {
    for (let i = this.contexts.length - 1; i >= 0; i--) {
      if (fn(this.contexts[i]!)) return true
    }
    return false
  }
}

export interface GameInputOptions {
  world: GameWorld
  camera: Camera
  canvas: HTMLCanvasElement
  overlay: Container
  localPlayerId: number
  onSelectionChanged?: (ids: EntityId[]) => void
}

/** Below this drag distance a pointer-up counts as a click, not a box select. */
const DRAG_THRESHOLD = 5

export class GameInput implements InputContext {
  readonly name = 'game'

  private world: GameWorld
  private camera: Camera
  private canvas: HTMLCanvasElement
  private localPlayerId: number
  private onSelectionChanged?: (ids: EntityId[]) => void

  private selectionBox = new Graphics()
  private dragStart: { x: number; y: number } | null = null
  private dragging = false
  private panning = false
  private lastPan = { x: 0, y: 0 }
  private keys = new Set<string>()

  selected: EntityId[] = []

  constructor(opts: GameInputOptions) {
    this.world = opts.world
    this.camera = opts.camera
    this.canvas = opts.canvas
    this.localPlayerId = opts.localPlayerId
    this.onSelectionChanged = opts.onSelectionChanged
    opts.overlay.addChild(this.selectionBox)
  }

  onPointerDown(x: number, y: number, button: number): boolean {
    if (button === 0) {
      this.dragStart = { x, y }
      this.dragging = false
      return true
    }
    if (button === 2) {
      this.issueOrder(x, y)
      return true
    }
    if (button === 1) {
      this.panning = true
      this.lastPan = { x, y }
      return true
    }
    return false
  }

  onPointerMove(x: number, y: number): boolean {
    if (this.panning) {
      this.camera.panByScreen(x - this.lastPan.x, y - this.lastPan.y)
      this.lastPan = { x, y }
      return true
    }
    if (this.dragStart) {
      const dx = x - this.dragStart.x
      const dy = y - this.dragStart.y
      if (!this.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) this.dragging = true
      if (this.dragging) {
        this.selectionBox.clear()
        this.selectionBox
          .rect(
            Math.min(this.dragStart.x, x),
            Math.min(this.dragStart.y, y),
            Math.abs(dx),
            Math.abs(dy),
          )
          .fill({ color: 0x7fffa0, alpha: 0.12 })
          .stroke({ width: 1.5, color: 0x7fffa0, alpha: 0.9 })
        return true
      }
    }
    return false
  }

  onPointerUp(x: number, y: number, button: number): boolean {
    if (button === 1) {
      this.panning = false
      return true
    }
    if (button !== 0 || !this.dragStart) return false

    if (this.dragging) {
      this.boxSelect(this.dragStart.x, this.dragStart.y, x, y)
    } else {
      this.clickSelect(x, y)
    }

    this.selectionBox.clear()
    this.dragStart = null
    this.dragging = false
    return true
  }

  onKeyDown(key: string): boolean {
    switch (key) {
      case 'Escape':
        this.clearSelection()
        return true
      case 's':
      case 'S':
        for (const id of this.selected) stopEntity(this.world, id)
        return true
      default:
        return false
    }
  }

  setKey(key: string, down: boolean): void {
    if (down) this.keys.add(key)
    else this.keys.delete(key)
  }

  /** Edge and keyboard scrolling, called once per frame. */
  updateCameraScroll(dt: number): void {
    const speed = 14 * dt
    let dne = 0
    let dse = 0
    if (this.keys.has('ArrowUp') || this.keys.has('w')) {
      dne -= speed
      dse -= speed
    }
    if (this.keys.has('ArrowDown') || this.keys.has('s')) {
      dne += speed
      dse += speed
    }
    if (this.keys.has('ArrowLeft') || this.keys.has('a')) {
      dne -= speed
      dse += speed
    }
    if (this.keys.has('ArrowRight') || this.keys.has('d')) {
      dne += speed
      dse -= speed
    }
    if (dne !== 0 || dse !== 0) this.camera.panByWorld(dne, dse)
  }

  private clickSelect(x: number, y: number): void {
    const world = this.camera.screenToWorld(x, y)
    const hit = this.world.nearest(world, 1.5, (e) => this.isSelectable(e))
    this.clearSelection()
    if (hit) {
      hit.selected = true
      this.selected = [hit.id]
    }
    this.onSelectionChanged?.(this.selected)
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number): void {
    this.clearSelection()

    // Selection is done in screen space so the box means what it looks like.
    // Converting the box to world space would give a rotated quad, which is
    // both harder and not what the player drew.
    const minX = Math.min(x0, x1)
    const maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1)
    const maxY = Math.max(y0, y1)

    const picked: EntityId[] = []
    for (const e of this.world.ecs.with('position', 'selectable')) {
      if (!this.isSelectable(e)) continue
      const s = this.camera.worldToScreen(e.position)
      if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) {
        e.selected = true
        picked.push(e.id)
      }
    }

    // Prefer units over buildings: dragging a box across a base should select
    // the army, not the town centre.
    const units = picked.filter((id) => !this.world.get(id)?.building)
    if (units.length > 0 && units.length !== picked.length) {
      for (const id of picked) {
        if (units.includes(id)) continue
        const e = this.world.get(id)
        if (e) e.selected = undefined
      }
      this.selected = units
    } else {
      this.selected = picked
    }

    this.onSelectionChanged?.(this.selected)
  }

  private isSelectable(e: Entity): boolean {
    if (!e.selectable) return false
    // Own units and buildings only; resource nodes are inspectable but not
    // commandable, so they are excluded from drag selection.
    return e.owner === this.localPlayerId
  }

  private clearSelection(): void {
    for (const id of this.selected) {
      const e = this.world.get(id)
      if (e) e.selected = undefined
    }
    this.selected = []
  }

  /**
   * Right-click order. Player-issued, so these path requests bypass the
   * pathfinder's frame budget (docs/PATHFINDING_NOTES.md §7.5).
   */
  private issueOrder(x: number, y: number): void {
    if (this.selected.length === 0) return
    const target = this.camera.screenToWorld(x, y)

    // Spread destinations so a group does not all converge on one point and
    // fight the separation steering. A ring per 8 units keeps formations tidy.
    const spread = this.selected.length > 1
    this.selected.forEach((id, i) => {
      let goal: WorldPos = target
      if (spread) {
        const ring = Math.floor(i / 8)
        const idxInRing = i % 8
        const angle = (idxInRing / 8) * Math.PI * 2
        const radius = 0.8 + ring * 0.9
        goal = {
          ne: target.ne + Math.cos(angle) * radius,
          se: target.se + Math.sin(angle) * radius,
        }
      }
      issueMove(this.world, id, clampToMap(this.world, goal), 'player')
    })
  }

  /** Distance from a world point to the nearest selected unit — used by the HUD. */
  distanceToSelection(pos: WorldPos): number {
    let best = Infinity
    for (const id of this.selected) {
      const e = this.world.get(id)
      if (!e?.position) continue
      best = Math.min(best, distance(pos, e.position))
    }
    return best
  }
}

function clampToMap(world: GameWorld, p: WorldPos): WorldPos {
  return {
    ne: Math.min(Math.max(p.ne, 0), world.terrain.width - 0.01),
    se: Math.min(Math.max(p.se, 0), world.terrain.height - 0.01),
  }
}
