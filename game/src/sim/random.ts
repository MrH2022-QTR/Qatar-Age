/**
 * Seeded pseudo-random number generation for the simulation.
 *
 * `Math.random()` is banned inside src/sim by the lint config. Everything
 * random in the simulation comes from an explicit Rng instance whose seed is
 * part of the game state, which buys three things:
 *
 *   - Save/load reproduces the exact same future (the seed is serialised).
 *   - Bug reports are reproducible from a seed rather than a description. The
 *     Age of Empires team leans on this heavily: because their simulation is
 *     deterministic, a player's replay plus a timestamp is a perfect repro
 *     case. See docs/PATHFINDING_NOTES.md §6.
 *   - Lockstep multiplayer stays reachable without a rewrite.
 *
 * Algorithm is mulberry32: 32-bit state, fast, good enough statistical quality
 * for game purposes, and trivially portable if we ever need another language to
 * produce the identical stream.
 */

export class Rng {
  private state: number

  constructor(seed: number) {
    // Force to uint32. A zero seed is legal for mulberry32 but produces a
    // noticeably poor first few outputs, so nudge it.
    this.state = (seed >>> 0) || 0x9e3779b9
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array')
    return items[Math.floor(this.next() * items.length)]!
  }

  /** In-place Fisher-Yates. Deterministic given the seed. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const a = items[i]!
      const b = items[j]!
      items[i] = b
      items[j] = a
    }
    return items
  }

  /** Serialise for save/load. */
  getState(): number {
    return this.state
  }

  setState(state: number): void {
    this.state = state >>> 0
  }

  /**
   * Derive an independent stream. Useful when one subsystem (map generation,
   * say) should not perturb another's sequence by consuming draws from it.
   */
  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x9e3779b9)) >>> 0)
  }
}
