/**
 * Simulation arithmetic.
 *
 * Every number that affects the simulation goes through this module. That looks
 * like pointless indirection today, because these are all thin wrappers over
 * plain float operations — and for a single-player browser game, floats are the
 * right call.
 *
 * The reason it exists is in docs/PATHFINDING_NOTES.md. The shipping Age of
 * Empires codebase spent 25 years with units walking through walls because its
 * pathfinder needed exact floating-point predicates and silently lost the x87
 * 80-bit intermediate precision it had been relying on. Their fix was to move
 * the geometry to fixed-point arithmetic. openage reached the same conclusion
 * independently and uses fixed-point throughout.
 *
 * We avoid that whole bug class a different way: soft collision (see
 * systems/steering.ts) means no exact geometric predicates anywhere. But if we
 * ever add hard polygon collision or lockstep multiplayer, we inherit the
 * requirement — and then this module becomes a fixed-point implementation and
 * nothing else has to change.
 *
 * The cost of that option is one indirection. Keep it.
 */

export type Scalar = number

export const add = (a: Scalar, b: Scalar): Scalar => a + b
export const sub = (a: Scalar, b: Scalar): Scalar => a - b
export const mul = (a: Scalar, b: Scalar): Scalar => a * b
export const div = (a: Scalar, b: Scalar): Scalar => a / b

export const abs = Math.abs
export const floor = Math.floor
export const ceil = Math.ceil
export const round = Math.round
export const min = Math.min
export const max = Math.max
export const sqrt = Math.sqrt
export const atan2 = Math.atan2
export const sin = Math.sin
export const cos = Math.cos
export const hypot = (dx: Scalar, dy: Scalar): Scalar => Math.sqrt(dx * dx + dy * dy)

export const PI = Math.PI
export const TAU = Math.PI * 2

export function clamp(v: Scalar, lo: Scalar, hi: Scalar): Scalar {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: Scalar, b: Scalar, t: Scalar): Scalar {
  return a + (b - a) * t
}

/** Smallest signed rotation from `from` to `to`, in radians, within (-PI, PI]. */
export function angleDelta(from: Scalar, to: Scalar): Scalar {
  let d = (to - from) % TAU
  if (d > PI) d -= TAU
  if (d <= -PI) d += TAU
  return d
}

/** Normalise an angle into [0, TAU). */
export function normalizeAngle(a: Scalar): Scalar {
  const m = a % TAU
  return m < 0 ? m + TAU : m
}

/**
 * Rotate `from` toward `to` by at most `maxStep` radians.
 * Used by the movement system to model turn rate.
 */
export function rotateToward(from: Scalar, to: Scalar, maxStep: Scalar): Scalar {
  const d = angleDelta(from, to)
  if (abs(d) <= maxStep) return normalizeAngle(to)
  return normalizeAngle(from + Math.sign(d) * maxStep)
}

export function approxEqual(a: Scalar, b: Scalar, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}
