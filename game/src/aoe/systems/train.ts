/**
 * Production queues: units and researches share one queue per building, front
 * item active. Costs were paid at enqueue; population is claimed when a unit
 * STARTS (housed blocks the start, not the queue). Research completion routes
 * through Player.markResearched -> effect application -> auto-tech fixpoint,
 * which is how age-ups cascade availability.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";

export function stepProduction(game: Game, dt: number): void {
  for (const b of game.entities.values()) {
    if (b.queue.length === 0 || b.state === "foundation") continue;
    const p = game.players[b.owner];
    if (!p) continue;
    const item = b.queue[0];

    if (!item.started) {
      if (item.kind === "unit") {
        const produced = p.resolveUpgrade(item.id);
        const def = p.getType(produced);
        if (!def) {
          b.queue.shift();
          continue;
        }
        if (!game.housedCheck(b.owner, def)) continue; // housed: stall the queue
        game.popUsed[b.owner] += game.popCostOf(def);
        // train time follows the produced unit's current def
        item.timeLeft = def.creatable?.train_locations[0]?.train_time ?? item.timeLeft;
        item.started = true;
      } else {
        item.started = true;
      }
    }

    // production speed scales with the building's work rate (attr 13 effects)
    const bDef = game.defOf(b);
    const wr = bDef.bird?.work_rate && bDef.bird.work_rate > 0 ? bDef.bird.work_rate : 1;
    item.timeLeft -= dt * wr;
    if (item.timeLeft > 0) continue;
    b.queue.shift();

    if (item.kind === "unit") {
      const produced = p.resolveUpgrade(item.id);
      const def = p.getType(produced)!;
      const spot = game.findFreeSpotNear(b, def);
      if (spot) {
        const u = game.spawn(b.owner, produced, spot.x, spot.y);
        game.popUsed[b.owner] -= game.popCostOf(def); // spawn() claimed it again
        if (b.rallyX >= 0) {
          const rallyTarget = game.entities.get(b.targetId);
          if (rallyTarget && rallyTarget.owner === -1 && rallyTarget.resAmount > 0) {
            u.orders = [{ kind: "gather", targetId: rallyTarget.id }];
          } else {
            u.orders = [{ kind: "move", x: b.rallyX, y: b.rallyY }];
          }
        }
      }
    } else {
      p.markResearched(item.id);
      p.runAutoTechs();
    }
  }
}
