/**
 * A live object in the world: unit, building, resource (tree/mine/bush), animal,
 * projectile, or corpse. Stats are always read through the owning player's type
 * table (gaia entities read the base table), so tech effects apply instantly to
 * everything alive - the Genie model.
 */

import type { UnitDef } from "../data/registry.ts";

export type EntityState =
  | "idle"
  | "moving"
  | "gathering"
  | "returning" // carrying resources to drop-off
  | "building"
  | "repairing"
  | "attacking"
  | "dead"
  | "corpse"
  | "foundation"
  | "training" // building with active production
  | "garrisoned"
  | "transforming" // treb packing/unpacking
  | "projectile";

export interface Waypoint {
  x: number;
  y: number;
}

export interface Order {
  kind:
    | "move"
    | "gather"
    | "build"
    | "repair"
    | "attack"
    | "attack_move"
    | "garrison"
    | "ungarrison"
    | "convert"
    | "heal"
    | "trade"
    | "attack_ground"
    | "stop";
  targetId?: number;
  x?: number;
  y?: number;
}

// fallback for stray constructions; real games allocate from Game.nextEntityId
// so parallel simulations stay independent (lockstep determinism)
let nextEntityId = 1;

export function resetEntityIds(): void {
  nextEntityId = 1;
}

export class Entity {
  readonly id: number;
  /** -1 = gaia */
  owner: number;
  typeId: number;
  x: number;
  y: number;
  hp: number;
  state: EntityState = "idle";
  orders: Order[] = [];
  path: Waypoint[] = [];
  /** villager job type id (VMLUM etc.) while gathering; 0 = none */
  jobTypeId = 0;
  /** carried resource: [resId, amount] */
  carry: [number, number] | null = null;
  targetId = 0;
  /** generic per-state timer (gather ticks, corpse decay, etc.) */
  timer = 0;
  /** combat */
  reloadLeft = 0;
  frameDelayLeft = 0;
  attackReady = false;
  charge = 0;
  /** building construction points remaining (foundation) */
  buildLeft = 0;
  buildTotal = 0;
  /** production queue: unit type ids or tech ids */
  queue: { kind: "unit" | "tech"; id: number; timeLeft: number; started: boolean }[] = [];
  garrisoned: number[] = [];
  insideOf = 0;
  /** projectile flight */
  vx = 0;
  vy = 0;
  flightLeft = 0;
  projectileDamage: { attacks: { class: number; amount: number }[]; sourceOwner: number; smart: boolean; targetId: number; blastMode?: number } | null = null;
  /** remaining resource amount for gatherables/corpses (food on sheep etc.) */
  resAmount = 0;
  resType = -1;
  /** monk faith 0..100 */
  faith = 100;
  /** conversion-interval bookkeeping (persists while chasing; reset on manual orders) */
  ci = 0;
  ciTimer = 0;
  ciTargetId = 0;
  hasRelic = false;
  /** relics stored in this building */
  relics = 0;
  /** gates: locked gates block allies too */
  locked = false;
  /** 0 aggressive, 1 defensive, 2 stand ground, 3 no attack */
  stance = 0;
  /** treb pack/unpack: seconds remaining, and the type to become */
  transformLeft = 0;
  transformTo = 0;
  /** anchor for defensive-stance leash */
  postX = -1;
  postY = -1;
  /** stat snapshot for converted entities (attributes lock at conversion) */
  snapshot: UnitDef | null = null;
  rallyX = -1;
  rallyY = -1;

  constructor(id: number | null, owner: number, typeId: number, x: number, y: number, def: UnitDef) {
    this.id = id ?? nextEntityId++;
    this.owner = owner;
    this.typeId = typeId;
    this.x = x;
    this.y = y;
    this.hp = def.hp;
    // storage 17 is fish food
    const st = def.storages?.find((s) => ((s.type >= 0 && s.type <= 3) || s.type === 17) && s.amount > 0);
    if (st) {
      this.resAmount = st.amount;
      this.resType = st.type === 17 ? 0 : st.type;
    }
  }
}
