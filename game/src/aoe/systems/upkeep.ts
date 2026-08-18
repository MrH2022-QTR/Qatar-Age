/**
 * Per-tick housekeeping: corpse decay and expiry, regeneration, garrison
 * healing, herdable capture (sheep walk to whoever finds them), relic income.
 */

import type { Game } from "../core/game.ts";
import { RES } from "../data/registry.ts";

const HERDABLE_CLASS = 58;
const MONK_CLASSES = new Set([18, 43]);

/** Begin a pack/unpack transform: 50 points at the unit's work rate
 *  (treb: 50/4.5 = 11.1s; Kataparuto's x4 gives 2.78s - all from data). */
export function beginTransform(game: Game, e: { transformLeft: number; transformTo: number; state: string }, def: { building_info?: { transform_unit: number } | null; bird?: { work_rate: number } }): boolean {
  const to = def.building_info?.transform_unit ?? -1;
  if (to < 0) return false;
  e.transformTo = to;
  e.transformLeft = 50 / (def.bird?.work_rate || 1);
  e.state = "transforming";
  return true;
}

export function stepUpkeep(game: Game, dt: number): void {
  // pack/unpack transforms
  for (const e of game.entities.values()) {
    if (e.state !== "transforming") continue;
    e.transformLeft -= dt;
    if (e.transformLeft <= 0) {
      const oldDef = game.defOf(e);
      game.map.vacate(e, oldDef.radius[0], oldDef.radius[1]);
      e.typeId = e.transformTo;
      e.transformTo = 0;
      e.state = "idle";
      const newDef = game.defOf(e);
      if ((newDef.speed ?? 0) === 0) game.map.occupy(e, newDef.radius[0], newDef.radius[1]);
    }
  }
  // relic gold: resource-191 gold per minute per garrisoned relic
  for (const p of game.players) {
    const relics = game.relicsGarrisoned[p.id] ?? 0;
    if (relics > 0) {
      p.resources[RES.GOLD] += ((p.resources[RES.RELIC_GOLD_PER_MIN] || 30) / 60) * relics * dt;
    }
  }
  const toRemove: number[] = [];
  for (const e of game.entities.values()) {
    // corpse decay: food rots from the moment of death (rate from the live def
    // that produced it; stored on spawn) - and the corpse itself expires
    if (e.state === "corpse") {
      // carcasses rot at the live unit's resource_decay (0.25/s) but persist
      // while food remains; the storage-12 timer only cleans up empty remains
      const liveDecay = 0.25;
      if (e.resAmount > 0) {
        e.resAmount = Math.max(0, e.resAmount - liveDecay * dt);
        if (e.resAmount <= 0) toRemove.push(e.id);
      } else {
        e.timer -= dt;
        if (e.timer <= 0) toRemove.push(e.id);
      }
      continue;
    }

    // regeneration, hp per minute: attr-109 techs (Maghrabi Camels etc.) plus
    // the native rate DE stores in creatable.rear_attack_modifier (Berserk 40,
    // Liu Bei 15 - every nonzero holder is a known regenerator; negatives decay)
    if (e.owner >= 0) {
      const def = game.defOf(e) as {
        hp: number;
        regen_rate?: number;
        class: number;
        combat?: { reload_time: number };
        creatable?: { rear_attack_modifier: number; max_charge: number; recharge_rate: number };
        type: number;
      };
      const regen = (def.regen_rate ?? 0) + (def.type === 70 ? def.creatable?.rear_attack_modifier ?? 0 : 0);
      if (regen > 0 && e.hp < def.hp && e.state !== "foundation") {
        e.hp = Math.min(def.hp, e.hp + (regen / 60) * dt);
      } else if (regen < 0 && e.state !== "foundation") {
        e.hp += (regen / 60) * dt;
        if (e.hp <= 0) {
          game.kill(e);
          continue;
        }
      }
      // monk faith recharge: the monk's reload_time doubles as faith/second
      // (1.6/s base = 62.5s to full; Illumination multiplies it via attr 10)
      if (MONK_CLASSES.has(def.class) && e.faith < 100) {
        e.faith = Math.min(100, e.faith + (def.combat?.reload_time ?? 1.6) * dt);
      }
      // charge attacks build back up between releases
      const cr = (def as { creatable?: { max_charge: number; recharge_rate: number } }).creatable;
      if (cr && cr.max_charge > 0 && e.charge < cr.max_charge && e.state !== "projectile") {
        e.charge = Math.min(cr.max_charge, e.charge + cr.recharge_rate * dt);
      }
    }

    // herdable capture: gaia sheep near a player unit change allegiance
    if (e.owner === -1) {
      const def = game.data.units.get(e.typeId);
      if (def && def.class === HERDABLE_CLASS && e.hp > 0) {
        for (const id of game.map.idsNear(e.x, e.y, 3)) {
          const u = game.entities.get(id);
          if (!u || u.owner < 0 || u.state === "projectile") continue;
          const uDef = game.defOf(u);
          if (uDef.type !== 70) continue;
          e.owner = u.owner;
          break;
        }
      }
    }
  }
  for (const id of toRemove) {
    const e = game.entities.get(id);
    if (e) {
      game.map.unindexEntity(e);
      game.entities.delete(id);
    }
  }
}
