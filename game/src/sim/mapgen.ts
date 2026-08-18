/**
 * Map generation.
 *
 * openage has none — no map file format, no generator, nothing to port
 * (docs/ARCHITECTURE.md §4.13). So this is designed rather than translated.
 *
 * The geography is deliberately Qatari: a peninsula. Land occupies the centre,
 * the Gulf surrounds it, and pearl banks sit offshore in the shallows — which
 * gives the pearl economy a spatial logic rather than being a reskinned gold
 * mine. Player starts are placed inland and mirrored for fairness.
 *
 * docs/PORT_PLAN.md flags symmetric fairness as the genuinely hard part of map
 * generation. This generator sidesteps it by construction: it places players by
 * rotating them around the map centre, so every start is geometrically
 * equivalent by definition.
 */

import { TerrainGrid, TerrainType } from './grid'
import { Rng } from './random'
import type { GameWorld } from './world'

export interface MapConfig {
  size: number
  playerCount: number
  seed: number
}

export interface PlayerStart {
  ne: number
  se: number
}

export interface GeneratedMap {
  terrain: TerrainGrid
  starts: PlayerStart[]
}

/** Smooth value noise. Cheap, seeded, and good enough for coastlines. */
function valueNoise(rng: Rng, size: number, scale: number): Float32Array {
  const gw = Math.ceil(size / scale) + 2
  const grid = new Float32Array(gw * gw)
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next()

  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / scale
      const gy = y / scale
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      // Smoothstep for continuity.
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)

      const v00 = grid[y0 * gw + x0]!
      const v10 = grid[y0 * gw + x0 + 1]!
      const v01 = grid[(y0 + 1) * gw + x0]!
      const v11 = grid[(y0 + 1) * gw + x0 + 1]!

      const a = v00 + (v10 - v00) * sx
      const b = v01 + (v11 - v01) * sx
      out[y * size + x] = a + (b - a) * sy
    }
  }
  return out
}

export function generateMap(config: MapConfig): GeneratedMap {
  const { size, playerCount, seed } = config
  const rng = new Rng(seed)
  const terrain = new TerrainGrid(size, size, TerrainType.DeepWater)

  const cx = size / 2
  const cy = size / 2
  const noise = valueNoise(rng, size, 14)
  const detail = valueNoise(rng.fork(7), size, 5)

  // Land mass: a radial falloff perturbed by noise, so the coast is irregular
  // but the interior is reliably solid.
  const landRadius = size * 0.36

  for (let se = 0; se < size; se++) {
    for (let ne = 0; ne < size; ne++) {
      const dx = ne - cx
      const dy = se - cy
      const dist = Math.sqrt(dx * dx + dy * dy)

      const n = noise[se * size + ne]!
      const d = detail[se * size + ne]!
      // Perturb the coastline by up to ~18% of the radius.
      const threshold = landRadius * (0.82 + n * 0.36)

      let type: TerrainType
      if (dist < threshold) {
        // Inland: mostly desert and sand, with gravel patches and rare grass.
        if (d > 0.72) type = TerrainType.Gravel
        else if (d < 0.2) type = TerrainType.Grass
        else if (d > 0.45) type = TerrainType.Desert
        else type = TerrainType.Sand
      } else if (dist < threshold * 1.18) {
        type = TerrainType.ShallowWater
      } else {
        type = TerrainType.DeepWater
      }
      terrain.setTerrain(ne, se, type)
    }
  }

  // A few rock outcrops inland, as hard obstacles to path around.
  const outcrops = Math.floor(size / 12)
  for (let i = 0; i < outcrops; i++) {
    const angle = rng.float(0, Math.PI * 2)
    const r = rng.float(landRadius * 0.2, landRadius * 0.7)
    const ne = Math.round(cx + Math.cos(angle) * r)
    const se = Math.round(cy + Math.sin(angle) * r)
    const blobSize = rng.int(2, 4)
    for (let dse = -blobSize; dse <= blobSize; dse++) {
      for (let dne = -blobSize; dne <= blobSize; dne++) {
        if (dne * dne + dse * dse > blobSize * blobSize) continue
        if (terrain.isPassable(ne + dne, se + dse)) {
          terrain.setTerrain(ne + dne, se + dse, TerrainType.Rock)
        }
      }
    }
  }

  // Player starts, rotated evenly about the centre. Equivalent by construction.
  const starts: PlayerStart[] = []
  const startRadius = landRadius * 0.55
  for (let i = 0; i < playerCount; i++) {
    const angle = (i / playerCount) * Math.PI * 2 + Math.PI / 4
    let ne = Math.round(cx + Math.cos(angle) * startRadius)
    let se = Math.round(cy + Math.sin(angle) * startRadius)

    // Guarantee the start is on open ground.
    const open = terrain.nearestPassable({ ne, se }, 24)
    if (open) {
      ne = open.ne
      se = open.se
    }
    // Clear a landing pad so the starting buildings always fit.
    for (let dse = -3; dse <= 3; dse++) {
      for (let dne = -3; dne <= 3; dne++) {
        if (!terrain.inBounds(ne + dne, se + dse)) continue
        if (!terrain.isPassable(ne + dne, se + dse)) {
          terrain.setTerrain(ne + dne, se + dse, TerrainType.Sand)
        }
      }
    }
    starts.push({ ne, se })
  }

  return { terrain, starts }
}

/**
 * Populate a generated map with resources and each player's starting force.
 * Separated from terrain generation so tests can build a bare map.
 */
export function populateMap(world: GameWorld, starts: PlayerStart[], seed: number): void {
  const rng = new Rng(seed ^ 0x5bf03635)
  const terrain = world.terrain
  const size = terrain.width
  const cx = size / 2
  const cy = size / 2

  // Pearl banks: offshore, in the shallows. Their position is the whole point —
  // it makes the pearl economy a coastal activity with real travel cost.
  const banks = Math.max(6, Math.floor(size / 8))
  let placed = 0
  let attempts = 0
  while (placed < banks && attempts++ < banks * 60) {
    const ne = rng.int(1, size - 2)
    const se = rng.int(1, size - 2)
    if (terrain.getTerrain(ne, se) !== TerrainType.ShallowWater) continue
    world.spawnResourceSpot('pearls', ne, se, 400)
    placed++
  }

  for (const start of starts) {
    // Wood and stone clustered near each start, mirrored by construction since
    // the starts themselves are rotationally symmetric.
    scatterAround(world, rng, start.ne, start.se, 'wood', 8, 6, 12, 150)
    scatterAround(world, rng, start.ne, start.se, 'stone', 3, 7, 13, 250)
    scatterAround(world, rng, start.ne, start.se, 'food', 5, 4, 9, 200)
  }

  // Keep the interior interesting: a scattering of extra wood inland.
  const extra = Math.floor(size / 4)
  for (let i = 0; i < extra; i++) {
    const angle = rng.float(0, Math.PI * 2)
    const r = rng.float(0, size * 0.3)
    const ne = Math.round(cx + Math.cos(angle) * r)
    const se = Math.round(cy + Math.sin(angle) * r)
    if (terrain.isPassable(ne, se)) world.spawnResourceSpot('wood', ne, se, 150)
  }
}

function scatterAround(
  world: GameWorld,
  rng: Rng,
  ne: number,
  se: number,
  kind: 'food' | 'wood' | 'stone' | 'pearls',
  count: number,
  minR: number,
  maxR: number,
  amount: number,
): void {
  let placed = 0
  let attempts = 0
  while (placed < count && attempts++ < count * 40) {
    const angle = rng.float(0, Math.PI * 2)
    const r = rng.float(minR, maxR)
    const tne = Math.round(ne + Math.cos(angle) * r)
    const tse = Math.round(se + Math.sin(angle) * r)
    if (!world.terrain.isPassable(tne, tse)) continue
    world.spawnResourceSpot(kind, tne, tse, amount)
    placed++
  }
}
