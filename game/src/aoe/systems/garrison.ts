/**
 * Garrisoning: entry rules from the building's garrison_type bitmask
 * (1 villagers, 2 foot military, 4 cavalry, 8 monks, 16 herdables - TC/towers
 * 11, castles 15, per the dat), capacity from garrison_capacity. Garrisoned
 * units leave the spatial index (untargetable), heal at the building's
 * garrison_heal_rate (castle 0.2/s, TC/towers 0.1/s, x6 with Herbal Medicine),
 * add arrows to defensive fire (combat.ts), and die with the building.
 * Rams take infantry (speed bonus per unit). Production buildings with
 * capacity but mask 0 accept what they train, plus monks at the monastery.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import type { UnitDef } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";
import { MONASTERY } from "./monk.ts";

const FOOT_ARCHER_CLASSES = new Set([0, 36, 23, 44]); // archer, cav archer excluded below
const INFANTRY_CLASSES = new Set([6, 56]);
const CAVALRY_CLASSES = new Set([12, 47, 23, 46]);
const MONK_CLASSES = new Set([18, 43]);

function categoryBit(def: UnitDef): number {
  if (def.class === 4) return 1; // villagers
  if (MONK_CLASSES.has(def.class)) return 8;
  if (def.class === 58) return 16; // herdables
  if (CAVALRY_CLASSES.has(def.class)) return 4;
  if (INFANTRY_CLASSES.has(def.class) || FOOT_ARCHER_CLASSES.has(def.class) || def.class === 24) return 2;
  return 0;
}

export function canGarrison(game: Game, unit: Entity, host: Entity): boolean {
  const uDef = game.defOf(unit);
  const hDef = game.defOf(host);
  if (host.state === "foundation" || uDef.type !== 70) return false;
  const cap = hDef.garrison_capacity;
  if (cap <= 0 || host.garrisoned.length >= cap) return false;
  if (hDef.type === 70) {
    // transports carry any land unit; rams/siege towers take infantry
    if (hDef.class === 20) {
      return uDef.type === 70 && uDef.class !== 20 && !new Set([2, 21, 22, 53]).has(uDef.class);
    }
    return INFANTRY_CLASSES.has(uDef.class) || (hDef.class === 13 && uDef.class === 4 && hDef.creatable !== undefined);
  }
  const mask = hDef.building_info?.garrison_type ?? 0;
  if (mask > 0) {
    const bit = categoryBit(uDef);
    return bit !== 0 && (mask & bit) !== 0;
  }
  // mask 0 with capacity: production buildings house their own kind; monastery monks
  if (game.familyOf(MONASTERY, game.players[host.owner]).has(host.typeId)) {
    return MONK_CLASSES.has(uDef.class);
  }
  const p = game.players[host.owner];
  for (const [uid] of game.data.units) {
    const local = p.getType(uid);
    if (!local?.creatable) continue;
    if (local.creatable.train_locations.some((l) => game.familyOf(l.unit_id, p).has(host.typeId))) {
      if (local.class === uDef.class) return true;
    }
  }
  return false;
}

export function garrisonInto(game: Game, unit: Entity, host: Entity): void {
  unit.orders = [];
  unit.path = [];
  unit.state = "garrisoned";
  unit.insideOf = host.id;
  game.map.unindexEntity(unit);
  host.garrisoned.push(unit.id);
}

export function ungarrisonAll(game: Game, host: Entity): void {
  const p = host.owner >= 0 ? game.players[host.owner] : null;
  for (const id of host.garrisoned) {
    const u = game.entities.get(id);
    if (!u) continue;
    const spot = game.findFreeSpotNear(host, p ? p.getType(u.typeId) : null);
    if (spot) {
      u.x = spot.x;
      u.y = spot.y;
    } else {
      u.x = host.x;
      u.y = host.y;
    }
    u.state = "idle";
    u.insideOf = 0;
    game.map.indexEntity(u);
  }
  host.garrisoned = [];
}

export function stepGarrison(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    const order = e.orders[0];
    if (!order) continue;
    if (order.kind === "ungarrison") {
      e.orders.shift();
      ungarrisonAll(game, e);
      continue;
    }
    if (order.kind !== "garrison") continue;
    if (e.state === "garrisoned") {
      e.orders.shift();
      continue;
    }
    // monks depositing relics are handled by the monk system
    if (e.hasRelic) continue;
    const host = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
    if (!host || (host.owner !== e.owner && host.owner >= 0)) {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    if (!canGarrison(game, e, host)) {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    const def = game.defOf(e);
    const hDef = game.defOf(host);
    // transports load across the waterline, so the reach is a little longer
    const reach = Math.max(hDef.radius[0], hDef.radius[1]) + Math.max(def.radius[0], def.radius[1]) + (hDef.class === 20 ? 1.4 : 0.4);
    const dist = Math.hypot(host.x - e.x, host.y - e.y);
    if (dist > reach) {
      if (e.path.length === 0) e.path = findPath(game, e, host.x, host.y);
      followPath(game, e, def.speed ?? 0.8, dt);
      continue;
    }
    e.orders.shift();
    garrisonInto(game, e, host);
  }

  // garrison healing
  for (const e of game.entities.values()) {
    if (e.garrisoned.length === 0) continue;
    const def = game.defOf(e);
    const rate = def.building_info?.garrison_heal_rate ?? 0;
    if (rate <= 0) continue;
    for (const id of e.garrisoned) {
      const u = game.entities.get(id);
      if (!u) continue;
      const uDef = game.defOf(u);
      if (u.hp < uDef.hp) u.hp = Math.min(uDef.hp, u.hp + rate * dt);
    }
  }
}

/** Ram speed scales with garrisoned infantry. */
export function garrisonSpeedFactor(host: Entity): number {
  return 1 + 0.05 * host.garrisoned.length;
}
