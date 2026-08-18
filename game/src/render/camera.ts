/**
 * Camera: pan, zoom, and screen<->world conversion.
 *
 * In PixiJS a camera is just a Container transform, which is why this is 100
 * lines rather than openage's 1,166 (libopenage/renderer/camera/). We inherit
 * the useful part — the coordinate math — from src/sim/coords.ts and let the
 * scene graph do the rest.
 */

import type { Container } from 'pixi.js'
import { screenToWorld, worldToScreen, type WorldPos } from '../sim/coords'

export interface CameraBounds {
  minNe: number
  maxNe: number
  minSe: number
  maxSe: number
}

export class Camera {
  /** World position at the centre of the viewport. */
  center: WorldPos = { ne: 0, se: 0 }
  zoom = 1

  minZoom = 0.35
  maxZoom = 3

  private viewportW = 0
  private viewportH = 0
  private bounds: CameraBounds | null = null

  setViewport(w: number, h: number): void {
    this.viewportW = w
    this.viewportH = h
  }

  setBounds(b: CameraBounds): void {
    this.bounds = b
  }

  panByScreen(dxPx: number, dyPx: number): void {
    // Convert a screen-space drag into a world-space delta. Dividing by zoom
    // keeps the grab point under the cursor at every zoom level.
    const delta = screenToWorld({ x: dxPx / this.zoom, y: dyPx / this.zoom })
    this.center.ne -= delta.ne
    this.center.se -= delta.se
    this.clamp()
  }

  panByWorld(dne: number, dse: number): void {
    this.center.ne += dne
    this.center.se += dse
    this.clamp()
  }

  /** Zoom about a screen point, so the world under the cursor stays put. */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const before = this.screenToWorld(screenX, screenY)
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor))
    const after = this.screenToWorld(screenX, screenY)
    this.center.ne += before.ne - after.ne
    this.center.se += before.se - after.se
    this.clamp()
  }

  centerOn(pos: WorldPos): void {
    this.center = { ...pos }
    this.clamp()
  }

  /** Viewport pixel coordinates -> world. */
  screenToWorld(screenX: number, screenY: number): WorldPos {
    const c = worldToScreen(this.center)
    const x = (screenX - this.viewportW / 2) / this.zoom + c.x
    const y = (screenY - this.viewportH / 2) / this.zoom + c.y
    return screenToWorld({ x, y })
  }

  /** World -> viewport pixel coordinates. */
  worldToScreen(pos: WorldPos): { x: number; y: number } {
    const c = worldToScreen(this.center)
    const p = worldToScreen(pos)
    return {
      x: (p.x - c.x) * this.zoom + this.viewportW / 2,
      y: (p.y - c.y) * this.zoom + this.viewportH / 2,
    }
  }

  /** Push the current transform onto the world container. */
  apply(stage: Container): void {
    const c = worldToScreen(this.center)
    stage.scale.set(this.zoom)
    stage.position.set(
      this.viewportW / 2 - c.x * this.zoom,
      this.viewportH / 2 - c.y * this.zoom,
    )
  }

  /** World-space rectangle currently visible, padded for safety. */
  visibleWorldBounds(pad = 2): { minNe: number; maxNe: number; minSe: number; maxSe: number } {
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(this.viewportW, 0),
      this.screenToWorld(0, this.viewportH),
      this.screenToWorld(this.viewportW, this.viewportH),
    ]
    return {
      minNe: Math.min(...corners.map((c) => c.ne)) - pad,
      maxNe: Math.max(...corners.map((c) => c.ne)) + pad,
      minSe: Math.min(...corners.map((c) => c.se)) - pad,
      maxSe: Math.max(...corners.map((c) => c.se)) + pad,
    }
  }

  private clamp(): void {
    if (!this.bounds) return
    const b = this.bounds
    this.center.ne = Math.min(Math.max(this.center.ne, b.minNe), b.maxNe)
    this.center.se = Math.min(Math.max(this.center.se, b.minSe), b.maxSe)
  }
}
