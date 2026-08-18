/**
 * Entry point: the adopted Age of Kings simulation, rendered with our stack.
 *
 * src/main.ts still runs our own lightweight simulation. This runs theirs —
 * the full economy, combat, production and AI on a deterministic 20 Hz tick —
 * through our isometric sprite renderer, with elevation and fog of war.
 *
 * Kept as a separate entry rather than a flag so both remain runnable and
 * comparable while the two halves converge.
 */

import { Application, Assets, Container, type Texture } from 'pixi.js'

import { buildRegistry, type GameData } from './aoe/data/registry'
import { makeGame, standardStart, standardResources } from './aoe/core/setup'
import { generateArabia } from './aoe/core/arabia'
import { SimpleAI } from './aoe/ai/simple'

import { Camera } from './render/camera'
import { SpriteLibrary } from './render/sprites/library'
import { ElevatedTerrainRenderer, type ElevSheet } from './render/elevation'
import { FixedTicker, SimRenderBridge, SimTerrainSource, type SimGame } from './render/aoe-bridge'
import { SheetLibrary } from './render/sheets'
import { requiredSheets } from './render/genie-art'
import { BuildingSpriteFactory, loadBuildingSheet } from './render/building-sprites'
import { generateElevation } from './sim/elevation-gen'
import { setLocale, t } from './i18n'

const MAP = 120
const LOCAL = 0
const PLAYER_COLORS = [0x2f6ba8, 0xa83232, 0x3f8f3f, 0xb08a2e]

/**
 * Their terrain codes are 0 land, 1 water, 2 shallows. Map onto our atlas,
 * varying by position so large flats do not visibly repeat.
 */
function tileFor(terrain: number, ne: number, se: number): [number, number] {
  const h = ((ne * 73856093) ^ (se * 19349663)) >>> 0
  if (terrain === 1) return [4, 1] // deep water
  if (terrain === 2) return [4, h % 2 === 0 ? 0 : 2] // shallows
  // Land: grass and sand variants.
  const land: Array<[number, number]> = [
    [0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [0, 4],
  ]
  return land[h % land.length]!
}

async function fetchJson(path: string): Promise<unknown> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json()
}

async function main(): Promise<void> {
  setLocale('en')
  document.title = t('game.title')

  // ── Simulation ─────────────────────────────────────────────────────────────
  const raw = {
    units: await fetchJson('aoe-data/units.json'),
    civ_unit_diffs: await fetchJson('aoe-data/civ_unit_diffs.json'),
    techs: await fetchJson('aoe-data/techs.json'),
    effects: await fetchJson('aoe-data/effects.json'),
    civs: await fetchJson('aoe-data/civs.json'),
    graphics: await fetchJson('aoe-data/graphics.json'),
    strings: await fetchJson('aoe-data/strings.json'),
  }
  const data: GameData = buildRegistry(raw as never)

  const game = makeGame(data, {
    mapW: MAP,
    mapH: MAP,
    seed: 20260817,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
    popCap: 200,
  })
  generateArabia(game)
  // Their Arabia generator leaves elevation flat; give the map real relief.
  generateElevation(game.map as never, 20260817)
  game.initCivs()

  const ai = new SimpleAI(1)
  const ticker = new FixedTicker()

  // ── Renderer ───────────────────────────────────────────────────────────────
  const app = new Application()
  await app.init({ background: 0x1d2a1d, resizeTo: window, antialias: true, preference: 'webgl' })
  document.getElementById('canvas-host')!.appendChild(app.canvas)

  const sheetRes = await fetch('assets/sprites/terrain.json')
  const terrainSheet = (await sheetRes.json()) as ElevSheet
  const atlas = await Assets.load<Texture>(`assets/sprites/${terrainSheet.sheet}`)

  const source = new SimTerrainSource(game.map as never, tileFor)
  const terrain = new ElevatedTerrainRenderer(source, terrainSheet, atlas, app.renderer)

  const sprites = new SpriteLibrary()
  const haveArt = await sprites.load('assets/sprites')
  if (haveArt) await sprites.preload(['villager', 'spearman', 'archer', 'cavalry', 'siege'])

  const nameOf = (typeId: number): string => data.units.get(typeId)?.name ?? ''

  // Sheets for trees, mines, forage and wildlife; buildings for structures.
  const sheets = new SheetLibrary()
  const haveSheets = await sheets.load('assets/sprites')
  if (haveSheets) await sheets.preload(requiredSheets())

  const buildingSheet = await loadBuildingSheet('assets/sprites')
  const buildingFactory = buildingSheet
    ? new BuildingSpriteFactory(buildingSheet, await Assets.load<Texture>(`assets/sprites/${buildingSheet.sheet}`))
    : null

  const bridge = new SimRenderBridge(game as unknown as SimGame, haveArt ? sprites : null, {
    nameOf,
    playerColor: (owner) => PLAYER_COLORS[owner] ?? 0x888888,
    localPlayer: LOCAL,
    sheets: haveSheets ? sheets : null,
    buildings: buildingFactory,
  })

  const camera = new Camera()
  camera.setViewport(app.screen.width, app.screen.height)
  camera.setBounds({ minNe: 0, maxNe: MAP, minSe: 0, maxSe: MAP })

  const worldLayer = new Container()
  worldLayer.addChild(terrain.container, bridge.container, bridge.fogContainer)
  app.stage.addChild(worldLayer)

  // Open on the local player's town centre.
  const own = [...game.entities.values()].find((e) => e.owner === LOCAL)
  if (own) camera.centerOn({ ne: own.x, se: own.y })

  // ── Loop ───────────────────────────────────────────────────────────────────
  let last = performance.now()
  let fogTimer = 0

  app.ticker.add(() => {
    const now = performance.now()
    const dt = (now - last) / 1000
    last = now

    // Whole simulation ticks only — see FixedTicker.
    ticker.advance(game as unknown as SimGame, dt)
    ai.step(game, 0.05 * ticker.lastTicks)

    camera.setViewport(app.screen.width, app.screen.height)
    camera.apply(worldLayer)

    terrain.syncIfDirty()
    bridge.sync()
    bridge.animate(dt)

    // Fog is expensive per tile; a few times a second is plenty.
    fogTimer += dt
    if (fogTimer > 0.4) {
      bridge.drawFog()
      fogTimer = 0
    }
  })

  Object.assign(window as unknown as Record<string, unknown>, {
    __aoe: { game, bridge, camera, app, ticker, data },
  })
  document.getElementById('loading')?.remove()
}

main().catch((err) => {
  console.error(err)
  const el = document.getElementById('loading')
  if (el) el.textContent = `Failed to start: ${String(err)}`
})
