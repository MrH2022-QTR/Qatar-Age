import { describe, expect, it } from 'vitest'
import { frameAt, resolveFrame, type AnimationManifest } from '../src/render/sprites/types'
import { STATE_TO_ANIMATION } from '../src/render/sprites/aoe-sprite'

/**
 * The angle/frame lookup is the part of the sprite system most likely to be
 * silently wrong — a mis-indexed table shows up as units facing the wrong way
 * or animations playing backwards, both of which are easy to stare past. These
 * pin the convention down so the packer and the runtime can never drift apart.
 */

function anim(overrides: Partial<AnimationManifest> = {}): AnimationManifest {
  // 8 presented angles from 5 stored ones — AoE2's usual arrangement.
  // Frames 0-14: 5 angles x 3 frames. Angles 5-7 mirror angles 3,2,1.
  return {
    name: 'walk',
    storedAngles: 5,
    angles: 8,
    frameCount: 3,
    duration: 0.6,
    loop: true,
    lookup: [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
      [12, 13, 14],
      [-10, -11, -12], // mirror of 9,10,11
      [-7, -8, -9], //   mirror of 6,7,8
      [-4, -5, -6], //   mirror of 3,4,5
    ],
    ...overrides,
  }
}

describe('frame resolution', () => {
  it('resolves a direct (unmirrored) entry', () => {
    expect(resolveFrame(anim(), 1, 0)).toEqual({ frame: 3, mirrored: false })
    expect(resolveFrame(anim(), 4, 2)).toEqual({ frame: 14, mirrored: false })
  })

  it('decodes negative entries as mirrored frames', () => {
    // -10 encodes frame 9 drawn mirrored.
    expect(resolveFrame(anim(), 5, 0)).toEqual({ frame: 9, mirrored: true })
    expect(resolveFrame(anim(), 7, 2)).toEqual({ frame: 5, mirrored: true })
  })

  it('wraps angle and frame indices rather than running off the end', () => {
    const a = anim()
    expect(resolveFrame(a, 8, 0)).toEqual(resolveFrame(a, 0, 0))
    expect(resolveFrame(a, 0, 3)).toEqual(resolveFrame(a, 0, 0))
  })

  it('never returns a negative frame index', () => {
    const a = anim()
    for (let ang = 0; ang < a.angles; ang++) {
      for (let f = 0; f < a.frameCount; f++) {
        expect(resolveFrame(a, ang, f).frame).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('covers every stored frame across the full angle sweep', () => {
    const a = anim()
    const seen = new Set<number>()
    for (let ang = 0; ang < a.angles; ang++) {
      for (let f = 0; f < a.frameCount; f++) seen.add(resolveFrame(a, ang, f).frame)
    }
    expect(seen.size).toBe(15)
  })
})

describe('animation timing', () => {
  it('advances one frame per slot', () => {
    const a = anim() // 3 frames over 0.6s -> 0.2s each
    expect(frameAt(a, 0)).toBe(0)
    expect(frameAt(a, 0.1)).toBe(0)
    expect(frameAt(a, 0.25)).toBe(1)
    expect(frameAt(a, 0.45)).toBe(2)
  })

  it('loops when the animation loops', () => {
    const a = anim()
    expect(frameAt(a, 0.65)).toBe(0)
    expect(frameAt(a, 1.25)).toBe(0)
  })

  it('holds the last frame when it does not loop', () => {
    // Death animations must not snap back to standing.
    const a = anim({ loop: false, name: 'die' })
    expect(frameAt(a, 5)).toBe(2)
    expect(frameAt(a, 500)).toBe(2)
  })

  it('handles single-frame animations without dividing by zero', () => {
    const a = anim({ frameCount: 1, lookup: [[0]] })
    expect(frameAt(a, 0)).toBe(0)
    expect(frameAt(a, 99)).toBe(0)
  })
})

describe('state to animation mapping', () => {
  it('covers every state the adopted sim can produce', () => {
    // Mirrors the EntityState union in src/aoe/core/entity.ts. If that grows,
    // this test is the thing that notices.
    const simStates = [
      'idle', 'moving', 'gathering', 'returning', 'building', 'repairing',
      'attacking', 'dead', 'corpse', 'foundation', 'training', 'garrisoned',
      'transforming', 'projectile',
    ]
    for (const s of simStates) {
      expect(STATE_TO_ANIMATION[s], `state "${s}" has no animation mapping`).toBeDefined()
    }
  })

  it('maps movement to walk and combat to attack', () => {
    expect(STATE_TO_ANIMATION.moving).toBe('walk')
    expect(STATE_TO_ANIMATION.returning).toBe('walk')
    expect(STATE_TO_ANIMATION.attacking).toBe('attackA')
    expect(STATE_TO_ANIMATION.dead).toBe('die')
  })
})
