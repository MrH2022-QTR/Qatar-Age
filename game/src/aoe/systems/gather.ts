/**
 * Villager economy: the dat models each job as its own unit (VMLUM, VMSHE, ...).
 * A villager ordered to gather morphs into the matching job unit - so work rates,
 * carry capacities, combat stats and drop sites all come straight from the job
 * unit's (player-modified) def, and every economy tech applies by mutating those
 * defs, never by engine special-cases.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import type { UnitDef } from "../data/registry.ts";
import { UNIT } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";
import { meleeHit } from "./damage.ts";

const JOB_IDS = [
  UNIT.VIL_FARMER,
  UNIT.VIL_FORAGER,
  UNIT.VIL_HUNTER,
  UNIT.VIL_SHEPHERD,
  UNIT.VIL_FISHER,
  UNIT.VIL_LUMBERJACK,
  UNIT.VIL_STONE_MINER,
  UNIT.VIL_GOLD_MINER,
];

const VILLAGER_IDS = new Set<number>([UNIT.VILLAGER_M, UNIT.VILLAGER_F, ...JOB_IDS, UNIT.VIL_BUILDER, UNIT.VIL_REPAIRER]);

export function isVillager(typeId: number): boolean {
  return VILLAGER_IDS.has(typeId);
}

let corpseSource: Map<number, number> | null = null;

/** corpse type -> the live animal type that produces it (dead_unit chains). */
function corpseSourceMap(game: Game): Map<number, number> {
  if (!corpseSource) {
    corpseSource = new Map();
    for (const [id, def] of game.data.units) {
      if (def.dead_unit >= 0 && def.storages?.some((s) => s.type === 0 && s.amount > 0)) {
        let cur = def.dead_unit;
        const seen = new Set<number>();
        while (cur >= 0 && !seen.has(cur)) {
          seen.add(cur);
          if (!corpseSource.has(cur)) corpseSource.set(cur, id);
          cur = game.data.units.get(cur)?.dead_unit ?? -1;
        }
      }
    }
  }
  return corpseSource;
}

/** The unit a task list should be matched against: corpses match as their source animal. */
function taskMatchDef(game: Game, target: Entity) {
  const tDef = game.defOf(target);
  if (tDef.type === 30 || target.state === "corpse") {
    const src = corpseSourceMap(game).get(target.typeId);
    if (src !== undefined) return { def: game.data.units.get(src)!, typeId: src };
  }
  return { def: tDef, typeId: target.typeId };
}

/** Pick the job unit whose task list covers this target (class or exact id).
 *  Hunt tasks (action 110) cover both the live animal and its carcass.
 *  Villagers morph through their job units; self-gatherers like fishing ships
 *  carry their own task list and are their own job. */
export function jobForTarget(game: Game, playerId: number, target: Entity, gatherer?: Entity): number {
  const m = taskMatchDef(game, target);
  const p = game.players[playerId];
  if (gatherer && !isVillager(gatherer.typeId)) {
    const own = p.getType(gatherer.typeId);
    if (own?.bird) {
      for (const task of own.bird.tasks) {
        if (task.action_type !== 5 && task.action_type !== 110) continue;
        if ((task.unit_id >= 0 && task.unit_id === m.typeId) || (task.class_id >= 0 && task.class_id === m.def.class)) {
          return gatherer.typeId;
        }
      }
    }
    return 0;
  }
  for (const jobId of JOB_IDS) {
    const jd = p.getType(jobId);
    if (!jd?.bird) continue;
    for (const task of jd.bird.tasks) {
      if (task.action_type !== 5 && task.action_type !== 110) continue; // gather / hunt
      if (task.unit_id >= 0 && task.unit_id === m.typeId) return jobId;
      if (task.class_id >= 0 && task.class_id === m.def.class) return jobId;
    }
  }
  return 0;
}

function taskFor(game: Game, e: Entity, target: Entity) {
  const p = game.players[e.owner];
  const jd = p.getType(e.jobTypeId);
  const m = taskMatchDef(game, target);
  if (!jd?.bird) return null;
  for (const task of jd.bird.tasks) {
    if (task.action_type !== 5 && task.action_type !== 110) continue;
    if (task.unit_id >= 0 && task.unit_id === m.typeId) return task;
    if (task.class_id >= 0 && task.class_id === m.def.class) return task;
  }
  return null;
}

function withinRange(game: Game, e: Entity, t: Entity, extra: number): boolean {
  const tDef = game.defOf(t);
  const r = Math.max(tDef.radius[0], tDef.radius[1]) + 0.35 + extra;
  return Math.hypot(t.x - e.x, t.y - e.y) <= r;
}

function moveToward(game: Game, e: Entity, t: Entity, speed: number, dt: number): void {
  if (e.path.length === 0) {
    e.path = findPath(game, e, t.x, t.y);
  }
  followPath(game, e, speed, dt);
}

/** Expand a drop-site list through the player's upgrade chains (feudal TC etc.). */
function dropSiteSet(game: Game, playerId: number, jobDef: UnitDef): Set<number> {
  const p = game.players[playerId];
  const out = new Set<number>();
  for (const base of jobDef.bird?.drop_sites ?? []) {
    for (const id of game.familyOf(base, p)) out.add(id);
  }
  return out;
}

function nearestDropSite(game: Game, e: Entity, jobDef: UnitDef): Entity | null {
  const sites = dropSiteSet(game, e.owner, jobDef);
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const b of game.entities.values()) {
    if (b.owner !== e.owner || b.state === "foundation") continue;
    if (!sites.has(b.typeId)) continue;
    const d = Math.hypot(b.x - e.x, b.y - e.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Find a replacement target of the same kind near the exhausted one. */
function similarTargetNear(game: Game, e: Entity, dead: Entity, radius: number): Entity | null {
  const deadDef = game.data.units.get(dead.typeId);
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const id of game.map.idsNear(dead.x, dead.y, radius)) {
    const t = game.entities.get(id);
    if (!t || t.id === dead.id || t.owner !== -1) continue;
    if (t.resAmount <= 0) continue;
    const tDef = game.data.units.get(t.typeId);
    if (!tDef || !deadDef) continue;
    if (tDef.class !== deadDef.class) continue;
    const d = Math.hypot(t.x - e.x, t.y - e.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function stepGather(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    const order = e.orders[0];
    if (!order || order.kind !== "gather") continue;
    const pSelf = game.players[e.owner];
    const selfDef = pSelf.getType(e.typeId);
    const selfGathers = !!selfDef?.bird?.tasks.some((t) => t.action_type === 5 || t.action_type === 110);
    if (!isVillager(e.typeId) && e.jobTypeId === 0 && !selfGathers) continue;
    const p = pSelf;

    // returning runs FIRST and never depends on the target still existing -
    // a villager whose animal rotted away mid-trip still banks the load
    if (e.state === "returning" && e.jobTypeId !== 0) {
      const jobDef = p.getType(e.jobTypeId)!;
      const speed = p.getType(e.typeId)?.speed ?? 0.8;
      const site = nearestDropSite(game, e, jobDef);
      if (!site) {
        e.state = "idle";
        e.orders.shift();
        continue;
      }
      if (withinRange(game, e, site, 0.5)) {
        if (e.carry) {
          p.resources[e.carry[0] === 15 ? 0 : e.carry[0]] += e.carry[1];
          e.carry = null;
        }
        e.state = "idle";
        e.path = [];
      } else {
        moveToward(game, e, site, speed, dt);
      }
      continue;
    }

    let target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
    // farms: retarget to the farm entity while it survives; others: replacement search
    if (!target || (target.resAmount <= 0 && target.state !== "foundation")) {
      const old = target;
      target = undefined;
      if (old) {
        const repl = similarTargetNear(game, e, old, 6);
        if (repl) {
          order.targetId = repl.id;
          target = repl;
        }
      }
      if (!target) {
        // nothing left: deposit what we carry, then idle
        if (e.carry && e.carry[1] > 0) {
          startReturn(game, e);
        } else {
          e.orders.shift();
          e.state = "idle";
          e.jobTypeId = 0;
        }
        continue;
      }
    }

    // assign job
    const jobId = jobForTarget(game, e.owner, target, e);
    if (jobId === 0) {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    if (e.jobTypeId !== jobId) {
      // switching resource type drops the carried load of a different resource
      const jd = p.getType(jobId)!;
      const task = null;
      e.jobTypeId = jobId;
      e.path = [];
    }
    const jobDef = p.getType(e.jobTypeId)!;
    const speed = p.getType(e.typeId)?.speed ?? 0.8;

    // animal still alive -> kill it first (hunter/shepherd job combat stats)
    const isAnimal = target.hp > 0 && (game.defOf(target).speed ?? 0) >= 0 && game.defOf(target).combat !== undefined && target.state !== "corpse" && game.defOf(target).type === 70;
    if (isAnimal && target.hp > 0) {
      if (!withinRange(game, e, target, (jobDef.combat?.max_range ?? 0))) {
        moveToward(game, e, target, speed, dt);
        continue;
      }
      e.path = [];
      e.reloadLeft -= dt;
      if (e.reloadLeft <= 0) {
        e.reloadLeft = jobDef.combat?.reload_time ?? 2;
        const deadX = target.x;
        const deadY = target.y;
        const deadId = target.id;
        const dead = meleeHit(game, e, jobDef, target);
        if (dead) {
          // corpse spawned by kill(); repoint EVERY hunter of this animal at it
          let corpse: Entity | null = null;
          for (const id of game.map.idsNear(deadX, deadY, 1.5)) {
            const c = game.entities.get(id);
            if (c && c.state === "corpse" && c.resAmount > 0) {
              corpse = c;
              break;
            }
          }
          if (corpse) {
            for (const other of game.entities.values()) {
              const oo = other.orders[0];
              if (oo && oo.kind === "gather" && oo.targetId === deadId) {
                oo.targetId = corpse.id;
              }
            }
          }
        }
      }
      continue;
    }

    // gather proper
    if (!withinRange(game, e, target, 0)) {
      moveToward(game, e, target, speed, dt);
      continue;
    }
    e.path = [];
    e.state = "gathering";
    const task = taskFor(game, e, target);
    const res = task ? (task.resource_out >= 0 ? task.resource_out : task.resource_in) : (target.resType >= 0 ? target.resType : 0);
    const rate = (jobDef.bird?.work_rate ?? 0) * (task?.work_value_1 || 1);
    const capacity = jobDef.resource_capacity;

    // farms draw from the player's farm-food pool (resource 36) via the farm entity
    let avail: number;
    const tDefNow = game.defOf(target);
    const isPoolFarm = target.typeId === UNIT.FARM || tDefNow.class === 49;
    const poolRes = tDefNow.terrain_restriction === 13 ? 88 : 36; // fish trap vs farm
    if (isPoolFarm) {
      const cap = p.resources[poolRes];
      avail = Math.max(0, cap - target.timer); // timer reused as foodTaken
    } else {
      avail = target.resAmount;
    }
    if (avail <= 0) {
      if (isPoolFarm) {
        const fx = target.x;
        const fy = target.y;
        const respawnType = target.typeId;
        game.kill(target); // farm or trap exhausted
        if (game.autoReseed[e.owner]) {
          const fresh = game.placeFoundation(e.owner, respawnType, fx, fy);
          if (fresh) {
            e.orders = [
              { kind: "build", targetId: fresh.id },
              { kind: "gather", targetId: fresh.id },
            ];
            e.state = "idle";
            continue;
          }
        }
      }
      continue;
    }
    if (e.carry && e.carry[0] !== res) e.carry = null;
    const carried = e.carry ? e.carry[1] : 0;
    const take = Math.min(rate * dt, avail, capacity - carried);
    if (take > 0) {
      e.carry = [res, carried + take];
      if (isPoolFarm) {
        target.timer += take;
      } else {
        target.resAmount -= take;
        // gathered corpses / animals decay once touched (0.25/s style, from the def)
        if (target.state === "corpse") target.attackReady = true; // mark "opened"
      }
    }
    if (e.carry && e.carry[1] >= capacity - 1e-9) {
      startReturn(game, e);
    } else if (target.resAmount <= 0 && target.state === "corpse") {
      game.entities.delete(target.id);
      game.map.unindexEntity(target);
    }
  }
}

function startReturn(game: Game, e: Entity): void {
  e.state = "returning";
  e.path = [];
}
