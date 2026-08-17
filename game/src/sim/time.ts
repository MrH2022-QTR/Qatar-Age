/**
 * Simulation time.
 *
 * openage's simulation loop is six lines and has no tick and no fixed timestep:
 * it asks a clock for the current time and tells an event loop to catch up
 * (libopenage/gamestate/simulation.cpp:45). Time is a 64-bit fixed-point value
 * in seconds, and the clock carries a speed multiplier that is allowed to go
 * negative — the architecture contemplates running the simulation backwards.
 *
 * We keep the shape and simplify the representation: float seconds rather than
 * fixed-point (see math.ts for why that is safe here, and what would change if
 * it stopped being safe).
 *
 * The one thing we keep verbatim is the delta clamp. openage caps real elapsed
 * time between updates at 50ms so that a debugger pause cannot fast-forward the
 * game. In a browser this matters *more*, not less: a backgrounded tab throttles
 * requestAnimationFrame, so without the clamp the first frame after the user
 * tabs back carries a multi-second delta and the entire game lurches.
 */

/** Seconds. Kept as a named type so a future fixed-point swap is greppable. */
export type Time = number

/** Matches openage's hardcoded ceiling in Clock::update_time(). */
export const MAX_DELTA = 0.05

/** Floor, so a stalled loop cannot spin at zero delta. */
export const MIN_DELTA = 0.001

export class Clock {
  /** Simulation time. Advances by realDelta * speed. */
  private simTime: Time = 0

  /** Real elapsed time, ignoring speed. Animations use this so they do not
   *  slow down when the player slows the game — openage makes the same split. */
  private realTime: Time = 0

  private speed = 1
  private paused = false

  /**
   * Advance the clock.
   * @param realDeltaSeconds wall-clock seconds since the previous call
   * @returns the simulation delta actually applied
   */
  advance(realDeltaSeconds: number): Time {
    const clamped = Math.min(Math.max(realDeltaSeconds, MIN_DELTA), MAX_DELTA)
    this.realTime += clamped
    if (this.paused) return 0
    const simDelta = clamped * this.speed
    this.simTime += simDelta
    return simDelta
  }

  now(): Time {
    return this.simTime
  }

  realNow(): Time {
    return this.realTime
  }

  getSpeed(): number {
    return this.speed
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, speed)
  }

  isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  togglePause(): void {
    this.paused = !this.paused
  }

  /** For save/load and for the headless fuzz harness, which sets time directly. */
  setTime(t: Time): void {
    this.simTime = t
  }
}
