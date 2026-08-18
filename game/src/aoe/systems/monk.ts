/**
 * Monks: conversion, healing, relics.
 *
 * Conversion (model cross-checked against the wiki, parameters from the dat):
 * attempts run in conversion intervals (CI) of 1.25 game-seconds once in range.
 * The monk's 104-task supplies first-roll and guaranteed CIs (units 5/9,
 * buildings/touch-targets 15/25 with work_range 0.5 = touch). Each CI at or
 * past the first-roll threshold succeeds with p = 0.38 / max(1, level), where
 * level is the target's conversion_chance_mod (scouts 2, buildings 3); success
 * is forced at the guaranteed CI. Target min/max_conversion_time_mods and the
 * DEFENDER's resources 178/179 (Faith, Devotion, Teuton team bonus) add CIs.
 * Chasing keeps CI progress; manual re-orders reset it (order replacement).
 * All monks on the target lose their faith on success unless Theocracy
 * (resource 193), in which case only the converter does. Converted entities
 * lock their stats via snapshot. Faith recharges at the monk's reload_time
 * per second (1.6/s base; Illumination multiplies it) - 100 faith needed to
 * begin a new conversion.
 *
 * Healing: rate = healer work_rate x heal-task value (2.5 hp/s for a monk);
 * additional healers on one target contribute half each (75.(n+1) hp/min).
 * Range is player resource 90 (base 4; Teutons 8). Organic units only.
 * Idle monks auto-heal wounded friendlies in range.
 *
 * Relics: picking one up transforms the monk (125 -> 286, the dat's own
 * mechanism); depositing in a Monastery garrisons it (resource 59 count) and
 * pays resource-191 gold per minute per relic (in upkeep.ts). Death drops it.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import type { TaskData, UnitDef } from "../data/registry.ts";
import { RES, UNIT } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";

const CI_SECONDS = 1.25;
const BASE_CHANCE = 0.38;
const MONK_CLASSES = new Set([18, 43]);
const RELIC_CLASS = 42;
export const MONASTERY = 104;
const MONK = 125;
const MONK_WITH_RELIC = 286;

export function isMonkEntity(game: Game, e: Entity): boolean {
  return MONK_CLASSES.has(game.defOf(e).class);
}

function convertTask(game: Game, monk: Entity, target: Entity): TaskData | null {
  const p = game.players[monk.owner];
  const mDef = p.getType(monk.typeId);
  const tDef = game.defOf(target);
  if (!mDef?.bird) return null;
  let generic: TaskData | null = null;
  for (const t of mDef.bird.tasks) {
    if (t.action_type !== 104) continue;
    if (t.unit_id >= 0 && t.unit_id === target.typeId) return t;
    if (t.class_id >= 0 && t.class_id === tDef.class) return t;
    if (t.class_id === -1 && t.unit_id === -1) generic = t;
  }
  return generic;
}

/** Wiki-rule eligibility on top of the task list, gated by capability resources. */
function convertible(game: Game, monk: Entity, target: Entity): boolean {
  if (target.owner === monk.owner || target.owner < 0) return false;
  const p = game.players[monk.owner];
  const tDef = game.defOf(target);
  if (tDef.creatable?.hero_mode && (tDef.creatable.hero_mode & 1) !== 0) return false;
  if (MONK_CLASSES.has(tDef.class)) return p.resources[RES.CONVERT_PRIEST] >= 1;
  if (tDef.type === 80) {
    if (p.resources[RES.CONVERT_BUILDING] < 1) return false;
    // never: town centers, castles, wonders, walls, gates, farms, monasteries under siege? -
    // the documented exclusion list
    const never = new Set<number>([82, UNIT.FARM, 276]); // castle, farm, wonder
    if (never.has(target.typeId)) return false;
    if (game.familyOf(UNIT.TOWN_CENTER, p).has(target.typeId) || target.typeId === 71) return false;
    if (tDef.class === 20 || tDef.class === 27) return false; // walls, gates
    return true;
  }
  if (tDef.class === 13 || tDef.class === 55) {
    // mechanical siege needs Redemption's second flag
    return (game.players[monk.owner].resources[29] ?? 0) >= 1;
  }
  if (tDef.type !== 70) return false;
  return true;
}

function conversionWindow(game: Game, monk: Entity, target: Entity, task: TaskData) {
  const tDef = game.defOf(target);
  const defender = target.owner >= 0 ? game.players[target.owner] : null;
  const minMod = tDef.creatable?.min_conversion_time_mod ?? 0;
  const maxMod = tDef.creatable?.max_conversion_time_mod ?? 0;
  const resistMin = defender ? defender.resources[RES.CONV_RESIST_MIN] : 0;
  const resistMax = defender ? defender.resources[RES.CONV_RESIST_MAX] : 0;
  const first = (task.work_value_1 ?? 5) + minMod + resistMin;
  const guaranteed = (task.work_value_2 ?? 9) + maxMod + resistMax;
  const level = tDef.creatable?.conversion_chance_mod ?? 0;
  return { first, guaranteed, chance: BASE_CHANCE / Math.max(1, level) };
}

export function convertEntity(game: Game, target: Entity, newOwner: number): void {
  const oldOwner = target.owner;
  const def = game.defOf(target);
  // stats lock at the moment of conversion
  target.snapshot = structuredClone(def);
  if (oldOwner >= 0 && def.type !== 80) game.popUsed[oldOwner] -= game.popCostOf(def);
  if (newOwner >= 0 && def.type !== 80) game.popUsed[newOwner] += game.popCostOf(def);
  if (def.type === 80) {
    const st = def.storages?.find((s) => s.type === 4);
    if (st && st.amount) {
      if (oldOwner >= 0) game.popHeadroom[oldOwner] -= st.amount;
      game.popHeadroom[newOwner] += st.amount;
    }
  }
  target.owner = newOwner;
  target.orders = [];
  target.path = [];
  target.state = "idle";
}

function onConversionSuccess(game: Game, converter: Entity, target: Entity): void {
  convertEntity(game, target, converter.owner);
  const theocracy = (game.players[converter.owner].resources[RES.THEOCRACY] ?? 0) >= 1;
  for (const e of game.entities.values()) {
    if (e.owner !== converter.owner || !isMonkEntity(game, e)) continue;
    if (e.ciTargetId === target.id) {
      if (!theocracy || e.id === converter.id) e.faith = 0;
      e.ci = 0;
      e.ciTimer = 0;
      e.ciTargetId = 0;
      if (e.orders[0]?.kind === "convert" && e.orders[0].targetId === target.id) e.orders.shift();
      e.state = "idle";
    }
  }
}

function touchRange(game: Game, monk: Entity, target: Entity, extra: number): number {
  const tDef = game.defOf(target);
  const mDef = game.defOf(monk);
  return Math.max(tDef.radius[0], tDef.radius[1]) + Math.max(mDef.radius[0], mDef.radius[1]) + 0.15 + extra;
}

export function stepMonk(game: Game, dt: number): void {
  // heal registry: targetId -> healer rates (hp/s each at full strength)
  const healers = new Map<number, number[]>();

  for (const e of game.entities.values()) {
    if (e.state === "dead" || e.state === "projectile") continue;
    if (!isMonkEntity(game, e)) continue;
    const p = game.players[e.owner];
    const def = p.getType(e.typeId)!;
    const speed = def.speed ?? 0.7;
    const order = e.orders[0];

    if (order?.kind === "convert") {
      const target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
      if (!target || !convertible(game, e, target)) {
        e.orders.shift();
        e.ci = 0;
        e.ciTargetId = 0;
        e.state = "idle";
        continue;
      }
      const task = convertTask(game, e, target);
      if (!task) {
        e.orders.shift();
        continue;
      }
      // switching from a building target resets; unit-to-unit keeps progress
      if (e.ciTargetId !== 0 && e.ciTargetId !== target.id) {
        const prev = game.entities.get(e.ciTargetId);
        if (!prev || game.defOf(prev).type === 80) {
          e.ci = 0;
          e.ciTimer = 0;
        }
      }
      e.ciTargetId = target.id;
      if (e.ci === 0 && e.faith < 100) {
        // must be at full faith to begin a conversion
        continue;
      }
      const range = task.work_range > 0
        ? touchRange(game, e, target, 0.35)
        : (def.combat?.max_range ?? 9) + Math.max(game.defOf(target).radius[0], game.defOf(target).radius[1]);
      const dist = Math.hypot(target.x - e.x, target.y - e.y);
      if (dist > range) {
        // chase: CI progress is retained
        if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
        followPath(game, e, speed, dt);
        e.state = "moving";
        continue;
      }
      e.path = [];
      e.state = "attacking"; // converting; reuses the busy state
      e.ciTimer += dt;
      while (e.ciTimer >= CI_SECONDS) {
        e.ciTimer -= CI_SECONDS;
        e.ci++;
        const w = conversionWindow(game, e, target, task);
        if (e.ci >= w.guaranteed || (e.ci >= w.first && game.rng.chance(w.chance))) {
          onConversionSuccess(game, e, target);
          break;
        }
      }
      continue;
    }

    if (order?.kind === "heal") {
      const target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
      if (!target || target.owner !== e.owner || !healable(game, target) || target.hp >= game.defOf(target).hp) {
        e.orders.shift();
        e.state = "idle";
        continue;
      }
      const range = (p.resources[RES.HEAL_RANGE] || 4) + Math.max(game.defOf(target).radius[0], game.defOf(target).radius[1]);
      const dist = Math.hypot(target.x - e.x, target.y - e.y);
      if (dist > range) {
        if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
        followPath(game, e, speed, dt);
        continue;
      }
      e.path = [];
      e.state = "attacking";
      registerHealer(healers, game, e, target);
      continue;
    }

    if (order?.kind === "garrison") {
      // relic deposit / monastery garrison
      const target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
      if (!target || target.owner !== e.owner) {
        e.orders.shift();
        continue;
      }
      const dist = Math.hypot(target.x - e.x, target.y - e.y);
      if (dist > touchRange(game, e, target, 0.4)) {
        if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
        followPath(game, e, speed, dt);
        continue;
      }
      if (e.hasRelic && game.familyOf(MONASTERY, p).has(target.typeId)) {
        target.relics++;
        game.relicsGarrisoned[e.owner]++;
        e.hasRelic = false;
        e.typeId = MONK;
      }
      e.orders.shift();
      e.state = "idle";
      continue;
    }

    if (order?.kind === "gather") {
      // relic pickup rides the gather order
      const target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
      if (target && game.defOf(target).class === RELIC_CLASS) {
        const dist = Math.hypot(target.x - e.x, target.y - e.y);
        if (dist > touchRange(game, e, target, 0.35)) {
          if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
          followPath(game, e, speed, dt);
          continue;
        }
        game.map.unindexEntity(target);
        game.entities.delete(target.id);
        e.typeId = MONK_WITH_RELIC; // the dat's own carry mechanism (task 132)
        e.hasRelic = true;
        e.orders.shift();
        e.state = "idle";
        continue;
      }
    }

    // idle: auto-heal a wounded friendly in range
    if (!order && e.state === "idle" && e.faith >= 0) {
      const range = p.resources[RES.HEAL_RANGE] || 4;
      let best: Entity | null = null;
      let bestD = Infinity;
      for (const id of game.map.idsNear(e.x, e.y, range)) {
        const t = game.entities.get(id);
        if (!t || t.owner !== e.owner || t.id === e.id) continue;
        if (!healable(game, t)) continue;
        const tD = game.defOf(t);
        if (t.hp >= tD.hp) continue;
        const d = Math.hypot(t.x - e.x, t.y - e.y);
        if (d <= range && d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (best) registerHealer(healers, game, e, best);
    }
  }

  // apply healing: strongest healer full rate, the rest half (75(n+1) hp/min shape)
  for (const [tid, rates] of healers) {
    const t = game.entities.get(tid);
    if (!t) continue;
    rates.sort((a, b) => b - a);
    let rate = 0;
    rates.forEach((r, i) => (rate += i === 0 ? r : r / 2));
    t.hp = Math.min(game.defOf(t).hp, t.hp + rate * dt);
  }
}

function healable(game: Game, t: Entity): boolean {
  const def = game.defOf(t);
  if (def.type !== 70) return false;
  if (t.state === "corpse" || t.state === "projectile") return false;
  // organic only: no mechanical siege, no ships
  if (def.class === 13 || def.class === 55 || def.class === 51) return false;
  if (def.class === 2 || def.class === 21 || def.class === 22 || def.class === 53) return false;
  return true;
}

function registerHealer(healers: Map<number, number[]>, game: Game, monk: Entity, target: Entity): void {
  const p = game.players[monk.owner];
  const def = p.getType(monk.typeId)!;
  const healTask = def.bird?.tasks.find((t) => t.action_type === 105);
  const rate = (def.bird?.work_rate ?? 1) * (healTask?.work_value_1 ?? 2);
  let arr = healers.get(target.id);
  if (!arr) healers.set(target.id, (arr = []));
  arr.push(rate);
  monk.state = "attacking";
}
