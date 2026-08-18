/**
 * The Genie damage formula: for every attack class the attacker has, look up the
 * defender's armor of that class; classes the defender lacks contribute nothing
 * unless the attack class is base melee (4) or pierce (3), which every combatant
 * resists via its listed armours. damage = sum(max(0, atk - armor)) per matching
 * class, minimum 1 per hit. Elevation: x5/4 downhill, x3/4 uphill (DE values).
 * Bonus-damage resistance scales the NON-base class contributions.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import type { AttackArmor, UnitDef } from "../data/registry.ts";

export function computeDamage(
  attacks: AttackArmor[],
  defender: UnitDef,
  opts?: { elevationFactor?: number },
): number {
  const armours = defender.combat?.armours ?? [];
  const resist = defender.combat?.bonus_damage_resistance ?? 0;
  let total = 0;
  for (const atk of attacks) {
    if (atk.amount === 0) continue;
    const arm = armours.find((a) => a.class === atk.class);
    if (!arm) continue; // defender has no vulnerability in this class
    let dmg = Math.max(0, atk.amount - arm.amount);
    if (atk.class !== 4 && atk.class !== 3 && resist > 0) {
      dmg = Math.max(0, dmg * (1 - resist));
    }
    total += dmg;
  }
  total = Math.floor(total * (opts?.elevationFactor ?? 1));
  return Math.max(1, total);
}

export function elevationFactor(game: Game, attacker: Entity, defender: Entity): number {
  const ea = game.map.elevationAt(attacker.x, attacker.y);
  const ed = game.map.elevationAt(defender.x, defender.y);
  if (ea > ed) return 1.25;
  if (ea < ed) return 0.75;
  return 1;
}

/**
 * Melee trample/splash around the struck target. blast_damage encodes the mode
 * (verified against the shipped data + wiki Area-of-Effect table):
 *   negative  -> flat, armor-ignoring damage of that size (militia -5 stays
 *                dormant until Druzhina adds blast width; then 5 trample)
 *   0 < m <=1 -> that fraction of the normally-computed damage (War Elephant
 *                0.5, scout line 0.33, siege ram 1.0 vs its level targets)
 * Melee splash strikes enemies only, never the primary target twice.
 */
function meleeSplash(game: Game, attacker: Entity, attackerDef: UnitDef, target: Entity): void {
  const cb = attackerDef.combat;
  if (!cb || cb.blast_width <= 0) return;
  const level = cb.blast_attack_level & 3;
  if (level >= 3) return;
  const mode = cb.blast_damage;
  for (const id of game.map.idsNear(target.x, target.y, cb.blast_width + 1)) {
    const v = game.entities.get(id);
    if (!v || v.id === target.id || v.id === attacker.id) continue;
    if (v.state === "projectile" || v.state === "corpse" || v.state === "garrisoned") continue;
    if (game.areAllied(attacker.owner, v.owner)) continue;
    const vDef = game.defOf(v);
    if (vDef.type !== 70 && vDef.type !== 80) continue;
    if (vDef.blast_defense < level) continue;
    if (Math.hypot(v.x - target.x, v.y - target.y) > cb.blast_width) continue;
    const dmg = mode < 0 ? -mode : Math.max(1, Math.floor(computeDamage(cb.attacks, vDef) * mode));
    v.hp -= dmg;
    if (v.hp <= 0) game.kill(v);
    else notifyDamaged(game, v, attacker);
  }
}

/** Apply a direct (non-projectile) hit. Returns true if the target died. */
export function meleeHit(game: Game, attacker: Entity, attackerDef: UnitDef, target: Entity): boolean {
  const tDef = game.defOf(target);
  let dmg = computeDamage(attackerDef.combat?.attacks ?? [], tDef, {
    elevationFactor: elevationFactor(game, attacker, target),
  });
  // charge attacks (Coustillier etc.): a full charge adds max_charge damage
  const cr = attackerDef.creatable;
  if (cr && cr.max_charge > 0 && cr.charge_type === 1 && attacker.charge >= cr.max_charge) {
    dmg += cr.max_charge;
    attacker.charge = 0;
  }
  target.hp -= dmg;
  meleeSplash(game, attacker, attackerDef, target);
  if (target.hp <= 0) {
    game.kill(target);
    return true;
  }
  notifyDamaged(game, target, attacker);
  return false;
}

// set by combat.ts to avoid a circular import
export let notifyDamaged: (game: Game, target: Entity, attacker: Entity) => void = () => {};
export function setDamageNotifier(fn: typeof notifyDamaged): void {
  notifyDamaged = fn;
}
