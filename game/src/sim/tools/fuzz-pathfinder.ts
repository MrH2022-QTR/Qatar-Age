/**
 * Pathfinder fuzz harness.
 *
 * This is the workflow from docs/PATHFINDING_NOTES.md §5.3, adapted. Faced with
 * a 25-year-old pathfinding bug, the Age of Empires engineering director's
 * method was to run the game with eight AI players at maximum speed, let the
 * algorithm's own self-check flag broken paths, dump each failure with
 * everything needed to reproduce it, and fix them one at a time. Over a few
 * months that produced roughly 100 regression cases. His summary:
 *
 *     "I would not have known where to even start if I did not have this system."
 *
 * We get this cheaply because src/sim is headless by construction — no window,
 * no renderer, no game loop required. `npm run fuzz`.
 *
 * Any failure is written to test/fixtures/path-failure-*.json, which the
 * regression test picks up automatically. That is the whole point: a failure
 * found once becomes a test forever.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TerrainGrid, TerrainType } from '../grid'
import { Pathfinder } from '../pathfinding/pathfinder'
import {
  clearCollectedFailures,
  collectedFailures,
  enablePathValidation,
} from '../pathfinding/validate'
import { Rng } from '../random'
import { generateMap } from '../mapgen'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '../../../test/fixtures')

interface FuzzOptions {
  iterations: number
  seed: number
  verbose: boolean
}

function parseArgs(): FuzzOptions {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback: number): number => {
    const i = args.indexOf(flag)
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
  }
  return {
    iterations: get('--iterations', 20000),
    seed: get('--seed', 1),
    verbose: args.includes('--verbose'),
  }
}

/** A grid of random rectangular obstructions — the adversarial case. */
function clutteredMap(rng: Rng, size: number): TerrainGrid {
  const g = new TerrainGrid(size, size, TerrainType.Sand)
  const blobs = rng.int(size / 4, size)
  for (let i = 0; i < blobs; i++) {
    const w = rng.int(1, 6)
    const h = rng.int(1, 6)
    const ne = rng.int(0, size - 1)
    const se = rng.int(0, size - 1)
    for (let dse = 0; dse < h; dse++) {
      for (let dne = 0; dne < w; dne++) {
        g.setTerrain(ne + dne, se + dse, TerrainType.Rock)
      }
    }
  }
  return g
}

/** Narrow diagonal corridors — the case most likely to expose corner cutting. */
function mazeMap(rng: Rng, size: number): TerrainGrid {
  const g = new TerrainGrid(size, size, TerrainType.Sand)
  for (let se = 2; se < size - 2; se += 3) {
    const gap = rng.int(1, size - 2)
    for (let ne = 0; ne < size; ne++) {
      if (Math.abs(ne - gap) <= 1) continue
      g.setTerrain(ne, se, TerrainType.Rock)
    }
  }
  return g
}

function main(): void {
  const opts = parseArgs()
  const rng = new Rng(opts.seed)

  let failures = 0
  let unreachable = 0
  let found = 0
  let totalNodes = 0
  let maxNodes = 0

  enablePathValidation((snapshot) => {
    failures++
    mkdirSync(FIXTURES, { recursive: true })
    const file = join(FIXTURES, `path-failure-${opts.seed}-${failures}.json`)
    writeFileSync(file, JSON.stringify(snapshot, null, 2))
    console.error(`\n  FAIL  ${snapshot.violations.join('; ')}`)
    console.error(`        written to ${file}`)
  })

  const started = Date.now()

  for (let i = 0; i < opts.iterations; i++) {
    // Rotate through map archetypes so we are not only fuzzing one shape.
    const mode = i % 3
    const size = rng.int(24, 72)
    let grid: TerrainGrid

    if (mode === 0) grid = clutteredMap(rng.fork(i), size)
    else if (mode === 1) grid = mazeMap(rng.fork(i), size)
    else grid = generateMap({ size, playerCount: 2, seed: rng.int(1, 1e9) }).terrain

    const pf = new Pathfinder(grid)
    pf.beginFrame()

    // Several requests per map, since building the map dominates the cost.
    for (let r = 0; r < 8; r++) {
      const start = { ne: rng.int(0, grid.width - 1), se: rng.int(0, grid.height - 1) }
      const goal = { ne: rng.int(0, grid.width - 1), se: rng.int(0, grid.height - 1) }
      if (!grid.isPassableTile(start)) continue

      const path = pf.request({ start, goal, priority: 'player' })
      if (!path) continue

      totalNodes += path.nodesExpanded
      if (path.nodesExpanded > maxNodes) maxNodes = path.nodesExpanded
      if (path.result === 'found') found++
      else if (path.result === 'unreachable') unreachable++
    }

    if (opts.verbose && i > 0 && i % 2000 === 0) {
      process.stdout.write(`  ${i}/${opts.iterations} maps, ${failures} failures\n`)
    }
  }

  const elapsed = (Date.now() - started) / 1000
  const requests = found + unreachable

  console.log('')
  console.log('  Pathfinder fuzz')
  console.log('  ───────────────')
  console.log(`  maps          ${opts.iterations}`)
  console.log(`  requests      ${requests}`)
  console.log(`  found         ${found}`)
  console.log(`  unreachable   ${unreachable}`)
  console.log(`  avg nodes     ${requests ? Math.round(totalNodes / requests) : 0}`)
  console.log(`  max nodes     ${maxNodes}`)
  console.log(`  elapsed       ${elapsed.toFixed(2)}s`)
  console.log(`  failures      ${failures}`)
  console.log('')

  if (failures > 0) {
    console.error(`  ${failures} invariant violation(s). Fixtures written to test/fixtures/.`)
    process.exit(1)
  }
  console.log('  All paths satisfied their invariants.')
  clearCollectedFailures()
  void collectedFailures
}

main()
