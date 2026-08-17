/**
 * Browser smoke test.
 *
 * Unit tests cover src/sim, which is headless by design. This covers the part
 * they cannot: that the thing actually boots in a browser, renders, and responds
 * to a mouse. It drives real input events against a real build and asserts on
 * live game state rather than on pixels, so it does not break every time the
 * placeholder art changes.
 *
 * Usage:
 *   npm run build && npm run preview &
 *   node scripts/smoke-test.mjs [--url http://localhost:4173] [--shots DIR]
 *
 * Note on FPS: in CI this runs against SwiftShader (software GL), so the frame
 * rate is not representative of real hardware. The numbers worth reading are the
 * per-system simulation timings, which are GPU-independent.
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const URL = arg('--url', 'http://localhost:4173')
const SHOTS = arg('--shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})

console.log('\nKingdoms of Qatar — browser smoke test\n')

// ── Boot ─────────────────────────────────────────────────────────────────────
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

check('loading screen cleared', (await page.locator('#loading').count()) === 0)

const state = await page.evaluate(() => {
  const g = window.__game
  if (!g) return null
  return {
    entities: g.world.entityCount,
    players: g.world.players.size,
    units: [...g.world.ecs.with('position', 'movement')].length,
    buildings: [...g.world.ecs.with('building')].length,
    resources: [...g.world.ecs.with('resourceSpot')].length,
    simTime: g.sim.clock.now(),
  }
})

check('game state exposed', state !== null)
check('world populated', state && state.entities > 20, state && `${state.entities} entities`)
check('two players', state?.players === 2)
check('units spawned', state && state.units >= 12, state && `${state.units} units`)
check('buildings placed', state && state.buildings >= 2, state && `${state.buildings} buildings`)
check('resources scattered', state && state.resources > 10, state && `${state.resources} nodes`)
check('simulation advancing', state && state.simTime > 0.5, state && `t=${state.simTime.toFixed(1)}s`)
await shot(page, '01-initial')

// ── Selection ────────────────────────────────────────────────────────────────
await page.mouse.move(380, 250)
await page.mouse.down()
await page.mouse.move(900, 620, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(300)

const selected = await page.evaluate(() => window.__game.gameInput.selected.length)
check('box-select picks units', selected > 0, `${selected} selected`)
await shot(page, '02-selected')

// ── Movement ─────────────────────────────────────────────────────────────────
const before = await page.evaluate(() =>
  [...window.__game.world.ecs.with('position', 'movement')]
    .filter((e) => e.selected)
    .map((e) => ({ id: e.id, ne: e.position.ne, se: e.position.se })),
)

await page.mouse.click(1050, 300, { button: 'right' })
await page.waitForTimeout(250)

const pathed = await page.evaluate(
  () => [...window.__game.world.ecs.with('movement')].filter((e) => e.movement.path.length > 0).length,
)
check('right-click assigns paths', pathed > 0, `${pathed} units pathing`)

await page.waitForTimeout(2600)

const after = await page.evaluate(() =>
  Object.fromEntries(
    [...window.__game.world.ecs.with('position', 'movement')].map((e) => [
      e.id,
      { ne: e.position.ne, se: e.position.se },
    ]),
  ),
)

let moved = 0
let maxDelta = 0
for (const b of before) {
  const a = after[b.id]
  if (!a) continue
  const d = Math.hypot(a.ne - b.ne, a.se - b.se)
  if (d > 0.25) moved++
  maxDelta = Math.max(maxDelta, d)
}
check(
  'units actually move',
  moved === before.length && before.length > 0,
  `${moved}/${before.length}, max ${maxDelta.toFixed(2)} tiles`,
)
await shot(page, '03-moved')

// ── Units stay on passable ground ────────────────────────────────────────────
const offMap = await page.evaluate(() => {
  const g = window.__game
  let bad = 0
  for (const e of g.world.ecs.with('position')) {
    if (e.resourceSpot || e.building) continue
    const ne = Math.floor(e.position.ne)
    const se = Math.floor(e.position.se)
    if (!g.world.terrain.isPassable(ne, se)) bad++
  }
  return bad
})
check('no unit ends on impassable ground', offMap === 0, `${offMap} offenders`)

// ── Overlays ─────────────────────────────────────────────────────────────────
await page.keyboard.press('F3')
await page.keyboard.press('p')
await page.waitForTimeout(400)
check('debug overlay toggles', await page.locator('.hud-debug').isVisible())
check('HUD chrome present', (await page.locator('.chrome-command').count()) === 1)
check('minimap rendering', (await page.locator('.chrome-minimap canvas').count()) === 1)
await shot(page, '04-debug')

// ── Zoom ─────────────────────────────────────────────────────────────────────
const zoomBefore = await page.evaluate(() => window.__game.camera.zoom)
for (let i = 0; i < 9; i++) {
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(50)
}
const zoomAfter = await page.evaluate(() => window.__game.camera.zoom)
check('wheel zooms out', zoomAfter < zoomBefore, `${zoomBefore.toFixed(2)} -> ${zoomAfter.toFixed(2)}`)
await shot(page, '05-zoomed')

// ── Arabic / RTL ─────────────────────────────────────────────────────────────
await page.goto(`${URL}/?lang=ar`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const rtl = await page.evaluate(() => document.documentElement.dir)
// The chrome HUD carries no resource labels (the art supplies the icons), so
// Arabic is checked on the age readout instead.
const label = (await page.locator('.chrome-topright').first().textContent()) ?? ''
check('document direction flips to RTL', rtl === 'rtl')
check('HUD strings localise to Arabic', /[\u0600-\u06FF]/.test(label), label.trim().slice(0, 40))
await shot(page, '06-arabic')

// ── Load: 400 extra units ────────────────────────────────────────────────────
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const perf = await page.evaluate(async () => {
  const g = window.__game
  for (let i = 0; i < 400; i++) {
    const angle = (i / 400) * Math.PI * 2
    const r = 4 + (i % 40) * 0.35
    g.world.spawnUnit('spearman', { ne: 30 + Math.cos(angle) * r, se: 30 + Math.sin(angle) * r }, 0)
  }

  const t0 = performance.now()
  let frames = 0
  await new Promise((resolve) => {
    const tick = () => {
      frames++
      if (performance.now() - t0 > 3000) return resolve(null)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  return {
    entities: g.world.entityCount,
    fps: (frames / (performance.now() - t0)) * 1000,
    timings: { ...g.sim.timings },
  }
})

const simMs = Object.values(perf.timings).reduce((a, b) => a + b, 0)
check('holds 480+ entities', perf.entities >= 480, `${perf.entities} entities`)
check(
  'simulation stays under 4ms/frame at load',
  simMs < 4,
  `${simMs.toFixed(2)}ms (fps ${perf.fps.toFixed(0)} on software GL)`,
)
await shot(page, '07-crowd')

// ── Errors ───────────────────────────────────────────────────────────────────
const realErrors = pageErrors.filter((e) => !e.includes('404'))
check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

await browser.close()

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`)
process.exit(failures === 0 ? 0 : 1)
