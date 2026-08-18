/**
 * Projectile flight and impact. A projectile that "hit" its accuracy roll tracks
 * its target point; on arrival it damages the intended target if still nearby,
 * otherwise whatever stands at the impact point. Blast (mangonel etc.) damages
 * everything within blast_width of impact, friendly fire included.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import { computeDamage, notifyDamaged } from "./damage.ts";

export function stepProjectiles(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    if (e.state !== "projectile") continue;
    e.flightLeft -= dt;
    game.map.moveEntity(e, e.x + e.vx * dt, e.y + e.vy * dt);
    if (e.flightLeft > 0) continue;

    const info = e.projectileDamage;
    game.map.unindexEntity(e);
    game.entities.delete(e.id);
    if (!info) continue;

    const blast = e.timer; // blast_width stashed at launch; level in charge
    const level = e.charge;
    if (blast > 0 && level < 3) {
      for (const id of game.map.idsNear(e.x, e.y, blast + 1)) {
        const t = game.entities.get(id);
        if (!t || t.state === "projectile" || t.state === "corpse") continue;
        const tDef = game.defOf(t);
        if (tDef.type !== 70 && tDef.type !== 80) continue;
        // a unit is caught by the blast when its blast DEFENSE level is at
        // least the attack's blast level (level 2 spares trees etc.)
        if (tDef.blast_defense < level) continue;
        const d = Math.hypot(t.x - e.x, t.y - e.y);
        if (d > blast) continue;
        // projectile blast: blast_damage mode scales it (mangonel 1.0, Dromon
        // 0.8); the mangonel-line taper is DE engine behavior - full at the
        // centre, half at the rim (exact curve flagged for calibration in PLAN)
        const taper = 1 - 0.5 * (d / blast);
        const dmg = Math.max(1, Math.floor(computeDamage(info.attacks, tDef) * (info.blastMode ?? 1) * taper));
        t.hp -= dmg;
        if (t.hp <= 0) game.kill(t);
        else {
          const src = info.sourceOwner >= 0 ? findShooterProxy(game, info.sourceOwner, e) : null;
          if (src) notifyDamaged(game, t, src);
        }
      }
      continue;
    }

    // direct hit: intended target if close to impact, else anything on the tile
    let victim: Entity | null = null;
    const intended = game.entities.get(info.targetId);
    if (intended && Math.hypot(intended.x - e.x, intended.y - e.y) <= Math.max(0.6, game.defOf(intended).radius[0] + 0.3)) {
      victim = intended;
    } else {
      for (const id of game.map.idsNear(e.x, e.y, 0.5)) {
        const t = game.entities.get(id);
        if (!t || t.state === "projectile" || t.state === "corpse" || t.owner === info.sourceOwner) continue;
        const tDef = game.defOf(t);
        if (tDef.type !== 70 && tDef.type !== 80) continue;
        victim = t;
        break;
      }
    }
    if (victim) {
      const dmg = computeDamage(info.attacks, game.defOf(victim));
      victim.hp -= dmg;
      if (victim.hp <= 0) game.kill(victim);
      else {
        const src = info.sourceOwner >= 0 ? findShooterProxy(game, info.sourceOwner, e) : null;
        if (src) notifyDamaged(game, victim, src);
      }
    }
  }
}

/** Nearest unit of the shooting player to the impact - the entity gaia should
 *  retaliate against (the original shooter may have moved or died). */
function findShooterProxy(game: Game, owner: number, at: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const id of game.map.idsNear(at.x, at.y, 12)) {
    const t = game.entities.get(id);
    if (!t || t.owner !== owner || t.state === "projectile" || t.state === "garrisoned") continue;
    if (game.defOf(t).type !== 70) continue;
    const d = Math.hypot(t.x - at.x, t.y - at.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}
