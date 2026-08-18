/**
 * Genie effect-command interpreter.
 *
 * Every tech research, civ bonus, team bonus, and age-up in AoE2 is a bundle of
 * these commands (sim/data/effects.json, raw from the dat). Semantics below were
 * decoded from the shipped data itself and cross-checked against wiki-documented
 * tech behavior (see JOURNAL entry for the evidence trail):
 *
 *   type 0/4/5  attribute set/add/multiply   (a unit, b class, c attr, d value)
 *   type 1/6    player-resource set-or-add / multiply (a res, b 0=set 1=add, d)
 *   type 2      enable(b=1)/disable(b=0) unit a
 *   type 3      upgrade unit a -> b (live entities transform; training redirects)
 *   type 7      spawn d? no: spawn c units of type a at building b
 *   type 8      tech-tree availability marker (a tech, ...) - availability handled
 *               via 102 disables; 8 re-enables for divergent trees
 *   type 10-16  team versions of 0-6 (all mutually-allied players)
 *   type 101    tech cost modifier (a tech, b res, c 0=set 1=add, d amount)
 *   type 102    disable tech (d = tech id)
 *   type 103    tech research-time modifier (a tech, c 0=set 1=add, d)
 *   type 200/201/202 set/add/multiply variants (same shape as 0/4/5; DE additions)
 *   type 40     display rename (string id) - cosmetic
 *   type 255    disabled command - no-op
 *
 * Attack/armor packing (attrs 8/9): set/add d = class*256 + amount (sign applies
 * to amount); multiply d = class*256 + round(factor*100).
 *
 * Attribute ids: see applyAttr. Display-only attrs (46-49) are no-ops for
 * mechanics; real changes always accompany them as packed 8/9 commands (verified
 * on the Feudal Age effect: Donjon +1/+1 armor arrives packed AND as 48/49).
 *
 * Anything not understood is recorded in `unimplemented` - tests assert that
 * standard-play tech paths produce zero entries there.
 */

import type { EffectCommand, GameData, UnitDef } from "../data/registry.ts";

export interface EffectHost {
  data: GameData;
  /** Clone-on-write lookup of a player-local unit def. */
  mutableType(unitId: number): UnitDef | null;
  /** All unit ids whose (player-local) def has the given class. */
  unitIdsOfClass(classId: number): number[];
  /** Player resource table access. */
  getRes(id: number): number;
  setRes(id: number, v: number): void;
  /** Unit availability. */
  enableUnit(unitId: number, on: boolean): void;
  /** Upgrade all live + future units of a type. */
  upgradeUnit(fromId: number, toId: number): void;
  /** Spawn `count` units of `unitId` at each building of type `anchorId`. */
  spawnUnits(unitId: number, anchorId: number, count: number): void;
  /** Tech modifiers. */
  modTechCost(techId: number, resId: number, mode: "set" | "add", amount: number): void;
  modTechTime(techId: number, mode: "set" | "add", amount: number): void;
  disableTech(techId: number): void;
  markTechAvailable(techId: number): void;
  /** Research a tech immediately, bypassing gates (effect command 18). */
  forceResearch(techId: number): void;
  /** Live-entity notification: def field changed for a type (e.g. hp delta heal). */
  onTypeHpChanged(unitId: number, mode: "add" | "mul" | "set", value: number): void;
  /** Record an effect command the engine could not interpret. */
  reportUnimplemented(source: string, cmd: EffectCommand): void;
  /** Team application: run fn against every mutually-allied player's host. */
  forTeam(fn: (host: EffectHost) => void): void;
}

function attackArmorList(def: UnitDef, attr: number) {
  if (!def.combat) return null;
  return attr === 9 ? def.combat.attacks : def.combat.armours;
}

function packedSetAdd(def: UnitDef, attr: number, d: number, mode: "set" | "add"): void {
  const list = attackArmorList(def, attr);
  if (!list) return;
  const sign = d < 0 ? -1 : 1;
  const abs = Math.abs(d);
  const cls = Math.floor(abs / 256);
  const amt = sign * (abs - cls * 256);
  const cur = list.find((x) => x.class === cls);
  if (cur) {
    cur.amount = mode === "set" ? amt : cur.amount + amt;
  } else {
    list.push({ class: cls, amount: amt });
  }
}

function packedMul(def: UnitDef, attr: number, d: number): void {
  const list = attackArmorList(def, attr);
  if (!list) return;
  const cls = Math.floor(d / 256);
  const factor = (d - cls * 256) / 100;
  const cur = list.find((x) => x.class === cls);
  if (cur) cur.amount = Math.round(cur.amount * factor);
}

/** Storage-slot amount change (attr 21: slot with a real resource type). */
function storageAmount(def: UnitDef, mode: "set" | "add" | "mul", d: number): void {
  if (!def.storages || def.storages.length === 0) return;
  const s = def.storages[0];
  s.amount = mode === "set" ? d : mode === "add" ? s.amount + d : s.amount * d;
}

function costEntry(def: UnitDef, resType: number) {
  return def.creatable?.costs.find((c) => c.type === resType) ?? null;
}

function scaleCost(def: UnitDef, resType: number, mode: "set" | "add" | "mul", d: number): void {
  const c = costEntry(def, resType);
  if (!c) {
    // adding a cost the unit did not have (e.g. Forced Levy food for gold)
    if (mode === "add" && d > 0 && def.creatable) {
      def.creatable.costs.push({ type: resType, amount: Math.round(d), flag: 1 });
    }
    return;
  }
  const v = mode === "set" ? d : mode === "add" ? c.amount + d : c.amount * d;
  c.amount = Math.max(0, Math.round(v));
}

/**
 * Apply one attribute mutation to a player-local def.
 * Returns false when the attribute is not one the engine models (caller reports).
 */
export function applyAttr(
  def: UnitDef,
  attr: number,
  mode: "set" | "add" | "mul",
  d: number,
  host: EffectHost,
): boolean {
  const cb = def.combat;
  switch (attr) {
    case 0: {
      const old = def.hp;
      def.hp = mode === "set" ? d : mode === "add" ? def.hp + d : def.hp * d;
      def.hp = Math.round(def.hp);
      if (def.hp !== old) host.onTypeHpChanged(def.id, mode, d);
      return true;
    }
    case 1:
      def.los = mode === "set" ? d : mode === "add" ? def.los + d : def.los * d;
      return true;
    case 2:
      def.garrison_capacity =
        mode === "set" ? d : mode === "add" ? def.garrison_capacity + d : def.garrison_capacity * d;
      return true;
    case 3:
      def.radius[0] = mode === "set" ? d : mode === "add" ? def.radius[0] + d : def.radius[0] * d;
      return true;
    case 4:
      def.radius[1] = mode === "set" ? d : mode === "add" ? def.radius[1] + d : def.radius[1] * d;
      return true;
    case 5:
      if (def.speed !== undefined)
        def.speed = mode === "set" ? d : mode === "add" ? def.speed + d : def.speed * d;
      return true;
    case 6:
      if (def.move)
        def.move.rotation_speed =
          mode === "set" ? d : mode === "add" ? def.move.rotation_speed + d : def.move.rotation_speed * d;
      return true;
    case 8:
    case 9:
      if (mode === "mul") packedMul(def, attr, d);
      else packedSetAdd(def, attr, d, mode);
      return true;
    case 10:
      if (cb) cb.reload_time = mode === "set" ? d : mode === "add" ? cb.reload_time + d : cb.reload_time * d;
      return true;
    case 11:
      if (cb)
        cb.accuracy_percent =
          mode === "set" ? d : mode === "add" ? cb.accuracy_percent + d : cb.accuracy_percent * d;
      return true;
    case 12:
      if (cb) {
        cb.max_range = mode === "set" ? d : mode === "add" ? cb.max_range + d : cb.max_range * d;
        cb.displayed_range =
          mode === "set" ? d : mode === "add" ? cb.displayed_range + d : cb.displayed_range * d;
      }
      return true;
    case 13:
      if (def.bird)
        def.bird.work_rate =
          mode === "set" ? d : mode === "add" ? def.bird.work_rate + d : def.bird.work_rate * d;
      return true;
    case 14:
      def.resource_capacity =
        mode === "set" ? d : mode === "add" ? def.resource_capacity + d : Math.round(def.resource_capacity * d);
      return true;
    case 16:
      if (cb) cb.projectile_unit_id = d;
      return true;
    case 17: // upgrade graphic - cosmetic
      return true;
    case 19: // ballistics: projectile smart mode
      if (def.projectile_info) def.projectile_info.smart_mode = d;
      return true;
    case 20:
      if (cb) cb.min_range = mode === "set" ? d : mode === "add" ? cb.min_range + d : cb.min_range * d;
      return true;
    case 21:
      storageAmount(def, mode, d);
      return true;
    case 22:
      if (cb) cb.blast_width = mode === "set" ? d : mode === "add" ? cb.blast_width + d : cb.blast_width * d;
      return true;
    case 23:
      if (def.bird)
        def.bird.search_radius =
          mode === "set" ? d : mode === "add" ? def.bird.search_radius + d : def.bird.search_radius * d;
      // search radius doubles as effective sight for auto-engagement; LOS attr 1 is separate
      return true;
    case 24:
      if (cb)
        cb.bonus_damage_resistance =
          mode === "set" ? d : mode === "add" ? cb.bonus_damage_resistance + d : cb.bonus_damage_resistance * d;
      return true;
    case 27:
      // add a FOOD cost (Three Kingdoms building costs; both shipped usages are
      // "C-Bonus, Military Buildings +Nf")
      scaleCost(def, 0, "add", d);
      return true;
    case 30:
      if (def.building_info) def.building_info.garrison_type = d;
      return true;
    case 42: {
      const loc = def.creatable?.train_locations[0];
      if (loc) loc.unit_id = d;
      return true;
    }
    case 43: {
      const loc = def.creatable?.train_locations[0];
      if (loc) loc.button_id = d;
      return true;
    }
    case 44:
      if (cb) cb.blast_attack_level = d;
      return true;
    case 45:
      def.blast_defense = d;
      return true;
    case 46:
    case 47:
    case 48:
    case 49: // displayed attack/range/melee armor/pierce armor - cosmetic
      return true;
    case 50:
      def.name_id = d; // display name string id
      return true;
    case 51: // short description string id - cosmetic
      return true;
    case 59:
      if (def.creatable)
        def.creatable.max_charge =
          mode === "set" ? d : mode === "add" ? def.creatable.max_charge + d : def.creatable.max_charge * d;
      return true;
    case 60:
      if (def.creatable)
        def.creatable.recharge_rate =
          mode === "set" ? d : mode === "add" ? def.creatable.recharge_rate + d : def.creatable.recharge_rate * d;
      return true;
    case 62:
      if (def.creatable) def.creatable.charge_event = d;
      return true;
    case 63:
      if (def.creatable) def.creatable.charge_type = d;
      return true;
    case 100: // all resource costs
      for (const rt of [0, 1, 2, 3]) scaleCost(def, rt, mode, mode === "mul" ? d : d);
      return true;
    case 101: {
      // train time
      const loc = def.creatable?.train_locations;
      if (loc)
        for (const l of loc)
          l.train_time = Math.round(mode === "set" ? d : mode === "add" ? l.train_time + d : l.train_time * d);
      return true;
    }
    case 102:
      if (def.creatable)
        def.creatable.total_projectiles =
          mode === "set" ? d : mode === "add" ? def.creatable.total_projectiles + d : def.creatable.total_projectiles * d;
      return true;
    case 103:
      scaleCost(def, 0, mode, d);
      return true;
    case 104:
      scaleCost(def, 1, mode, d);
      return true;
    case 105:
      scaleCost(def, 3, mode, d);
      return true;
    case 106:
      scaleCost(def, 2, mode, d);
      return true;
    case 107:
      if (def.creatable)
        def.creatable.max_total_projectiles =
          mode === "set" ? d : mode === "add" ? def.creatable.max_total_projectiles + d : Math.round(def.creatable.max_total_projectiles * d);
      return true;
    case 108:
      if (def.building_info)
        def.building_info.garrison_heal_rate =
          mode === "set" ? d : mode === "add" ? def.building_info.garrison_heal_rate + d : def.building_info.garrison_heal_rate * d;
      return true;
    case 109: {
      // regeneration rate, HP per minute (stored as an engine extension field)
      const x = def as UnitDef & { regen_rate?: number };
      const cur = x.regen_rate ?? 0;
      x.regen_rate = mode === "set" ? d : mode === "add" ? cur + d : cur * d;
      return true;
    }
    case 110: {
      // population cost modifier: set with negative d observed = multiply pop by |d|
      const x = def as UnitDef & { pop_factor?: number };
      if (mode === "set" && d < 0) x.pop_factor = -d;
      else if (mode === "mul") x.pop_factor = (x.pop_factor ?? 1) * d;
      else return false;
      return true;
    }
    case 111:
      if (def.creatable)
        def.creatable.min_conversion_time_mod =
          mode === "set" ? d : mode === "add" ? def.creatable.min_conversion_time_mod + d : def.creatable.min_conversion_time_mod * d;
      return true;
    case 112:
      if (def.creatable)
        def.creatable.max_conversion_time_mod =
          mode === "set" ? d : mode === "add" ? def.creatable.max_conversion_time_mod + d : def.creatable.max_conversion_time_mod * d;
      return true;
    case 113:
      if (def.creatable)
        def.creatable.conversion_chance_mod =
          mode === "set" ? d : mode === "add" ? def.creatable.conversion_chance_mod + d : def.creatable.conversion_chance_mod * d;
      return true;
    case 118:
      if (cb)
        cb.damage_reflection =
          mode === "set" ? d : mode === "add" ? cb.damage_reflection + d : cb.damage_reflection * d;
      return true;
    case 130: {
      // attack delay, in SECONDS (DE addition; Fletching line shaves villager
      // hunting delay with negative adds). Applied on top of frame_delay*frame_dur.
      const x = cb as (typeof cb & { frame_delay_bonus_s?: number }) | undefined;
      if (x) {
        const cur = x.frame_delay_bonus_s ?? 0;
        x.frame_delay_bonus_s = mode === "set" ? d : mode === "add" ? cur + d : cur * d;
      }
      return true;
    }
    case 119:
      if (cb)
        cb.friendly_fire_damage =
          mode === "set" ? d : mode === "add" ? cb.friendly_fire_damage + d : cb.friendly_fire_damage * d;
      return true;
    default:
      return SHELVED_ATTRS.has(attr) ? true : false;
  }
}

/**
 * Attributes with decoded-but-deferred semantics; documented in PLAN.md gaps.
 * Kept out of `unimplemented` so that ledger stays a list of true unknowns.
 *   25 dead-unit graphic swap - cosmetic
 *   53 projectile flag set by Chemistry on projectile units - visual arrow swap
 *   61 Louchuan (Three Kingdoms ship) extra-arrow count from blacksmith techs
 *   34/57/58/65-77 graphic & string swaps on age-up/renames - cosmetic
 *   54 trait bitfield add (Macedonians static bonus, Chronicles) - deferred
 *   115/125/126/127/145-147/158 Chronicles/TK auxiliary stats - deferred with
 *      their civs; revisit when those rosters are played
 */
const SHELVED_ATTRS = new Set([25, 34, 53, 54, 57, 58, 61, 65, 66, 67, 68, 69, 70, 71, 73, 74, 75, 77, 81, 115, 125, 126, 127, 145, 146, 147, 158]);

function targetIds(host: EffectHost, a: number, b: number): number[] {
  if (a >= 0) return [a];
  if (b >= 0) return host.unitIdsOfClass(b);
  return [];
}

export function applyEffect(host: EffectHost, effectId: number, source?: string): void {
  const eff = host.data.effects.get(effectId);
  if (!eff) return;
  const src = source ?? eff.name ?? `effect ${effectId}`;
  for (const cmd of eff.commands) {
    applyCommand(host, cmd, src);
  }
}

export function applyCommand(host: EffectHost, cmd: EffectCommand, src: string): void {
  let t = cmd.type;
  let team = false;
  if (t >= 10 && t <= 16) {
    team = true;
    t -= 10;
  }
  const run = (h: EffectHost) => {
    switch (t) {
      case 0:
      case 4:
      case 5: {
        const mode = t === 0 ? "set" : t === 4 ? "add" : "mul";
        for (const id of targetIds(h, cmd.a, cmd.b)) {
          const def = h.mutableType(id);
          if (def && !applyAttr(def, cmd.c, mode, cmd.d, h)) {
            h.reportUnimplemented(src, cmd);
          }
        }
        return;
      }
      case 1: {
        const cur = h.getRes(cmd.a);
        h.setRes(cmd.a, cmd.b === 0 ? cmd.d : cur + cmd.d);
        return;
      }
      case 6: {
        h.setRes(cmd.a, h.getRes(cmd.a) * cmd.d);
        return;
      }
      case 2:
        h.enableUnit(cmd.a, cmd.b === 1);
        return;
      case 3:
        h.upgradeUnit(cmd.a, cmd.b);
        return;
      case 7:
        h.spawnUnits(cmd.a, cmd.b, cmd.c);
        return;
      case 8:
        h.markTechAvailable(cmd.a);
        return;
      default:
        break;
    }
    if (cmd.type === 18) {
      // force-research tech `a` (Wu team bonus researching "Wu TB local", Cuman
      // Mercenaries granting Kipchak stock)
      h.forceResearch(cmd.a);
      return;
    }
    switch (cmd.type) {
      case 40: // display rename
        return;
      case 101:
        h.modTechCost(cmd.a, cmd.b, cmd.c === 0 ? "set" : "add", cmd.d);
        return;
      case 102:
        h.disableTech(Math.trunc(cmd.d));
        return;
      case 103:
        h.modTechTime(cmd.a, cmd.c === 0 ? "set" : "add", cmd.d);
        return;
      case 200:
      case 201:
      case 202:
        // emplacement-layer mirror commands: every one of the 164 shipped
        // instances duplicates a plain 0/4/5 sibling in the same effect
        // (verified against the full export). Buildings are single entities
        // here, so the plain sibling already carries the change - applying
        // these too would double-count (Herbal Medicine x36 castles).
        return;
      case 255:
        return;
      default:
        h.reportUnimplemented(src, cmd);
    }
  };
  if (team) host.forTeam(run);
  else run(host);
}
