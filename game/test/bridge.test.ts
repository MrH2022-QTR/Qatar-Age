import { describe, expect, it } from 'vitest'
import { FixedTicker, SIM_TICK, type SimGame } from '../src/render/aoe-bridge'

/**
 * The bridge's one load-bearing property: the adopted simulation is a fixed
 * 20 Hz deterministic tick, and driving it from a variable-dt render loop must
 * not change that. Whole ticks only, remainder carried.
 *
 * If this breaks, the simulation's 73 tests keep passing while the running game
 * silently desyncs from them — the worst possible failure mode, so it is pinned
 * here.
 */

function fakeGame(): SimGame & { ticks: number } {
  const g = {
    ticks: 0,
    map: {
      w: 4, h: 4,
      terrain: new Uint8Array(16),
      elevation: new Uint8Array(16),
      elevationAt: () => 0,
    },
    entities: new Map(),
    players: [],
    visibility: [],
    time: 0,
    tickCount: 0,
    tick() { this.ticks++; this.tickCount++; this.time += SIM_TICK },
    defOf: () => ({ hp: 1 }),
  }
  return g as unknown as SimGame & { ticks: number }
}

describe('FixedTicker', () => {
  it('runs exactly one tick per tick-length of real time', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, SIM_TICK)
    expect(g.ticks).toBe(1)
  })

  it('runs no tick when less than a tick has elapsed', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, SIM_TICK / 2)
    expect(g.ticks).toBe(0)
  })

  it('carries the remainder rather than discarding it', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    // Three half-ticks should yield one whole tick, with half carried.
    t.advance(g, SIM_TICK / 2)
    t.advance(g, SIM_TICK / 2)
    expect(g.ticks).toBe(1)
    t.advance(g, SIM_TICK / 2)
    expect(g.ticks).toBe(1)
    t.advance(g, SIM_TICK / 2)
    expect(g.ticks).toBe(2)
  })

  it('gives the same tick count for the same total time under realistic jitter', () => {
    // The determinism property: how the host happens to schedule frames must
    // not change how many ticks the simulation runs — provided no single frame
    // exceeds the delta clamp (see the next test).
    const steady = fakeGame()
    const jittery = fakeGame()
    const a = new FixedTicker()
    const b = new FixedTicker()

    // Uneven, but every frame within the 0.25s clamp — i.e. what a real
    // browser produces, including dropped frames. Deliberately NOT rescaled:
    // scaling a list to hit a round total can push individual frames past the
    // clamp, which legitimately drops time and is a different test.
    const uneven = [0.13, 0.007, 0.21, 0.05, 0.16, 0.003, 0.19, 0.11, 0.09, 0.24, 0.15, 0.195]
    const total = uneven.reduce((x, y) => x + y, 0)

    for (let i = 0; i < 60; i++) a.advance(steady, total / 60)
    for (const dt of uneven) b.advance(jittery, dt)

    expect(jittery.ticks).toBe(steady.ticks)
  })

  it('deliberately drops time for frames beyond the delta clamp', () => {
    // A frame longer than 0.25s means the tab was stalled — backgrounded, or
    // the machine was busy. Replaying that gap would make the game lurch
    // forward on return, so the clamp discards it. Same reasoning as the
    // 50ms ceiling in sim/time.ts, and the reason the previous test qualifies
    // its claim.
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, 5)
    // 5s would be 100 ticks; the clamp plus the per-frame cap keep it small.
    expect(g.ticks).toBeLessThan(10)
  })

  it('caps catch-up so a stalled tab cannot lock the page', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    // Ten seconds of backlog would be 200 ticks without a cap.
    t.advance(g, 10)
    expect(g.ticks).toBeLessThanOrEqual(8)
  })

  it('does not accumulate an unpayable debt after a stall', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, 10)
    const afterStall = g.ticks
    // The next normal frame should run one tick, not sprint to catch up.
    t.advance(g, SIM_TICK)
    expect(g.ticks).toBe(afterStall + 1)
  })

  it('scales with simulation speed', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, SIM_TICK, 2)
    expect(g.ticks).toBe(2)
  })

  it('reports how many ticks it ran', () => {
    const g = fakeGame()
    const t = new FixedTicker()
    t.advance(g, SIM_TICK * 3)
    expect(t.lastTicks).toBe(3)
  })
})
