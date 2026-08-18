/**
 * Typed access to the exported dat database (sim/data/*.json).
 *
 * The registry is immutable shared truth: the base (gaia) unit table, techs,
 * effects, civs, graphics timing, strings. Per-player mutable copies live in
 * Player (overlay tables), never here.
 */

export interface AttackArmor {
  class: number;
  amount: number;
}

export interface TaskData {
  task_type: number;
  id: number;
  is_default: number;
  action_type: number;
  class_id: number;
  unit_id: number;
  terrain_id: number;
  resource_in: number;
  resource_multiplier: number;
  resource_out: number;
  work_value_1: number | null;
  work_value_2: number | null;
  work_range: number;
  auto_search_targets: number;
  search_wait_time: number;
  enable_targeting: number;
  combat_level_flag: number;
  gather_type: number;
  target_diplomacy: number;
  carry_check: number;
  pick_for_construction: number;
  enabled: number;
}

export interface CombatData {
  base_armor: number;
  attacks: AttackArmor[];
  armours: AttackArmor[];
  defense_terrain_bonus: number;
  bonus_damage_resistance: number;
  max_range: number;
  min_range: number;
  displayed_range: number;
  blast_width: number;
  blast_attack_level: number;
  blast_damage: number;
  reload_time: number;
  displayed_reload_time: number;
  projectile_unit_id: number;
  accuracy_percent: number;
  accuracy_dispersion: number;
  frame_delay: number;
  break_off_combat: number;
  displayed_attack: number;
  displayed_melee_armour: number;
  damage_reflection: number;
  friendly_fire_damage: number;
  interrupt_frame: number;
  garrison_firepower: number;
  attack_graphic: number;
}

export interface ProjectileInfo {
  projectile_type: number;
  smart_mode: number;
  hit_mode: number;
  vanish_mode: number;
  area_effect_specials: number;
  projectile_arc: number;
}

export interface CostEntry {
  type: number;
  amount: number;
  flag: number;
}

export interface CreatableData {
  costs: CostEntry[];
  train_locations: { unit_id: number; train_time: number; button_id: number }[];
  rear_attack_modifier: number;
  flank_attack_modifier: number;
  hero_mode: number;
  max_charge: number;
  recharge_rate: number;
  charge_event: number;
  charge_type: number;
  charge_target: number;
  charge_projectile_unit: number;
  attack_priority: number;
  invulnerability_level: number;
  min_conversion_time_mod: number;
  max_conversion_time_mod: number;
  conversion_chance_mod: number;
  total_projectiles: number;
  max_total_projectiles: number;
  projectile_spawning_area: number[];
  secondary_projectile_unit: number;
  special_ability: number;
}

export interface BuildingInfo {
  adjacent_mode: number;
  disappears_when_built: number;
  stack_unit_id: number;
  foundation_terrain_id: number;
  tech_id: number;
  can_burn: number;
  annexes: { unit_id: number; x: number; y: number }[];
  head_unit: number;
  transform_unit: number;
  garrison_type: number;
  garrison_heal_rate: number;
  garrison_repair_rate: number;
  pile_unit: number;
}

export interface BirdData {
  default_task_id: number;
  search_radius: number;
  work_rate: number;
  drop_sites: number[];
  task_swap_group: number;
  run_pattern: number;
  tasks: TaskData[];
}

export interface StorageEntry {
  type: number;
  amount: number;
  flag: number;
}

export interface UnitDef {
  id: number;
  name: string;
  name_id: number;
  type: number;
  class: number;
  hp: number;
  los: number;
  garrison_capacity: number;
  radius: [number, number, number];
  clearance: [number, number];
  dead_unit: number;
  enabled: number;
  disabled: number;
  hill_mode: number;
  fog_visibility: number;
  terrain_restriction: number;
  fly_mode: number;
  resource_capacity: number;
  resource_decay: number;
  blast_defense: number;
  combat_level: number;
  interaction_mode: number;
  minimap_mode: number;
  multiple_attribute_mode: number;
  obstruction_type: number;
  obstruction_class: number;
  trait: number;
  civilization: number;
  can_be_built_on: number;
  sort_number: number;
  enable_auto_gather: number;
  create_doppelganger_on_death: number;
  resource_gather_group: number;
  convert_terrain: number;
  storages?: StorageEntry[];
  speed?: number;
  move?: {
    rotation_speed: number;
    tracking_unit: number;
    tracking_unit_mode: number;
    tracking_unit_density: number;
    turn_radius: number;
    turn_radius_speed: number;
    max_yaw_per_second_moving: number;
    max_yaw_per_second_stationary: number;
  };
  bird?: BirdData;
  combat?: CombatData;
  projectile_info?: ProjectileInfo;
  creatable?: CreatableData;
  building_info?: BuildingInfo;
}

export interface TechDef {
  name: string;
  name_id: number;
  civ: number;
  full_tech_mode: number;
  required_techs: number[];
  required_tech_count: number;
  costs: CostEntry[];
  research_locations: { location_id: number; research_time: number; button_id: number }[];
  effect_id: number;
  type: number;
  repeatable: number;
}

export interface EffectCommand {
  type: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface EffectDef {
  name: string;
  commands: EffectCommand[];
}

export interface CivDef {
  name: string;
  player_type: number;
  tech_tree_id: number;
  team_bonus_id: number;
  icon_set: number;
  resources: (number | null)[];
}

export interface GraphicTiming {
  frame_duration: number;
  frame_count: number;
  speed_multiplier: number;
  replay_delay: number;
}

/** Genie resource ids used by costs/storages and the player resource table. */
export const RES = {
  FOOD: 0,
  WOOD: 1,
  STONE: 2,
  GOLD: 3,
  POP_HEADROOM: 4, // remaining room under built headroom (houses etc.)
  CONVERSION_RANGE: 5,
  CURRENT_AGE: 6,
  RELICS_CAPTURED: 7,
  TRADE_BONUS: 8,
  TRADE_GOODS: 9,
  POP_CURRENT: 11,
  CORPSE_DECAY_TIME: 12,
  RELIC_INCOME_MODE: 13, // "discovery" in old genie docs
  RUINS_CAPTURED: 14,
  CONVERT_PRIEST: 27,
  CONVERT_BUILDING: 28,
  BUILDING_LIMIT: 30,
  FOOD_LIMIT: 31,
  BONUS_POP_CAP: 32,
  FOOD_MAINTENANCE: 33,
  FAITH: 34,
  FAITH_RECHARGE_RATE: 35,
  FARM_FOOD: 36,
  CIVILIAN_POP: 37,
  ALL_TECHS_ACHIEVED: 39,
  MILITARY_POP: 40,
  CONVERSIONS: 41,
  WONDER: 42,
  TRIBUTE_INEFFICIENCY: 46,
  GOLD_MINING_PRODUCTIVITY: 47,
  TOWN_CENTER_UNAVAILABLE: 48,
  REVEAL_ENEMY: 50,
  MONASTERIES: 52,
  RELICS_GARRISONED: 59,
  BERSERKER_HEAL_TIMER: 96,
  DOMINANT_SHEEP_CONTROL: 97,
  HEAL_RANGE: 90, // monk heal range (base 4; Teutons set 8)
  CONV_RESIST_MIN: 178, // extra min conversion intervals when OUR units are targeted (Faith/Devotion)
  CONV_RESIST_MAX: 179,
  RELIC_GOLD_PER_MIN: 191, // 30 => 0.5 gold/s per garrisoned relic
  THEOCRACY: 193, // only the converting monk loses faith on group conversions
} as const;

/** Well-known unit ids (identification only; stats always come from data). */
export const UNIT = {
  VILLAGER_M: 83,
  VILLAGER_F: 293,
  TOWN_CENTER: 109,
  HOUSE: 70,
  BARRACKS: 12,
  MILL: 68,
  LUMBER_CAMP: 562,
  MINING_CAMP: 584,
  FARM: 50,
  DOCK: 45,
  SHEEP: 594,
  BOAR: 48,
  DEER: 65,
  BERRY_BUSH: 59,
  GOLD_MINE: 66,
  STONE_MINE: 102,
  TREE_OAK: 349,
  SCOUT_CAVALRY: 448,
  MILITIA: 74,
  // villager job units (the dat models each job as its own unit)
  VIL_FARMER: 259,
  VIL_FORAGER: 120,
  VIL_HUNTER: 122,
  VIL_SHEPHERD: 592,
  VIL_FISHER: 56,
  VIL_LUMBERJACK: 123,
  VIL_STONE_MINER: 124,
  VIL_GOLD_MINER: 579,
  VIL_BUILDER: 118,
  VIL_REPAIRER: 156,
} as const;

/** Well-known tech ids. */
export const TECH = {
  LOOM: 22,
  FEUDAL_AGE: 101,
  CASTLE_AGE: 102,
  IMPERIAL_AGE: 103,
  DARK_AGE: 104,
} as const;

export interface GameData {
  units: Map<number, UnitDef>;
  civDiffs: Map<number, Map<number, Partial<UnitDef>>>;
  civDiffMissing: Map<number, Set<number>>;
  techs: Map<number, TechDef>;
  effects: Map<number, EffectDef>;
  civs: Map<number, CivDef>;
  graphics: Map<number, GraphicTiming>;
  strings: Map<number, string>;
}

export function buildRegistry(raw: {
  units: { units: Record<string, UnitDef> };
  civ_unit_diffs: Record<string, Record<string, unknown>>;
  techs: Record<string, TechDef>;
  effects: Record<string, EffectDef>;
  civs: Record<string, CivDef>;
  graphics: Record<string, GraphicTiming>;
  strings: Record<string, string>;
}): GameData {
  const units = new Map<number, UnitDef>();
  for (const [id, u] of Object.entries(raw.units.units)) units.set(Number(id), u);

  const civDiffs = new Map<number, Map<number, Partial<UnitDef>>>();
  const civDiffMissing = new Map<number, Set<number>>();
  for (const [civId, diff] of Object.entries(raw.civ_unit_diffs)) {
    const m = new Map<number, Partial<UnitDef>>();
    const missing = new Set<number>();
    for (const [uid, delta] of Object.entries(diff)) {
      if (uid === "_missing") {
        for (const x of delta as number[]) missing.add(x);
      } else {
        m.set(Number(uid), delta as Partial<UnitDef>);
      }
    }
    civDiffs.set(Number(civId), m);
    civDiffMissing.set(Number(civId), missing);
  }

  const techs = new Map<number, TechDef>();
  for (const [id, t] of Object.entries(raw.techs)) techs.set(Number(id), t);
  const effects = new Map<number, EffectDef>();
  for (const [id, e] of Object.entries(raw.effects)) effects.set(Number(id), e);
  const civs = new Map<number, CivDef>();
  for (const [id, c] of Object.entries(raw.civs)) civs.set(Number(id), c);
  const graphics = new Map<number, GraphicTiming>();
  for (const [id, g] of Object.entries(raw.graphics)) graphics.set(Number(id), g);
  const strings = new Map<number, string>();
  for (const [id, s] of Object.entries(raw.strings)) strings.set(Number(id), s);

  return { units, civDiffs, civDiffMissing, techs, effects, civs, graphics, strings };
}

/** Node-side loader (tests, headless runs). The client fetches instead. */
export async function loadRegistryFromDisk(dataDir: string): Promise<GameData> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const read = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf-8"));
  return buildRegistry({
    units: read("units.json"),
    civ_unit_diffs: read("civ_unit_diffs.json"),
    techs: read("techs.json"),
    effects: read("effects.json"),
    civs: read("civs.json"),
    graphics: read("graphics.json"),
    strings: read("strings.json"),
  });
}
