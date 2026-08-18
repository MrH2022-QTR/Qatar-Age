/**
 * A simple computer opponent: runs a standard-ish opening (villagers to sheep,
 * berries and wood, houses ahead of pop, loom, feudal at ~22 pop), adds a
 * barracks and archery range, and throws attack waves at the nearest enemy.
 * It plays by the same rules as a human - every action goes through the same
 * public Game commands. It is a sparring partner, not a ladder player.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import { RES, TECH, UNIT } from "../data/registry.ts";
import { jobForTarget } from "../systems/gather.ts";

const BARRACKS = 12;
const ARCHERY = 87;
const SKIRM = 7;
const ARCHER = 4;

export class SimpleAI {
  private waveTimer = 60;
  readonly playerId: number;
  constructor(playerId: number) {
    this.playerId = playerId;
  }

  step(game: Game, dt: number): void {
    const p = game.players[this.playerId];
    if (!p || game.defeated[this.playerId]) return;

    const mine: Entity[] = [];
    for (const e of game.entities.values()) if (e.owner === this.playerId) mine.push(e);
    const tc = mine.find((e) => game.familyOf(UNIT.TOWN_CENTER, p).has(e.typeId) && e.state !== "foundation");
    const vills = mine.filter((e) => game.defOf(e).class === 4);
    const military = mine.filter((e) => {
      const d = game.defOf(e);
      return d.type === 70 && d.class !== 4 && d.combat && d.combat.attacks.length > 0 && d.class !== 18;
    });

    // --- economy ------------------------------------------------------------------------
    if (tc) {
      if (vills.length < 24 && tc.queue.length < 2) game.trainUnit(this.playerId, tc.id, UNIT.VILLAGER_M);
      if (!p.researched.has(TECH.LOOM) && p.resources[RES.GOLD] >= 50 && vills.length > 8) {
        game.researchTech(this.playerId, tc.id, TECH.LOOM);
      }
      if (p.canResearch(TECH.FEUDAL_AGE) && p.resources[RES.FOOD] >= 500 + 60 && tc.queue.length === 0) {
        game.researchTech(this.playerId, tc.id, TECH.FEUDAL_AGE);
      }
    }

    // housing ahead of the cap
    const headroom = Math.min(game.popHeadroom[this.playerId], game.config.popCap) - game.popUsed[this.playerId];
    const housesBuilding = mine.some((e) => e.state === "foundation" && e.typeId === UNIT.HOUSE);
    if (headroom < 3 && !housesBuilding && p.resources[RES.WOOD] >= 25 && tc) {
      const spot = this.buildSpot(game, tc, 6);
      if (spot) {
        const f = game.placeFoundation(this.playerId, UNIT.HOUSE, spot.x, spot.y);
        if (f) this.sendBuilder(game, vills, f);
      }
    }

    // idle villagers to work: roughly 60% food, 30% wood, rest gold
    for (const v of vills) {
      if (v.orders.length > 0 || v.state !== "idle") continue;
      let onFood = 0;
      let onWood = 0;
      let onGold = 0;
      for (const x of vills) {
        const r = this.gatherRes(game, x);
        if (r === 0) onFood++;
        else if (r === 1) onWood++;
        else if (r === 3) onGold++;
      }
      const working = onFood + onWood + onGold + 1;
      const want: number = onFood < working * 0.55 ? 0 : onWood < working * 0.35 ? 1 : 3;
      const target = this.nearestGatherable(game, v, want) ?? this.nearestGatherable(game, v, want === 0 ? 1 : 0);
      if (target) game.order(this.playerId, [v.id], { kind: "gather", targetId: target.id });
    }

    // military production buildings once feudal-bound
    if (tc && vills.length >= 12) {
      const haveBarracks = mine.some((e) => game.familyOf(BARRACKS, p).has(e.typeId));
      if (!haveBarracks && p.resources[RES.WOOD] >= 175) {
        const spot = this.buildSpot(game, tc, 9);
        if (spot) {
          const f = game.placeFoundation(this.playerId, BARRACKS, spot.x, spot.y);
          if (f) this.sendBuilder(game, vills, f);
        }
      }
      const haveRange = mine.some((e) => game.familyOf(ARCHERY, p).has(e.typeId));
      if (haveBarracks && !haveRange && p.currentAge() >= 1 && p.resources[RES.WOOD] >= 175) {
        const spot = this.buildSpot(game, tc, 10);
        if (spot) {
          const f = game.placeFoundation(this.playerId, ARCHERY, spot.x, spot.y);
          if (f) this.sendBuilder(game, vills, f);
        }
      }
    }

    // train army
    for (const b of mine) {
      if (b.state === "foundation" || b.queue.length >= 2) continue;
      if (game.familyOf(BARRACKS, p).has(b.typeId)) game.trainUnit(this.playerId, b.id, UNIT.MILITIA);
      else if (game.familyOf(ARCHERY, p).has(b.typeId)) {
        if (!game.trainUnit(this.playerId, b.id, ARCHER)) game.trainUnit(this.playerId, b.id, SKIRM);
      }
    }

    // --- attack waves -------------------------------------------------------------------
    this.waveTimer -= dt;
    if (this.waveTimer <= 0 && military.length >= 8) {
      this.waveTimer = 90;
      const target = this.enemyLandmark(game);
      if (target) {
        game.order(
          this.playerId,
          military.map((m) => m.id),
          { kind: "attack_move", x: target.x, y: target.y },
        );
      }
    } else if (this.waveTimer <= 0) {
      this.waveTimer = 30;
    }
  }

  private gatherRes(game: Game, v: Entity): number {
    const o = v.orders[0];
    if (!o || o.kind !== "gather" || o.targetId === undefined) return -1;
    const t = game.entities.get(o.targetId);
    return t ? t.resType : -1;
  }

  private nearestGatherable(game: Game, v: Entity, resType: number): Entity | null {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of game.entities.values()) {
      if (e.owner !== -1 && e.owner !== this.playerId) continue;
      if (e.resAmount <= 0 || (e.resType !== resType && !(resType === 0 && e.state === "corpse"))) continue;
      const def = game.data.units.get(e.typeId);
      // never send lone villagers at live boars/predators
      if (def && def.class === 10 && e.hp > 0) continue;
      if (jobForTarget(game, this.playerId, e) === 0) continue;
      const d = Math.hypot(e.x - v.x, e.y - v.y);
      if (d < bestD && d < 28) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private buildSpot(game: Game, tc: Entity, r: number): { x: number; y: number } | null {
    for (let i = 0; i < 20; i++) {
      const ang = game.rng.range(0, Math.PI * 2);
      const d = r + game.rng.range(0, 3);
      const x = Math.round(tc.x + Math.cos(ang) * d);
      const y = Math.round(tc.y + Math.sin(ang) * d);
      if (game.map.isFreeForFootprint(x, y, 1.6, 1.6)) return { x, y };
    }
    return null;
  }

  private sendBuilder(game: Game, vills: Entity[], f: Entity): void {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const v of vills) {
      const d = Math.hypot(v.x - f.x, v.y - f.y);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) game.order(this.playerId, [best.id], { kind: "build", targetId: f.id });
  }

  private enemyLandmark(game: Game): Entity | null {
    for (const e of game.entities.values()) {
      if (e.owner < 0 || e.owner === this.playerId || game.areAllied(e.owner, this.playerId)) continue;
      if (game.defOf(e).type === 80) return e;
    }
    for (const e of game.entities.values()) {
      if (e.owner >= 0 && e.owner !== this.playerId && !game.areAllied(e.owner, this.playerId)) return e;
    }
    return null;
  }
}
