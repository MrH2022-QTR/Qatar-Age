import { describe, expect, it } from 'vitest'
import {
  HALF_H,
  HALF_W,
  angleToBucket,
  depthOf,
  screenToWorld,
  tileCenter,
  worldToScreen,
  worldToTile,
  distance,
} from '../src/sim/coords'

/**
 * docs/PORT_PLAN.md §6 nominates coordinates as the first system to build,
 * on the grounds that coordinate bugs in an isometric game surface late and
 * cost days. That argument is only worth anything if the module is actually
 * pinned down by tests, so: these are the pins.
 */
describe('isometric projection', () => {
  it('places the origin at the screen origin', () => {
    expect(worldToScreen({ ne: 0, se: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('sends +NE up and to the right', () => {
    const p = worldToScreen({ ne: 1, se: 0 })
    expect(p.x).toBe(HALF_W)
    expect(p.y).toBe(-HALF_H)
  })

  it('sends +SE down and to the right', () => {
    const p = worldToScreen({ ne: 0, se: 1 })
    expect(p.x).toBe(HALF_W)
    expect(p.y).toBe(HALF_H)
  })

  it('round-trips world -> screen -> world', () => {
    const samples = [
      { ne: 0, se: 0 },
      { ne: 3.25, se: 7.5 },
      { ne: -4.75, se: 12.125 },
      { ne: 99.5, se: 0.5 },
    ]
    for (const s of samples) {
      const back = screenToWorld(worldToScreen(s))
      expect(back.ne).toBeCloseTo(s.ne, 10)
      expect(back.se).toBeCloseTo(s.se, 10)
    }
  })

  it('round-trips screen -> world -> screen', () => {
    for (const s of [{ x: 0, y: 0 }, { x: 128, y: -64 }, { x: -33, y: 91 }]) {
      const back = worldToScreen(screenToWorld(s))
      expect(back.x).toBeCloseTo(s.x, 10)
      expect(back.y).toBeCloseTo(s.y, 10)
    }
  })

  it('keeps the 2:1 tile ratio that makes the projection read as isometric', () => {
    expect(HALF_W / HALF_H).toBe(2)
  })
})

describe('tiles', () => {
  it('floors world positions into the containing tile', () => {
    expect(worldToTile({ ne: 3.9, se: 0.1 })).toEqual({ ne: 3, se: 0 })
    expect(worldToTile({ ne: 0, se: 0 })).toEqual({ ne: 0, se: 0 })
  })

  it('puts tile centres at the half-tile offset', () => {
    expect(tileCenter({ ne: 2, se: 5 })).toEqual({ ne: 2.5, se: 5.5 })
  })

  it('round-trips a tile through its centre', () => {
    for (let ne = 0; ne < 8; ne++) {
      for (let se = 0; se < 8; se++) {
        expect(worldToTile(tileCenter({ ne, se }))).toEqual({ ne, se })
      }
    }
  })
})

describe('depth sorting', () => {
  it('orders by screen y, so lower on screen draws in front', () => {
    const near = { ne: 0, se: 5 } // low on screen
    const far = { ne: 5, se: 0 } // high on screen
    expect(depthOf(near)).toBeGreaterThan(depthOf(far))
  })

  it('agrees with the sign of screen y', () => {
    for (const p of [{ ne: 1, se: 4 }, { ne: 6, se: 2 }, { ne: 0, se: 0 }]) {
      expect(Math.sign(depthOf(p))).toBe(Math.sign(worldToScreen(p).y))
    }
  })
})

describe('distance', () => {
  it('measures in world space, not screen space', () => {
    // These two are equidistant in world units but NOT on screen, because the
    // projection squashes the y axis. Gameplay must use the world metric.
    const origin = { ne: 0, se: 0 }
    const a = { ne: 3, se: 0 }
    const b = { ne: 0, se: 3 }
    expect(distance(origin, a)).toBeCloseTo(distance(origin, b), 10)

    const sa = worldToScreen(a)
    const sb = worldToScreen(b)
    expect(Math.hypot(sa.x, sa.y)).toBeCloseTo(Math.hypot(sb.x, sb.y), 10)
  })
})

describe('angle buckets', () => {
  it('quantises a full turn into the requested number of buckets', () => {
    const tau = Math.PI * 2
    expect(angleToBucket(0, 8)).toBe(0)
    expect(angleToBucket(tau / 8, 8)).toBe(1)
    expect(angleToBucket(tau / 2, 8)).toBe(4)
    // Wraps rather than overflowing.
    expect(angleToBucket(tau, 8)).toBe(0)
    expect(angleToBucket(-tau / 8, 8)).toBe(7)
  })
})
