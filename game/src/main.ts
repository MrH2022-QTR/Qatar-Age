/**
 * Entry point: assemble the simulation, the renderer, and the frame loop.
 *
 * The loop mirrors docs/SYSTEMS.md §2. openage runs three threads — a time
 * loop, a presenter, and the simulation — and decouples them through render
 * entities. In a browser we are single-threaded, so that whole arrangement
 * collapses into one requestAnimationFrame callback:
 *
 *     sim.step(dt)      advance the world
 *     renderers.sync()  mirror it into display objects
 *     app.render()      draw
 *
 * The delta clamp lives in sim/time.ts and matters more here than it does
 * natively: a backgrounded tab throttles requestAnimationFrame, so without it
 * the first frame back carries a multi-second delta and the game lurches.
 */

import { Application, Container, Graphics } from 'pixi.js'

import { setLocale, t, type Locale } from './i18n'
import { generateMap, populateMap } from './sim/mapgen'
import { Simulation } from './sim/simulation'
import { GameWorld } from './sim/world'
import { Camera } from './render/camera'
import { EntityRenderer } from './render/entity-renderer'
import { GameInput, InputManager } from './render/input'
import { Hud } from './render/hud'
import { TerrainRenderer } from './render/terrain-renderer'
import { SpriteLibrary } from './render/sprites/library'
import { TerrainSpriteRenderer, loadTerrainSheet } from './render/terrain-sprites'
import { BuildingSpriteFactory, loadBuildingSheet } from './render/building-sprites'
import { Assets, type Texture } from 'pixi.js'
import { TYPE_TO_SPRITE } from './render/entity-renderer'

const MAP_SIZE = 96
const SEED = 20260817
const LOCAL_PLAYER = 0

const PLAYER_COLORS = [0x8b1a1a, 0x1a3f8b, 0x2f6b2f, 0x7a5a1f]
const PLAYER_CIVS = ['al_bidda', 'al_zubarah', 'al_khor', 'al_bidda']

async function main(): Promise<void> {
  const locale = (new URLSearchParams(location.search).get('lang') as Locale) ?? 'en'
  setLocale(locale === 'ar' ? 'ar' : 'en')
  document.title = t('game.title')

  // ── Simulation ─────────────────────────────────────────────────────────────
  const { terrain, starts } = generateMap({
    size: MAP_SIZE,
    playerCount: 2,
    seed: SEED,
  })

  const world = new GameWorld(terrain, SEED)
  for (let i = 0; i < starts.length; i++) {
    world.addPlayer(i, PLAYER_CIVS[i] ?? 'al_bidda', PLAYER_COLORS[i] ?? 0xffffff)
  }

  populateMap(world, starts, SEED)

  // Starting force per player: a majlis and a handful of workers.
  starts.forEach((start, i) => {
    world.spawnBuilding('majlis', start.ne - 2, start.se - 2, i)
    for (let u = 0; u < 6; u++) {
      const angle = (u / 6) * Math.PI * 2
      const pos = {
        ne: start.ne + Math.cos(angle) * 3.5,
        se: start.se + Math.sin(angle) * 3.5,
      }
      world.spawnUnit(u < 4 ? 'laborer' : 'spearman', pos, i)
    }
  })
  world.recomputePopCaps()

  const sim = new Simulation(world)

  // ── Renderer ───────────────────────────────────────────────────────────────
  const app = new Application()
  await app.init({
    background: 0x16222c,
    resizeTo: window,
    antialias: true,
    preference: 'webgl',
  })

  const canvasHost = document.getElementById('canvas-host')!
  canvasHost.appendChild(app.canvas)

  const camera = new Camera()
  camera.setViewport(app.screen.width, app.screen.height)
  camera.setBounds({ minNe: 0, maxNe: MAP_SIZE, minSe: 0, maxSe: MAP_SIZE })

  // World container holds everything that lives in world space and receives the
  // camera transform. Screen-space overlays (selection box) sit outside it.
  const worldLayer = new Container()
  const screenLayer = new Container()
  app.stage.addChild(worldLayer, screenLayer)

  // Load the art pack. Absent or partial packs are fine — the entity renderer
  // falls back to placeholder shapes per sprite, so the game always boots.
  const spriteLibrary = new SpriteLibrary()
  const haveArt = await spriteLibrary.load('assets/sprites')
  if (haveArt) {
    await spriteLibrary.preload([...new Set(Object.values(TYPE_TO_SPRITE))])
    console.info(`[art] ${spriteLibrary.report()}`)
  } else {
    console.info('[art] no sprite pack found - using placeholder shapes')
  }

  // Terrain: real tile art if the pack is present, flat diamonds otherwise.
  const terrainSheet = await loadTerrainSheet('assets/sprites')
  let terrainSprites: TerrainSpriteRenderer | null = null
  const terrainRenderer = new TerrainRenderer(terrain)

  if (terrainSheet) {
    const atlas = await Assets.load<Texture>(`assets/sprites/${terrainSheet.sheet}`)
    terrainSprites = new TerrainSpriteRenderer(terrain, terrainSheet, atlas, app.renderer)
    console.info(`[art] terrain atlas: ${terrainSheet.rows.flat().length} tiles`)
  } else {
    console.info('[art] no terrain atlas - using flat tiles')
  }

  // Buildings: damage-state sheet if present.
  const buildingSheet = await loadBuildingSheet('assets/sprites')
  let buildingFactory: BuildingSpriteFactory | null = null
  if (buildingSheet) {
    const atlas = await Assets.load<Texture>(`assets/sprites/${buildingSheet.sheet}`)
    buildingFactory = new BuildingSpriteFactory(buildingSheet, atlas)
    console.info(`[art] building sheet: ${buildingSheet.rows.length} types x 3 damage states`)
  }

  const entityRenderer = new EntityRenderer(
    world,
    haveArt ? spriteLibrary : null,
    buildingFactory,
  )
  const pathOverlay = new Graphics()
  const gridOverlay = terrainRenderer.buildGridOverlay()
  gridOverlay.visible = false

  worldLayer.addChild(
    terrainSprites ? terrainSprites.container : terrainRenderer.container,
    gridOverlay,
    pathOverlay,
    entityRenderer.container,
  )

  // ── Input ──────────────────────────────────────────────────────────────────
  const input = new InputManager()
  const gameInput = new GameInput({
    world,
    camera,
    canvas: app.canvas as HTMLCanvasElement,
    overlay: screenLayer,
    localPlayerId: LOCAL_PLAYER,
  })
  input.push(gameInput)

  const hud = new Hud(
    document.getElementById('hud')!,
    world,
    sim,
    gameInput,
    LOCAL_PLAYER,
  )

  let showPaths = false

  wireEvents(app, camera, input, gameInput, hud, gridOverlay, () => {
    showPaths = !showPaths
    pathOverlay.visible = showPaths
  })
  pathOverlay.visible = false

  // Open on the local player's base.
  const start = starts[LOCAL_PLAYER]!
  camera.centerOn({ ne: start.ne, se: start.se })

  // ── Frame loop ─────────────────────────────────────────────────────────────
  let last = performance.now()

  app.ticker.add(() => {
    const now = performance.now()
    const realDelta = (now - last) / 1000
    last = now

    gameInput.updateCameraScroll(Math.min(realDelta, 0.05))

    sim.step(realDelta)

    camera.setViewport(app.screen.width, app.screen.height)
    camera.apply(worldLayer)

    if (terrainSprites) {
      terrainSprites.syncIfDirty()
      terrainSprites.cull(camera)
    } else {
      terrainRenderer.syncIfDirty()
      terrainRenderer.cull(camera)
    }
    entityRenderer.sync()
    entityRenderer.animate(realDelta)
    if (showPaths) entityRenderer.drawPaths(pathOverlay)

    hud.update()
  })

  // Surfaced for console poking during development.
  Object.assign(window as unknown as Record<string, unknown>, {
    __game: { world, sim, camera, app, gameInput, spriteLibrary },
  })

  document.getElementById('loading')?.remove()
}

function wireEvents(
  app: Application,
  camera: Camera,
  input: InputManager,
  gameInput: GameInput,
  hud: Hud,
  gridOverlay: Graphics,
  togglePaths: () => void,
): void {
  const canvas = app.canvas as HTMLCanvasElement

  const localPoint = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    const p = localPoint(e)
    input.pointerDown(p.x, p.y, e.button)
  })

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e)
    input.pointerMove(p.x, p.y)
  })

  canvas.addEventListener('pointerup', (e) => {
    const p = localPoint(e)
    input.pointerUp(p.x, p.y, e.button)
  })

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const p = localPoint(e)
      camera.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y)
    },
    { passive: false },
  )

  window.addEventListener('keydown', (e) => {
    // Never swallow keys destined for a focused form control.
    if (e.target instanceof HTMLInputElement) return

    gameInput.setKey(e.key, true)

    switch (e.key) {
      case 'F3':
        e.preventDefault()
        hud.toggleDebug()
        return
      case 'g':
      case 'G':
        gridOverlay.visible = !gridOverlay.visible
        return
      case 'p':
      case 'P':
        togglePaths()
        return
    }

    input.keyDown(e.key)
  })

  window.addEventListener('keyup', (e) => gameInput.setKey(e.key, false))
  window.addEventListener('blur', () => {
    for (const k of ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      gameInput.setKey(k, false)
    }
  })
}

main().catch((err) => {
  console.error(err)
  const loading = document.getElementById('loading')
  if (loading) loading.textContent = `Failed to start: ${String(err)}`
})
