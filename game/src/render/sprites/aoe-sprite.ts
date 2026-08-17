/**
 * Runtime sprite: angle-bucketed, animated, player-coloured, with a shadow pass.
 *
 * ── How AoE2 gets its player colours, and how we reproduce it ────────────────
 *
 * The original engine stores sprites as palette-indexed images where indices
 * 16-23 are reserved: at draw time they are remapped to the owning player's
 * eight-shade colour ramp. That is why an AoE2 knight's tabard is team-coloured
 * but his armour is not, and why the team colour is *shaded* rather than flat.
 *
 * WebGL has no palettes, so the scrape already did the useful half of the work:
 * it split each frame into a base RGBA layer and a separate greyscale `_p`
 * mask holding just those reserved indices, with their shading intact.
 *
 * Reproducing the effect is then almost free, and needs no custom shader:
 *
 *     draw main layer            untinted
 *     draw player mask on top    tinted with the player's colour
 *
 * PixiJS `tint` is a multiply, so a greyscale mask multiplied by the team
 * colour yields exactly the shaded ramp the original produces. Both layers come
 * from atlases, so both batch — two draw calls for the whole army, not two per
 * unit.
 *
 * The alternative (a custom fragment shader doing the remap) is more faithful to
 * the original *mechanism* but produces the same pixels here and breaks
 * batching. Not worth it.
 *
 * ── Draw order within one unit ───────────────────────────────────────────────
 *
 *     shadow   soft, beneath everything, never tinted
 *     main     the sprite body
 *     player   team-coloured overlay
 *     damage   buildings only, cross-faded by remaining HP
 */

import { Container, Sprite, Texture, Rectangle } from 'pixi.js'
import type { AnimationManifest, SpriteManifest } from './types'
import { frameAt, resolveFrame } from './types'

/** Textures for one sprite's atlas pages, per layer. */
export interface SpriteTextures {
  main: Texture[]
  shadow?: Texture[]
  player?: Texture[]
  damage?: Texture[]
}

const LAYER_ORDER = ['shadow', 'main', 'player', 'damage'] as const
type LayerName = (typeof LAYER_ORDER)[number]

export class AoeSprite extends Container {
  private manifest: SpriteManifest
  private textures: SpriteTextures
  private layers = new Map<LayerName, Sprite>()

  /** Cached sub-textures, keyed `layer:frameIndex`. */
  private frameCache = new Map<string, Texture>()

  private currentAnim: AnimationManifest | null = null
  private animName = ''
  private elapsed = 0
  private angleIndex = 0
  private lastFrame = -1
  private lastMirrored = false

  /** Player colour applied to the `_p` mask. */
  playerColor = 0xffffff

  /** 0 = pristine, 1 = fully damaged. Drives the damage overlay's alpha. */
  damageLevel = 0

  /** Fires once when a non-looping animation reaches its last frame. */
  onAnimationEnd: (() => void) | null = null
  private endFired = false

  constructor(manifest: SpriteManifest, textures: SpriteTextures) {
    super()
    this.manifest = manifest
    this.textures = textures

    for (const name of LAYER_ORDER) {
      if (name !== 'main' && !textures[name]) continue
      const s = new Sprite()
      s.visible = false
      this.layers.set(name, s)
      this.addChild(s)
    }

    const shadow = this.layers.get('shadow')
    if (shadow) shadow.alpha = 0.45

    const first = Object.keys(manifest.animations)[0]
    if (first) this.play(first)
  }

  get animation(): string {
    return this.animName
  }

  /** Start an animation. Restarting the current one is a no-op unless forced. */
  play(name: string, force = false): void {
    if (this.animName === name && !force) return
    const anim = this.manifest.animations[name]
    if (!anim) return
    this.currentAnim = anim
    this.animName = name
    this.elapsed = 0
    this.lastFrame = -1
    this.endFired = false
  }

  hasAnimation(name: string): boolean {
    return name in this.manifest.animations
  }

  /**
   * Set facing from a world-space angle in radians.
   *
   * The bucket convention lives in coords.angleToBucket so the packer and the
   * runtime cannot disagree — see the note in types.ts.
   */
  setFacing(angleRadians: number): void {
    const anim = this.currentAnim
    if (!anim) return
    const tau = Math.PI * 2
    const norm = ((angleRadians % tau) + tau) % tau
    const idx = Math.round((norm / tau) * anim.angles) % anim.angles
    if (idx !== this.angleIndex) {
      this.angleIndex = idx
      this.lastFrame = -1 // force a re-resolve
    }
  }

  /** Advance the animation. `dt` in seconds — real time, not simulation time. */
  update(dt: number): void {
    const anim = this.currentAnim
    if (!anim) return

    this.elapsed += dt
    const frameIdx = frameAt(anim, this.elapsed)
    const { frame, mirrored } = resolveFrame(anim, this.angleIndex, frameIdx)

    if (!anim.loop && frameIdx === anim.frameCount - 1 && !this.endFired) {
      this.endFired = true
      this.onAnimationEnd?.()
    }

    if (frame === this.lastFrame && mirrored === this.lastMirrored) {
      this.applyDynamicState()
      return
    }
    this.lastFrame = frame
    this.lastMirrored = mirrored

    const info = this.manifest.frames[frame]
    if (!info) return

    for (const [name, sprite] of this.layers) {
      const tex = this.textureFor(name, frame)
      if (!tex) {
        sprite.visible = false
        continue
      }
      sprite.visible = true
      sprite.texture = tex

      // Anchor on the hotspot so the sprite's feet land on the world position.
      sprite.anchor.set(info.anchorX / info.w, info.anchorY / info.h)

      // Mirroring flips horizontally about the anchor, which is why the anchor
      // must be set first.
      sprite.scale.x = mirrored ? -1 : 1
    }

    this.applyDynamicState()
  }

  private applyDynamicState(): void {
    const player = this.layers.get('player')
    if (player) player.tint = this.playerColor

    const damage = this.layers.get('damage')
    if (damage) {
      damage.alpha = this.damageLevel
      damage.visible = this.damageLevel > 0.01 && damage.texture !== Texture.EMPTY
    }
  }

  private textureFor(layer: LayerName, frame: number): Texture | null {
    const key = `${layer}:${frame}`
    const cached = this.frameCache.get(key)
    if (cached) return cached

    const pages = this.textures[layer]
    const info = this.manifest.frames[frame]
    if (!pages || !info) return null

    const page = pages[info.page]
    if (!page) return null

    const tex = new Texture({
      source: page.source,
      frame: new Rectangle(info.x, info.y, info.w, info.h),
    })
    this.frameCache.set(key, tex)
    return tex
  }

  override destroy(): void {
    for (const tex of this.frameCache.values()) tex.destroy()
    this.frameCache.clear()
    super.destroy({ children: true })
  }
}

/**
 * Map a simulation entity state onto an animation name.
 *
 * The adopted AoE2 sim (src/aoe/core/entity.ts) uses a string union for state;
 * AoE2's sprite naming uses its own vocabulary. This is the translation table,
 * kept in one place so a missing animation degrades to idle rather than
 * throwing.
 */
export const STATE_TO_ANIMATION: Record<string, string> = {
  idle: 'idle',
  moving: 'walk',
  gathering: 'attackA',
  returning: 'walk',
  building: 'attackA',
  repairing: 'attackA',
  attacking: 'attackA',
  dead: 'die',
  corpse: 'decay',
  garrisoned: 'idle',
  training: 'idle',
  foundation: 'idle',
  transforming: 'idle',
  projectile: 'idle',
}

export function animationForState(sprite: AoeSprite, state: string): string {
  const want = STATE_TO_ANIMATION[state] ?? 'idle'
  return sprite.hasAnimation(want) ? want : 'idle'
}
