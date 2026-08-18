/**
 * Per-player state: the Genie model.
 *
 * Each player owns a mutable overlay of the unit-type table (clone-on-write over
 * the shared base + civ diff), a resource table initialised from the civ's
 * resource vector, and tech state. Researching a tech applies its effect bundle
 * to THIS player's overlay - that is how every upgrade, civ bonus, team bonus and
 * age-up works, exactly as in the original engine.
 *
 * Auto-techs ("shadow" techs): any tech with no research location auto-researches
 * the moment its prerequisites are met (and its civ gate matches). Building
 * completions grant their building_info.tech_id, which feeds the prerequisite
 * graph (that is how "Barracks unlocks Stable" and "two Feudal buildings unlock
 * Castle Age" are encoded in the data).
 */

import type { EffectCommand, GameData, TechDef, UnitDef } from "../data/registry.ts";
import { applyEffect, type EffectHost } from "./effects.ts";

export interface UnimplementedRecord {
  source: string;
  cmd: EffectCommand;
}

export interface PlayerHooks {
  /** Transform live entities after an upgrade-unit command. */
  onUnitUpgraded(player: Player, fromId: number, toId: number): void;
  /** Spawn units at anchor buildings (effect command 7). */
  onSpawnUnits(player: Player, unitId: number, anchorId: number, count: number): void;
  /** Live entities of a type get healed/scaled when max HP changes. */
  onTypeHpChanged(player: Player, unitId: number, mode: "add" | "mul" | "set", value: number): void;
  /** All players on this player's team (mutual allies incl. self). */
  teamOf(player: Player): Player[];
}

const RESOURCE_TABLE_SIZE = 280;

export class Player {
  readonly id: number;
  readonly civId: number;
  readonly data: GameData;
  readonly resources: Float64Array;
  /** Clone-on-write unit def overlay. */
  private overlay = new Map<number, UnitDef>();
  /** Explicit availability toggles from effect command 2. */
  private unitToggles = new Map<number, boolean>();
  /** fromId -> toId upgrade redirects (transitive). */
  readonly upgradedTo = new Map<number, number>();
  readonly researched = new Set<number>();
  readonly disabledTechs = new Set<number>();
  private availableMarks = new Set<number>();
  /** techId -> resId -> cost override/delta. */
  private techCostMods = new Map<number, Map<number, { mode: "set" | "add"; amount: number }[]>>();
  private techTimeMods = new Map<number, { mode: "set" | "add"; amount: number }[]>();
  readonly unimplemented: UnimplementedRecord[] = [];
  private hooks: PlayerHooks;
  /** ids granted by constructed buildings (building_info.tech_id), with counts. */
  private grantedTechs = new Map<number, number>();

  constructor(id: number, civId: number, data: GameData, hooks: PlayerHooks) {
    this.id = id;
    this.civId = civId;
    this.data = data;
    this.hooks = hooks;
    const civ = data.civs.get(civId);
    if (!civ) throw new Error(`unknown civ ${civId}`);
    this.resources = new Float64Array(RESOURCE_TABLE_SIZE);
    civ.resources.forEach((v, i) => {
      if (v !== null && i < RESOURCE_TABLE_SIZE) this.resources[i] = v;
    });
  }

  // ---- unit type access ----------------------------------------------------------------

  /** Read-only def as this player currently sees it. */
  getType(unitId: number): UnitDef | null {
    const o = this.overlay.get(unitId);
    if (o) return o;
    return this.baseType(unitId);
  }

  private baseType(unitId: number): UnitDef | null {
    if (this.data.civDiffMissing.get(this.civId)?.has(unitId)) return null;
    const base = this.data.units.get(unitId);
    if (!base) return null;
    const diff = this.data.civDiffs.get(this.civId)?.get(unitId);
    if (!diff) return base;
    // civ table differs for this unit: materialise merged copy lazily, once
    const merged = structuredClone(base);
    deepMerge(merged as unknown as Record<string, unknown>, diff as Record<string, unknown>);
    this.overlay.set(unitId, merged);
    return merged;
  }

  mutableType(unitId: number): UnitDef | null {
    const existing = this.overlay.get(unitId);
    if (existing) return existing;
    const base = this.baseType(unitId);
    if (!base) return null;
    if (this.overlay.has(unitId)) return this.overlay.get(unitId)!; // baseType materialised
    const clone = structuredClone(base);
    this.overlay.set(unitId, clone);
    return clone;
  }

  unitIdsOfClass(classId: number): number[] {
    const out: number[] = [];
    for (const [id, def] of this.data.units) {
      const local = this.getType(id);
      if (local && local.class === classId) out.push(id);
    }
    return out;
  }

  /** Resolve upgrade redirects: training unit X actually produces this. */
  resolveUpgrade(unitId: number): number {
    let cur = unitId;
    const seen = new Set<number>();
    while (this.upgradedTo.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.upgradedTo.get(cur)!;
    }
    return cur;
  }

  isUnitEnabled(unitId: number): boolean {
    const t = this.unitToggles.get(unitId);
    if (t !== undefined) return t;
    const def = this.getType(unitId);
    return !!def && def.enabled === 1;
  }

  // ---- effect host ---------------------------------------------------------------------

  effectHost(): EffectHost {
    const player = this;
    return {
      data: player.data,
      mutableType: (id) => player.mutableType(id),
      unitIdsOfClass: (c) => player.unitIdsOfClass(c),
      getRes: (id) => player.resources[id] ?? 0,
      setRes: (id, v) => {
        if (id >= 0 && id < RESOURCE_TABLE_SIZE) player.resources[id] = v;
      },
      enableUnit: (id, on) => player.unitToggles.set(id, on),
      upgradeUnit: (from, to) => {
        player.upgradedTo.set(from, to);
        player.hooks.onUnitUpgraded(player, from, to);
      },
      spawnUnits: (unitId, anchorId, count) =>
        player.hooks.onSpawnUnits(player, unitId, anchorId, count),
      modTechCost: (techId, resId, mode, amount) => {
        let m = player.techCostMods.get(techId);
        if (!m) player.techCostMods.set(techId, (m = new Map()));
        let arr = m.get(resId);
        if (!arr) m.set(resId, (arr = []));
        arr.push({ mode, amount });
      },
      modTechTime: (techId, mode, amount) => {
        let arr = player.techTimeMods.get(techId);
        if (!arr) player.techTimeMods.set(techId, (arr = []));
        arr.push({ mode, amount });
      },
      disableTech: (techId) => player.disabledTechs.add(techId),
      markTechAvailable: (techId) => player.availableMarks.add(techId),
      forceResearch: (techId) => player.markResearched(techId, `forced (cmd 18)`),
      onTypeHpChanged: (unitId, mode, value) =>
        player.hooks.onTypeHpChanged(player, unitId, mode, value),
      reportUnimplemented: (source, cmd) => player.unimplemented.push({ source, cmd }),
      forTeam: (fn) => {
        for (const p of player.hooks.teamOf(player)) fn(p.effectHost());
      },
    };
  }

  // ---- tech engine ---------------------------------------------------------------------

  /** Costs of a tech for THIS player (base + modifiers), pop excluded. */
  techCost(techId: number): Map<number, number> {
    const tech = this.data.techs.get(techId);
    const out = new Map<number, number>();
    if (!tech) return out;
    for (const c of tech.costs) if (c.flag === 1) out.set(c.type, c.amount);
    const mods = this.techCostMods.get(techId);
    if (mods) {
      for (const [res, arr] of mods) {
        let v = out.get(res) ?? 0;
        for (const m of arr) v = m.mode === "set" ? m.amount : v + m.amount;
        out.set(res, Math.max(0, Math.round(v)));
      }
    }
    return out;
  }

  techTime(techId: number): number {
    const tech = this.data.techs.get(techId);
    if (!tech) return 0;
    let t = tech.research_locations[0]?.research_time ?? 0;
    const mods = this.techTimeMods.get(techId);
    if (mods) for (const m of mods) t = m.mode === "set" ? m.amount : t + m.amount;
    return Math.max(0, t);
  }

  /** A building of this type finished: grant its shadow tech. */
  grantBuildingTech(techId: number): void {
    if (techId < 0) return;
    this.grantedTechs.set(techId, (this.grantedTechs.get(techId) ?? 0) + 1);
    if (!this.researched.has(techId)) {
      this.markResearched(techId, `building tech ${techId}`);
    }
    this.runAutoTechs();
  }

  revokeBuildingTech(techId: number): void {
    if (techId < 0) return;
    const n = (this.grantedTechs.get(techId) ?? 0) - 1;
    if (n <= 0) this.grantedTechs.delete(techId);
    else this.grantedTechs.set(techId, n);
    // genie does not un-apply effects when the last building dies; neither do we
  }

  prereqsMet(tech: TechDef): boolean {
    // required_tech_count with an EMPTY list (e.g. "Castle built") means the tech
    // can only ever be granted externally (by a building), never satisfied here
    const need = tech.required_tech_count > 0 ? tech.required_tech_count : tech.required_techs.length;
    if (need === 0) return true;
    let have = 0;
    for (const r of tech.required_techs) if (this.researched.has(r)) have++;
    return have >= need;
  }

  civGateOk(tech: TechDef): boolean {
    return tech.civ === -1 || tech.civ === this.civId;
  }

  canResearch(techId: number): boolean {
    const tech = this.data.techs.get(techId);
    if (!tech) return false;
    if (this.researched.has(techId) || this.disabledTechs.has(techId)) return false;
    if (!this.civGateOk(tech)) return false;
    return this.prereqsMet(tech);
  }

  markResearched(techId: number, source?: string): void {
    if (this.researched.has(techId)) return;
    this.researched.add(techId);
    const tech = this.data.techs.get(techId);
    if (tech && tech.effect_id >= 0) {
      applyEffect(this.effectHost(), tech.effect_id, source ?? tech.name);
    }
  }

  /** Fire every eligible location-less tech until fixpoint. */
  runAutoTechs(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, tech] of this.data.techs) {
        if (this.researched.has(id) || this.disabledTechs.has(id)) continue;
        // a real research location (id >= 0) means player-researched; the shadow
        // techs all carry location_id -1
        if (tech.research_locations.some((l) => l.location_id >= 0)) continue;
        if (!this.civGateOk(tech)) continue;
        // roots with neither prereqs nor a civ gate (Dark Age, mode markers,
        // team-bonus payloads like "Wu TB local") never fire from the graph -
        // they are granted explicitly (game setup, buildings, effect command 18)
        if (tech.required_techs.length === 0 && tech.civ === -1) continue;
        if (!this.prereqsMet(tech)) continue;
        this.markResearched(id, tech.name);
        changed = true;
      }
    }
  }

  /** Apply the civ tech tree, then the auto-tech fixpoint. Team bonuses are
   *  applied by Game.initCivs to EVERY team member - the Genie behavior. */
  initCiv(): void {
    // game-setup grants for a standard start: the starting age and the
    // "Town Center Spawn" marker that standard-map civ bonuses hang off
    this.markResearched(104, "Dark Age (game start)");
    this.markResearched(639, "Town Center Spawn (standard start)");
    const civ = this.data.civs.get(this.civId)!;
    applyEffect(this.effectHost(), civ.tech_tree_id, `${civ.name} tech tree`);
    this.runAutoTechs();
  }

  currentAge(): number {
    return this.resources[6] ?? 0;
  }
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k])) {
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
