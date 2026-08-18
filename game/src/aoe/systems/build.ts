/**
 * Construction: a foundation of total T points completes at rate (2 + sum of the
 * builders' work rates) / 3 points per second - the classic 3T/(n+2) law for n
 * standard builders. Builder work rate comes from the builder job unit (VMBLD),
 * so construction-speed bonuses arrive via ordinary attr-13 effects.
 */

import type { Game } from "../core/game.ts";
import { UNIT } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";
import { isVillager } from "./gather.ts";

export function stepBuild(game: Game, dt: number): void {
  // collect builders per foundation
  const builders = new Map<number, number>(); // foundationId -> sum of work rates
  for (const e of game.entities.values()) {
    const order = e.orders[0];
    if (!order || (order.kind !== "build" && order.kind !== "repair")) continue;
    // villagers build everything; other units (fishing ships) build what their
    // task list says they can (action 101, e.g. fish traps at rate wv1)
    const selfBuildTask = !isVillager(e.typeId)
      ? game.players[e.owner]?.getType(e.typeId)?.bird?.tasks.find((t) => t.action_type === 101)
      : undefined;
    if (!isVillager(e.typeId) && !selfBuildTask) continue;
    const target = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
    if (!target) {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    const p = game.players[e.owner];
    const speed = p.getType(e.typeId)?.speed ?? 0.8;
    const tDef = game.defOf(target);
    const reach = Math.max(tDef.radius[0], tDef.radius[1]) + 0.6;
    const dist = Math.hypot(target.x - e.x, target.y - e.y);
    if (dist > reach) {
      if (e.path.length === 0) e.path = findPath(game, e, target.x, target.y);
      followPath(game, e, speed, dt);
      continue;
    }
    e.path = [];
    if (order.kind === "build" && target.state === "foundation") {
      e.state = "building";
      let wr: number;
      if (isVillager(e.typeId)) {
        e.jobTypeId = UNIT.VIL_BUILDER;
        wr = p.getType(UNIT.VIL_BUILDER)?.bird?.work_rate ?? 1;
      } else {
        wr = selfBuildTask?.work_value_1 || 1; // fishing ship: 3.57 on traps
      }
      builders.set(target.id, (builders.get(target.id) ?? 0) + wr);
    } else if (order.kind === "repair") {
      // repair: villager restores hp at repair work rate; costs trickle later (TODO cost)
      e.state = "repairing";
      const tD = game.defOf(target);
      if (target.hp < tD.hp) {
        const wr = p.getType(UNIT.VIL_REPAIRER)?.bird?.work_rate ?? 12.5;
        target.hp = Math.min(tD.hp, target.hp + wr * dt);
      } else {
        e.orders.shift();
        e.state = "idle";
      }
    } else {
      // foundation finished
      e.orders.shift();
      e.state = "idle";
    }
  }

  for (const [fid, rateSum] of builders) {
    const f = game.entities.get(fid);
    if (!f || f.state !== "foundation") continue;
    const def = game.defOf(f);
    const points = ((2 + rateSum) / 3) * dt;
    f.buildLeft -= points;
    // foundation hp scales with progress
    const frac = 1 - f.buildLeft / f.buildTotal;
    f.hp = Math.max(1, Math.floor(def.hp * Math.min(1, frac)));
    if (f.buildLeft <= 0) {
      f.state = "idle";
      f.hp = def.hp;
      game.onBuildingComplete(f, def);
    }
  }
}
