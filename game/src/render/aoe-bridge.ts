/**
 * Bridge: render the adopted Age of Kings simulation with our sprite stack.
 *
 * The two halves were built independently and disagree in three places. This
 * file is the whole of the reconciliation — nothing else in either half changes.
 *
 * 1. **Time.** Their simulation is a fixed 20 Hz deterministic tick
 *    (`Game.tick()`, TICK = 0.05). Our loop is variable-dt. Bridging with an
 *    accumulator keeps their determinism intact: we run whole ticks only, never
 *    a partial one, and carry the remainder to the next frame. Feeding them a
 *    variable dt would silently destroy the property their 73 tests rely on.
 *
 * 2. **Coordinates.** Their world is a flat x/y tile grid; ours is isometric
 *    ne/se. Both are tile units, so the mapping is x→ne, y→se and the isometric
 *    projection happens only at draw time. No simulation value is converted.
 *
 * 3. **Identity.** Their entities are class instances keyed by numeric id; our
 *    renderer wants display objects it owns. We keep a display map keyed by the
 *    same id and reconcile per frame — the render-entity pattern from
 *    docs/SYSTEMS.md §1, which is why the simulation stays headless.
 */

import { Container, Graphics, Sprite } from 'pixi.js'
import { depthOf, worldToScreen } from '../sim/coords'
import { AoeSprite, animationForState } from './sprites/aoe-sprite'
import type { SpriteLibrary } from './sprites/library'
import { screenYForElevation, type ElevationSource } from './elevation'
import { artFor } from './genie-art'
import type { SheetLibrary } from './sheets'
import type { BuildingSpriteFactory } from './building-sprites'
import { conditionFor } from './building-sprites'

/** Structural view of the adopted simulation, so this file needs no import
 *  from src/aoe and the two stay decoupled. */
export interface SimEntity {
  id: number
  owner: number
  typeId: number
  x: number
  y: number
  hp: number
  state: string
}

export interface SimMap {
  w: number
  h: number
  terrain: Uint8Array
  elevation: Uint8Array
  elevationAt(x: number, y: number): number
}

export interface SimGame {
  map: SimMap
  entities: Map<number, SimEntity>
  players: Array<{ civId: number }>
  visibility: Uint8Array[]
  time: number
  tickCount: number
  tick(): void
  defOf(e: SimEntity): { name?: string; radius?: number[]; hp: number }
}

/** Their fixed tick length. Must match src/aoe/core/game.ts. */
export const SIM_TICK = 0.05

/**
 * Advance the simulation by real elapsed time without breaking determinism.
 *
 * Whole ticks only; the remainder carries. The tick budget caps how far a
 * stalled frame can catch up — without it, returning to a backgrounded tab
 * would run thousands of ticks in one frame and lock the page.
 */
export class FixedTicker {
  private accumulator = 0
  private maxTicksPerFrame = 8

  /** Ticks actually run last frame, for the debug overlay. */
  lastTicks = 0

  advance(game: SimGame, realDelta: number, speed = 1): void {
    this.accumulator += Math.min(realDelta, 0.25) * speed
    let n = 0
    while (this.accumulator >= SIM_TICK && n < this.maxTicksPerFrame) {
      game.tick()
      this.accumulator -= SIM_TICK
      n++
    }
    // If we hit the cap the simulation is behind real time; drop the backlog
    // rather than accumulating a debt that can never be repaid.
    if (n === this.maxTicksPerFrame) this.accumulator = 0
    this.lastTicks = n
  }
}

/** Terrain adapter: presents their GameMap through the ElevationSource shape. */
export class SimTerrainSource implements ElevationSource {
  readonly width: number
  readonly height: number
  revision = 0

  private map: SimMap
  private tileFor: (terrain: number, ne: number, se: number) => [number, number]

  constructor(map: SimMap, tileFor: (terrain: number, ne: number, se: number) => [number, number]) {
    this.map = map
    this.width = map.w
    this.height = map.h
    this.tileFor = tileFor
  }

  tileAt(ne: number, se: number): [number, number] {
    const i = se * this.map.w + ne
    return this.tileFor(this.map.terrain[i] ?? 0, ne, se)
  }

  elevationAt(ne: number, se: number): number {
    return this.map.elevationAt(ne, se)
  }
}

interface Display {
  root: Container
  sprite: AoeSprite | null
  /** Buildings, trees, mines and animals: one static sprite, no animation. */
  staticSprite: Sprite | null
  fallback: Graphics | null
  lastState: string
  lastHp: number
}

export interface BridgeOptions {
  /** Their numeric type id -> Genie name, e.g. 'VMBAS'. */
  nameOf: (typeId: number) => string
  /** Player colours by index. */
  playerColor: (owner: number) => number
  /** Local player, for fog of war. -1 disables fog. */
  localPlayer: number
  /** Optional art sources. Any absent source degrades to a marker. */
  sheets?: SheetLibrary | null
  buildings?: BuildingSpriteFactory | null
}

export class SimRenderBridge {
  readonly container = new Container()
  readonly fogContainer = new Container()

  private game: SimGame
  private sprites: SpriteLibrary | null
  private opts: BridgeOptions
  private displays = new Map<number, Display>()
  private fog = new Graphics()

  constructor(game: SimGame, sprites: SpriteLibrary | null, opts: BridgeOptions) {
    this.game = game
    this.sprites = sprites
    this.opts = opts
    this.container.sortableChildren = true
    this.fogContainer.addChild(this.fog)
  }

  get entityCount(): number {
    return this.displays.size
  }

  /** Reconcile display objects against the simulation. */
  sync(): void {
    const seen = new Set<number>()

    for (const e of this.game.entities.values()) {
      if (e.state === 'dead') continue
      seen.add(e.id)

      let d = this.displays.get(e.id)
      if (!d) {
        d = this.create(e)
        this.displays.set(e.id, d)
        this.container.addChild(d.root)
      }
      this.update(e, d)
    }

    for (const [id, d] of this.displays) {
      if (seen.has(id)) continue
      d.root.destroy({ children: true })
      this.displays.delete(id)
    }
  }

  private create(e: SimEntity): Display {
    const root = new Container()
    const d: Display = { root, sprite: null, staticSprite: null, fallback: null, lastState: '', lastHp: -1 }

    const art = artFor(this.opts.nameOf(e.typeId))

    if (art?.kind === 'unit' && this.sprites) {
      const s = this.sprites.createIfReady(art.sprite)
      if (s) {
        s.scale.set(0.5)
        s.playerColor = this.opts.playerColor(e.owner)
        d.sprite = s
        root.addChild(s)
      }
    } else if (art?.kind === 'building' && this.opts.buildings) {
      const def = this.game.defOf(e)
      const r = def.radius ?? [1, 1]
      const b = this.opts.buildings.create(
        art.type,
        Math.max(1, Math.round((r[0] ?? 1) * 2)),
        Math.max(1, Math.round((r[1] ?? 1) * 2)),
        conditionFor(e.hp / Math.max(1, def.hp)),
      )
      if (b) {
        d.staticSprite = b
        root.addChild(b)
      }
    } else if (art?.kind === 'sheet' && this.opts.sheets) {
      const spr = this.opts.sheets.sprite(art.sheet, art.row, art.col, art.width)
      if (spr) {
        d.staticSprite = spr
        root.addChild(spr)
      }
    }

    if (!d.sprite && !d.staticSprite) {
      // Anything without art still has to be visible, or debugging a missing
      // sprite means staring at an empty patch of grass.
      const g = new Graphics()
      const c = e.owner < 0 ? 0x6d8a4a : this.opts.playerColor(e.owner)
      g.ellipse(0, 0, 9, 5).fill({ color: 0x000000, alpha: 0.25 })
      g.circle(0, -8, 7).fill({ color: c }).stroke({ width: 1.5, color: 0x000000, alpha: 0.4 })
      d.fallback = g
      root.addChild(g)
    }

    return d
  }

  private update(e: SimEntity, d: Display): void {
    // Their x/y are tile units, same as our ne/se — no conversion, only
    // projection.
    const p = worldToScreen({ ne: e.x, se: e.y })
    const elev = this.game.map.elevationAt(Math.floor(e.x), Math.floor(e.y))

    d.root.position.set(p.x, p.y + screenYForElevation(elev))
    // Depth from world position, never screen y: elevation must not reorder.
    d.root.zIndex = depthOf({ ne: e.x, se: e.y })

    if (d.sprite) {
      if (e.state !== d.lastState) {
        d.sprite.play(animationForState(d.sprite, e.state))
        d.lastState = e.state
      }
    }
  }

  /** Advance sprite animations on real time. */
  animate(dt: number): void {
    for (const d of this.displays.values()) d.sprite?.update(dt)
  }

  /**
   * Fog of war, drawn from the simulation's own per-player visibility grid
   * (0 unexplored, 1 explored, 2 visible).
   *
   * Unexplored is opaque black; explored-but-not-visible is a dim veil. That
   * two-tier treatment is what makes scouting feel like it matters — you keep
   * the map you have seen, but not what is happening on it now.
   */
  drawFog(): void {
    const local = this.opts.localPlayer
    if (local < 0) {
      this.fog.clear()
      return
    }
    const vis = this.game.visibility[local]
    if (!vis) return

    const map = this.game.map
    this.fog.clear()

    for (let se = 0; se < map.h; se++) {
      for (let ne = 0; ne < map.w; ne++) {
        const v = vis[se * map.w + ne] ?? 0
        if (v === 2) continue

        const elev = map.elevationAt(ne, se)
        const p = worldToScreen({ ne: ne + 0.5, se: se + 0.5 })
        const y = p.y + screenYForElevation(elev)

        this.fog
          .poly([p.x - 32, y, p.x, y - 16, p.x + 32, y, p.x, y + 16])
          .fill({ color: 0x000000, alpha: v === 0 ? 0.92 : 0.42 })
      }
    }
  }
}
