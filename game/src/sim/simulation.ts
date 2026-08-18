/**
 * The simulation: system order and the step function.
 *
 * openage has no tick and no fixed timestep — its loop asks a clock for the
 * time and tells an event loop to catch up, and ordering emerges from event
 * timestamps (docs/ARCHITECTURE.md §3). docs/SYSTEMS.md §2 recommends keeping
 * the event-driven model for its big win (a unit walking for 8 seconds costs
 * zero CPU during those 8 seconds) while conceding that some things are
 * naturally periodic.
 *
 * What is implemented here is the pragmatic middle: a stepped simulation with
 * an explicit, documented system order, plus a scheduled-event queue for things
 * that are genuinely "happen later" (construction completing, research
 * finishing, an attack cooldown elapsing). That gives us the event model's
 * expressiveness where it pays, and a debuggable step order everywhere else.
 *
 * The system order below is deliberate and worth reading before changing:
 *
 *   1. reindex   — spatial index must reflect last frame's final positions
 *   2. events    — scheduled work fires before anything reads its results
 *   3. movement  — consume paths, translate, rotate
 *   4. steering  — resolve overlaps created by movement, never before it
 *   5. cleanup   — remove the dead once nothing else will look at them
 *
 * Steering after movement is the ordering that matters most: reversing it means
 * separation resolves against stale positions and units visibly jitter.
 */

import { Clock } from './time'
import type { GameWorld } from './world'
import { movementSystem } from './systems/movement'
import { steeringSystem } from './systems/steering'

export interface ScheduledEvent {
  at: number
  kind: string
  entityId?: number
  playerId?: number
  payload?: Record<string, unknown>
}

/**
 * Minimal scheduled-event queue.
 *
 * Kept sorted by time. This is openage's event loop reduced to what we
 * currently need — no dependency tracking, no rescheduling on change, no
 * settling loop. Those are worth adding when something needs them; adding them
 * speculatively would buy complexity we cannot yet debug.
 */
export class EventQueue {
  private events: ScheduledEvent[] = []

  schedule(e: ScheduledEvent): void {
    // Insertion sort from the back: events are usually scheduled in roughly
    // increasing time order, so this is near O(1) in practice.
    let i = this.events.length - 1
    while (i >= 0 && this.events[i]!.at > e.at) i--
    this.events.splice(i + 1, 0, e)
  }

  /** Pop everything due at or before `time`, in time order. */
  drain(time: number): ScheduledEvent[] {
    let count = 0
    while (count < this.events.length && this.events[count]!.at <= time) count++
    return count === 0 ? [] : this.events.splice(0, count)
  }

  cancelForEntity(entityId: number): void {
    this.events = this.events.filter((e) => e.entityId !== entityId)
  }

  get pending(): number {
    return this.events.length
  }

  /** For the debug overlay: the next few scheduled events. */
  peek(n: number): readonly ScheduledEvent[] {
    return this.events.slice(0, n)
  }
}

export type EventHandler = (world: GameWorld, sim: Simulation, event: ScheduledEvent) => void

export class Simulation {
  readonly world: GameWorld
  readonly clock = new Clock()
  readonly events = new EventQueue()

  private handlers = new Map<string, EventHandler>()
  private pendingRemoval: number[] = []

  /** Rolling per-system timings, for the debug overlay. */
  readonly timings: Record<string, number> = {}

  constructor(world: GameWorld) {
    this.world = world
  }

  on(kind: string, handler: EventHandler): void {
    this.handlers.set(kind, handler)
  }

  /** Mark an entity for removal at the end of the current step. */
  destroy(entityId: number): void {
    this.pendingRemoval.push(entityId)
  }

  /**
   * Advance the simulation by one frame.
   * @param realDelta wall-clock seconds since the previous call
   */
  step(realDelta: number): void {
    const dt = this.clock.advance(realDelta)
    if (dt <= 0) return // paused

    const now = this.clock.now()
    this.world.pathfinder.beginFrame()

    this.time('reindex', () => this.world.reindex())

    this.time('events', () => {
      for (const ev of this.events.drain(now)) {
        this.handlers.get(ev.kind)?.(this.world, this, ev)
      }
    })

    this.time('movement', () => movementSystem(this.world, dt))
    this.time('steering', () => steeringSystem(this.world, dt))

    this.time('cleanup', () => {
      if (this.pendingRemoval.length === 0) return
      for (const id of this.pendingRemoval) {
        const e = this.world.get(id)
        if (e) {
          this.events.cancelForEntity(id)
          this.world.remove(e)
        }
      }
      this.pendingRemoval.length = 0
    })
  }

  private time(name: string, fn: () => void): void {
    const t0 = performance.now()
    fn()
    // Exponential moving average, so the overlay is readable rather than noisy.
    const prev = this.timings[name] ?? 0
    this.timings[name] = prev * 0.9 + (performance.now() - t0) * 0.1
  }
}
