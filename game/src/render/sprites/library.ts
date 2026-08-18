/**
 * Sprite library: loads a packed manifest and hands out AoeSprite instances.
 *
 * Two things matter here.
 *
 * 1. **Atlas pages are loaded once and shared.** Every AoeSprite built from the
 *    same manifest entry references the same GPU textures, so 200 knights on
 *    screen are still a handful of draw calls.
 *
 * 2. **Missing art degrades, it does not throw.** Until the real AoE2 scrape is
 *    packed in, `get()` returns null and the caller falls back to the
 *    placeholder shapes in entity-renderer.ts. That is what lets the game stay
 *    runnable while art lands piecemeal — one unit at a time, if need be.
 */

import { Assets, Texture } from 'pixi.js'
import { AoeSprite, type SpriteTextures } from './aoe-sprite'
import type { SpriteLibraryManifest, SpriteManifest } from './types'

export class SpriteLibrary {
  private manifest: SpriteLibraryManifest | null = null
  private textures = new Map<string, SpriteTextures>()
  private baseUrl = ''

  /** Sprite ids that were requested but are not in the manifest. */
  readonly missing = new Set<string>()

  get loaded(): boolean {
    return this.manifest !== null
  }

  get spriteCount(): number {
    return this.manifest ? Object.keys(this.manifest.sprites).length : 0
  }

  /**
   * Load a packed library. Resolves to false (rather than throwing) when no
   * manifest is present, so the game boots fine with no art at all.
   */
  async load(baseUrl: string): Promise<boolean> {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    try {
      const res = await fetch(`${this.baseUrl}/manifest.json`)
      if (!res.ok) return false
      const manifest = (await res.json()) as SpriteLibraryManifest
      if (manifest.version !== 1) {
        console.warn(`sprite manifest version ${manifest.version} not understood; ignoring`)
        return false
      }
      this.manifest = manifest
      return true
    } catch {
      return false
    }
  }

  /** Ensure a sprite's atlas pages are on the GPU. */
  private async ensureTextures(def: SpriteManifest): Promise<SpriteTextures> {
    const existing = this.textures.get(def.id)
    if (existing) return existing

    const loadPages = async (files: string[] | undefined): Promise<Texture[] | undefined> => {
      if (!files || files.length === 0) return undefined
      return Promise.all(files.map((f) => Assets.load<Texture>(`${this.baseUrl}/${f}`)))
    }

    const textures: SpriteTextures = {
      main: (await loadPages(def.pages.main)) ?? [],
      shadow: await loadPages(def.pages.shadow),
      player: await loadPages(def.pages.player),
      damage: await loadPages(def.pages.damage),
    }

    this.textures.set(def.id, textures)
    return textures
  }

  /** Preload a set of sprites so the first frame does not stutter. */
  async preload(ids: string[]): Promise<void> {
    if (!this.manifest) return
    await Promise.all(
      ids.map(async (id) => {
        const def = this.manifest!.sprites[id]
        if (def) await this.ensureTextures(def)
        else this.missing.add(id)
      }),
    )
  }

  /**
   * Build a sprite instance. Returns null when the art is not available,
   * which callers treat as "fall back to placeholder".
   */
  async create(id: string): Promise<AoeSprite | null> {
    if (!this.manifest) return null
    const def = this.manifest.sprites[id]
    if (!def) {
      this.missing.add(id)
      return null
    }
    const textures = await this.ensureTextures(def)
    if (textures.main.length === 0) return null
    return new AoeSprite(def, textures)
  }

  /** Synchronous variant for sprites already preloaded. */
  createIfReady(id: string): AoeSprite | null {
    if (!this.manifest) return null
    const def = this.manifest.sprites[id]
    const textures = this.textures.get(id)
    if (!def || !textures || textures.main.length === 0) return null
    return new AoeSprite(def, textures)
  }

  listSprites(): string[] {
    return this.manifest ? Object.keys(this.manifest.sprites) : []
  }

  /** Diagnostic for the debug overlay. */
  report(): string {
    if (!this.manifest) return 'no sprite manifest (placeholder art)'
    const loaded = this.textures.size
    const total = this.spriteCount
    const miss = this.missing.size
    return `sprites ${loaded}/${total} loaded${miss ? `, ${miss} missing` : ''}`
  }
}
