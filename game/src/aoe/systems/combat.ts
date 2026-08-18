/**
 * Combat: reload + frame-delay timing, melee hits, projectile launches, building
 * fire with garrison arrows, simple auto-engagement, gaia behavior (boar
 * retaliation, deer flight). Damage math lives in damage.ts; projectile flight
 * in projectiles.ts.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import type { UnitDef } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";
import { computeDamage, elevationFactor, meleeHit, setDamageNotifier } from "./damage.ts";
import { beginTransform } from "./upkeep.ts";

setDamageNotifier((game, target, attacker) => onEntityDamaged(game, target, attacker));

function attackDelaySeconds(game: Game, def: UnitDef): number {
  const cb = def.combat;
  if (!cb) return 0;
  const g = game.data.graphics.get(cb.attack_graphic);
  const fd = g?.frame_duration ?? 0;
  const bonus = (cb as typeof cb & { frame_delay_bonus_s?: number }).frame_delay_bonus_s ?? 0;
  return Math.max(0, cb.frame_delay * fd + bonus);
}

function attackRange(game: Game, attacker: Entity, aDef: UnitDef, target: Entity): number {
  const tDef = game.defOf(target);
  const base = aDef.combat?.max_range ?? 0;
  return base + Math.max(tDef.radius[0], tDef.radius[1]) + Math.max(aDef.radius[0], aDef.radius[1]);
}

/** Tower arrow: the projectile DE buildings fire; TC heads carry attack values
 *  but delegate the projectile to emplacement sub-units (id -1 on the head),
 *  so single-entity buildings borrow this one. Damage always comes from the
 *  shooter's own attack table; the projectile unit only supplies flight. */
const DEFAULT_BUILDING_ARROW = 504;

export function launchProjectiles(game: Game, attacker: Entity, aDef: UnitDef, target: Entity): void {
  const cb = aDef.combat!;
  const p = attacker.owner >= 0 ? game.players[attacker.owner] : null;
  const projId = cb.projectile_unit_id >= 0 ? cb.projectile_unit_id
    : aDef.type === 80 ? DEFAULT_BUILDING_ARROW : -1;
  const projDef = game.data.units.get(projId);
  if (!projDef) return;
  let count = Math.max(1, Math.round(aDef.creatable?.total_projectiles ?? 1));
  // garrison arrows: buildings add projectiles per qualifying garrisoned unit
  if (aDef.type === 80 && attacker.garrisoned.length > 0) {
    let extra = 0;
    for (const gid of attacker.garrisoned) {
      const g = game.entities.get(gid);
      if (!g) continue;
      const gDef = game.defOf(g);
      if (gDef.combat && (gDef.combat.projectile_unit_id >= 0 || gDef.class === 4)) extra++;
    }
    const maxTotal = aDef.creatable?.max_total_projectiles || count + extra;
    count = Math.min(count + extra, maxTotal);
  }
  const speed = projDef.speed ?? 7;
  const secondaryId = aDef.creatable?.secondary_projectile_unit ?? -1;
  for (let i = 0; i < count; i++) {
    // the PRIMARY projectile delivers the shooter's attack table; secondaries
    // (extra Chu Ko Nu arrows, garrison arrows, mangonel cluster rocks)
    // deliver the projectile unit's OWN attacks - empty list = the min-1 hit
    const thisProjId = i === 0 ? projId : secondaryId >= 0 ? secondaryId : projId;
    const thisProjDef = game.data.units.get(thisProjId) ?? projDef;
    const proj = game.spawn(-1, thisProjId, attacker.x, attacker.y);
    proj.state = "projectile";
    const acc = cb.accuracy_percent;
    const hit = game.rng.chance(acc / 100);
    let tx = target.x;
    let ty = target.y;
    // lead the target when the projectile aims smart (ballistics)
    const smart = (projDef.projectile_info?.smart_mode ?? 0) > 0;
    if (smart && target.id !== 0 && target.path.length > 0 && (game.defOf(target).speed ?? 0) > 0) {
      const tSpeed = game.defOf(target).speed!;
      const wp = target.path[0];
      const dh = Math.hypot(wp.x - target.x, wp.y - target.y);
      if (dh > 0.01) {
        const t = Math.hypot(tx - attacker.x, ty - attacker.y) / speed;
        tx += ((wp.x - target.x) / dh) * tSpeed * t;
        ty += ((wp.y - target.y) / dh) * tSpeed * t;
      }
    }
    if (!hit) {
      const scatter = 0.5 + (cb.accuracy_dispersion || 0);
      tx += game.rng.range(-scatter, scatter);
      ty += game.rng.range(-scatter, scatter);
    }
    if (i > 0) {
      // secondary arrows fan around the target
      tx += game.rng.range(-0.6, 0.6);
      ty += game.rng.range(-0.6, 0.6);
    }
    const d = Math.hypot(tx - attacker.x, ty - attacker.y);
    proj.vx = ((tx - attacker.x) / (d || 1)) * speed;
    proj.vy = ((ty - attacker.y) / (d || 1)) * speed;
    proj.flightLeft = (d || 1) / speed;
    proj.projectileDamage = {
      attacks: i === 0 ? structuredClone(cb.attacks) : structuredClone(thisProjDef.combat?.attacks ?? []),
      sourceOwner: attacker.owner,
      smart: hit,
      targetId: target.id,
      blastMode: cb.blast_damage > 0 ? cb.blast_damage : 1,
    };
    // blast rides on the PRIMARY only; stash radius in timer, level in charge
    proj.timer = i === 0 ? cb.blast_width : 0;
    proj.charge = cb.blast_attack_level;
  }
}

/** Bombard a ground point (mangonels, onagers, trebuchets): the volley flies
 *  at the tile and the blast sorts out whoever stands there. */
export function launchProjectilesAtPoint(game: Game, attacker: Entity, aDef: UnitDef, x: number, y: number): void {
  const ghost = {
    id: 0,
    x,
    y,
    path: [] as { x: number; y: number }[],
  };
  launchProjectiles(game, attacker, aDef, ghost as unknown as Entity);
}

function tryAttack(game: Game, e: Entity, target: Entity, dt: number): void {
  const p = e.owner >= 0 ? game.players[e.owner] : null;
  const def = e.owner >= 0 ? p!.getType(e.typeId)! : game.data.units.get(e.typeId)!;
  if (!def.combat) {
    e.orders.shift();
    e.state = "idle";
    return;
  }
  const speed = def.speed ?? 0;
  const range = attackRange(game, e, def, target);
  const dist = Math.hypot(target.x - e.x, target.y - e.y);
  const minRange = def.combat.min_range ?? 0;

  if (dist > range) {
    if (speed <= 0) return; // static and out of range
    if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
    followPath(game, e, speed, dt);
    return;
  }
  if (minRange > 0 && dist < minRange && speed > 0) {
    // step back out of minimum range
    const away = 1.5;
    const ax = e.x + ((e.x - target.x) / (dist || 1)) * away;
    const ay = e.y + ((e.y - target.y) / (dist || 1)) * away;
    if (e.path.length === 0) e.path = findPath(game, e, ax, ay);
    followPath(game, e, speed, dt);
    return;
  }
  e.path = [];
  e.state = "attacking";

  e.reloadLeft -= dt;
  if (e.frameDelayLeft > 0) {
    e.frameDelayLeft -= dt;
    if (e.frameDelayLeft <= 0) {
      // strike lands / projectile leaves now
      if (def.combat.projectile_unit_id >= 0) {
        launchProjectiles(game, e, def, target);
      } else {
        meleeHit(game, e, def, target);
      }
    }
    return;
  }
  if (e.reloadLeft <= 0) {
    e.reloadLeft = def.combat.reload_time;
    const delay = attackDelaySeconds(game, def);
    if (delay > 0) {
      e.frameDelayLeft = delay;
    } else if (def.combat.projectile_unit_id >= 0 || def.type === 80) {
      launchProjectiles(game, e, def, target);
    } else {
      meleeHit(game, e, def, target);
    }
  }
}

export function stepCombat(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    if (e.state === "projectile" || e.state === "corpse" || e.state === "foundation" || e.state === "transforming" || e.state === "garrisoned") continue;
    const order = e.orders[0];

    // a packed trebuchet (class 51) unpacks before it can fight or bombard
    if (order && (order.kind === "attack" || order.kind === "attack_move" || order.kind === "attack_ground")) {
      const def = game.defOf(e);
      if (def.class === 51 && (def.building_info?.transform_unit ?? -1) >= 0) {
        beginTransform(game, e, def);
        continue;
      }
    }

    if (order && order.kind === "attack_ground") {
      const def = game.defOf(e);
      if (!def.combat || def.combat.attacks.length === 0 || order.x === undefined) {
        e.orders.shift();
        continue;
      }
      const dist = Math.hypot(order.x - e.x, order.y! - e.y);
      const range = def.combat.max_range;
      if (dist > range) {
        if ((def.speed ?? 0) > 0) {
          if (e.path.length === 0) e.path = findPath(game, e, order.x, order.y!);
          followPath(game, e, def.speed!, dt);
        } else {
          e.orders.shift();
        }
        continue;
      }
      e.path = [];
      e.reloadLeft -= dt;
      if (e.reloadLeft <= 0) {
        e.reloadLeft = def.combat.reload_time;
        launchProjectilesAtPoint(game, e, def, order.x, order.y!);
      }
      continue;
    }

    if (order && (order.kind === "attack" || order.kind === "attack_move")) {
      let target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
      if (order.kind === "attack_move") {
        const near = acquireTarget(game, e);
        if (near) target = near;
        if (!target) {
          // keep moving to the ordered point
          const def = game.defOf(e);
          if (order.x !== undefined) {
            if (e.path.length === 0) e.path = findPath(game, e, order.x, order.y!);
            if (followPath(game, e, def.speed ?? 0, dt)) {
              e.orders.shift();
              e.state = "idle";
            }
          }
          continue;
        }
      }
      if (!target || target.state === "dead") {
        e.orders.shift();
        e.state = "idle";
        continue;
      }
      // stand ground never chases: drop the order once the target leaves range
      if (e.stance === 2) {
        const def = game.defOf(e);
        if (def.type !== 80 && def.combat && Math.hypot(target.x - e.x, target.y - e.y) > attackRange(game, e, def, target)) {
          e.orders.shift();
          e.state = "idle";
          continue;
        }
      }
      tryAttack(game, e, target, dt);
      continue;
    }

    // auto-engagement for idle military and attacking buildings, per stance
    if (!order && e.state === "idle") {
      const def = game.defOf(e);
      if (!def.combat || def.combat.attacks.length === 0) continue;
      if (e.owner >= 0 && isEconomicUnit(def)) continue; // villagers do not auto-charge
      if (e.owner === -1 && !isPredator(def)) continue; // gaia: only predators auto-attack
      if (e.stance === 3) continue; // no attack
      const target = acquireTarget(game, e);
      if (target) {
        if (e.stance === 2 && def.type !== 80) {
          // stand ground: swing only if already in range, never move
          const range = attackRange(game, e, def, target);
          if (Math.hypot(target.x - e.x, target.y - e.y) > range) continue;
        }
        if (e.stance === 1 && e.postX < 0) {
          e.postX = e.x;
          e.postY = e.y;
        }
        e.orders = [{ kind: "attack", targetId: target.id }];
      }
    }

    // defensive leash: break off a chase that strays too far from the post
    if (e.stance === 1 && e.postX >= 0 && e.orders[0]?.kind === "attack") {
      if (Math.hypot(e.x - e.postX, e.y - e.postY) > 8) {
        e.orders = [{ kind: "move", x: e.postX, y: e.postY }];
        e.postX = -1;
        e.postY = -1;
      }
    }
  }
}

function isEconomicUnit(def: UnitDef): boolean {
  return def.class === 4; // civilian
}

/** Wolves/lions/jaguars (class 10, wide search) hunt on sight; boars (class 10,
 *  search 4) only retaliate - see onEntityDamaged. */
function isPredator(def: UnitDef): boolean {
  return def.class === 10 && (def.bird?.search_radius ?? 0) >= 6;
}

/** Gaia reactions to damage: predators retaliate and chase; prey flees. */
export function onEntityDamaged(game: Game, target: Entity, attacker: Entity): void {
  if (target.owner !== -1 || target.state === "corpse") return;
  const def = game.defOf(target);
  if (def.class === 10 && def.combat && def.combat.attacks.length > 0) {
    const cur = target.orders[0];
    if (!cur || cur.kind !== "attack") {
      target.orders = [{ kind: "attack", targetId: attacker.id }];
      target.path = [];
    }
  } else if (def.class === 9 && (def.speed ?? 0) > 0) {
    // deer: bolt straight away from the attacker
    const d = Math.hypot(target.x - attacker.x, target.y - attacker.y) || 1;
    const fx = target.x + ((target.x - attacker.x) / d) * 10;
    const fy = target.y + ((target.y - attacker.y) / d) * 10;
    target.orders = [{
      kind: "move",
      x: Math.max(1, Math.min(game.map.w - 1, fx)),
      y: Math.max(1, Math.min(game.map.h - 1, fy)),
    }];
    target.path = [];
    target.state = "idle";
  }
}

function acquireTarget(game: Game, e: Entity): Entity | null {
  const def = game.defOf(e);
  // defensive buildings engage anything inside their firing range; mobile units
  // use their search radius (falling back to LOS)
  const sr =
    def.type === 80
      ? (def.combat?.max_range ?? 0) + Math.max(def.radius[0], def.radius[1]) + 0.5
      : (def.bird?.search_radius ?? def.los);
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const id of game.map.idsNear(e.x, e.y, sr)) {
    const t = game.entities.get(id);
    if (!t || t.id === e.id || t.state === "projectile" || t.state === "corpse") continue;
    if (t.owner === e.owner) continue;
    if (t.owner === -1) continue; // do not auto-attack gaia
    if (e.owner === -1 && t.owner === -1) continue;
    const tDef = game.defOf(t);
    if (tDef.type !== 70 && tDef.type !== 80) continue;
    const d = Math.hypot(t.x - e.x, t.y - e.y);
    if (d <= sr && d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}
