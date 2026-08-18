/**
 * The deterministic simulation: players, entities, map, tick loop, command entry.
 * Fixed 20 Hz tick; all rates in game-seconds, exactly as the data specifies them.
 */

import type { GameData, UnitDef } from "../data/registry.ts";
import { RES } from "../data/registry.ts";
import { Entity, resetEntityIds, type Order } from "./entity.ts";
import { GameMap } from "./map.ts";
import { Player, type PlayerHooks } from "./player.ts";
import { applyEffect } from "./effects.ts";
import { Rng } from "./rng.ts";
import { stepMovement } from "../systems/movement.ts";
import { stepGather } from "../systems/gather.ts";
import { stepBuild } from "../systems/build.ts";
import { stepProduction } from "../systems/train.ts";
import { stepCombat } from "../systems/combat.ts";
import { stepProjectiles } from "../systems/projectiles.ts";
import { stepUpkeep } from "../systems/upkeep.ts";
import { stepMonk } from "../systems/monk.ts";
import { stepGarrison } from "../systems/garrison.ts";
import { stepTrade } from "../systems/market.ts";

export const TICK = 0.05; // 20 sim ticks per game-second

export interface PlayerConfig {
  civId: number;
  team: number; // 0 = no team (solo)
}

export interface GameConfig {
  mapW: number;
  mapH: number;
  seed: number;
  players: PlayerConfig[];
  popCap: number;
  /** standard = 200f 200w 100g 200s */
  startingResources?: { food: number; wood: number; gold: number; stone: number };
  /** wonder/relic countdown override in years (1 year = 5 game-seconds);
   *  default derives from map size (120 tiles -> 200 years) */
  victoryYears?: number;
}

/** Family aliases: effect anchors that mean "the Town Center". */
const TC_FAMILY = new Set([109, 71, 141, 142, 614, 615, 616, 617, 618, 619, 620, 621, 2275, 2276, 2277]);

export class Game {
  readonly data: GameData;
  readonly map: GameMap;
  readonly players: Player[] = [];
  readonly entities = new Map<number, Entity>();
  readonly rng: Rng;
  readonly config: GameConfig;
  time = 0;
  tickCount = 0;
  /** per-game entity id allocator - never shared between simulations */
  private nextEntityId = 1;
  /** per-player pop bookkeeping */
  popUsed: number[] = [];
  popHeadroom: number[] = [];
  /** relics garrisoned per player (kept engine-side; the civ resource vector's
   *  index for this is not trusted - it ships with nonzero defaults) */
  relicsGarrisoned: number[] = [];
  /** farm auto-reseed toggle per player */
  autoReseed: boolean[] = [];

  constructor(data: GameData, config: GameConfig) {
    this.data = data;
    this.config = config;
    this.map = new GameMap(config.mapW, config.mapH);
    this.rng = new Rng(config.seed);
    resetEntityIds();

    const hooks: PlayerHooks = {
      onUnitUpgraded: (p, from, to) => this.transformUnits(p, from, to),
      onSpawnUnits: (p, unitId, anchorId, count) => this.effectSpawn(p, unitId, anchorId, count),
      onTypeHpChanged: (p, unitId, mode, value) => {
        for (const e of this.entities.values()) {
          if (e.owner === p.id && e.typeId === unitId && e.state !== "dead") {
            if (mode === "add") e.hp += value;
            else if (mode === "mul") e.hp *= value;
            else e.hp = Math.min(e.hp, value);
          }
        }
      },
      teamOf: (p) => {
        const cfg = this.config.players[p.id];
        if (!cfg || cfg.team === 0) return [p];
        return this.players.filter((q) => this.config.players[q.id]?.team === cfg.team);
      },
    };

    config.players.forEach((pc, i) => {
      const p = new Player(i, pc.civId, data, hooks);
      const sr = config.startingResources ?? { food: 200, wood: 200, gold: 100, stone: 200 };
      p.resources[RES.FOOD] = sr.food;
      p.resources[RES.WOOD] = sr.wood;
      p.resources[RES.GOLD] = sr.gold;
      p.resources[RES.STONE] = sr.stone;
      this.players.push(p);
      this.popUsed.push(0);
      this.popHeadroom.push(0);
      this.relicsGarrisoned.push(0);
      this.autoReseed.push(true);
    });
  }

  /** Call after starting entities are placed: civ bonuses may spawn extra units. */
  initCivs(): void {
    for (const p of this.players) p.initCiv();
    // team bonuses land on every mutually-allied player (self included)
    for (const p of this.players) {
      const civ = this.data.civs.get(p.civId)!;
      const cfg = this.config.players[p.id];
      const team =
        cfg.team === 0 ? [p] : this.players.filter((q) => this.config.players[q.id]?.team === cfg.team);
      for (const member of team) {
        applyEffect(member.effectHost(), civ.team_bonus_id, `${civ.name} team bonus`);
      }
    }
    for (const p of this.players) p.runAutoTechs();
  }

  // ---- entity lifecycle ------------------------------------------------------------------

  defOf(e: Entity): UnitDef {
    // converted entities read their locked snapshot, never the new owner's table
    if (e.snapshot) return e.snapshot;
    const p = e.owner >= 0 ? this.players[e.owner] : null;
    const def = p ? p.getType(e.typeId) : this.data.units.get(e.typeId);
    if (!def) throw new Error(`no def for type ${e.typeId} owner ${e.owner}`);
    return def;
  }

  isBuildingType(def: UnitDef): boolean {
    return def.type === 80;
  }

  spawn(owner: number, typeId: number, x: number, y: number, opts?: { foundation?: boolean }): Entity {
    const p = owner >= 0 ? this.players[owner] : null;
    const def = p ? p.getType(typeId) : this.data.units.get(typeId);
    if (!def) throw new Error(`spawn: unknown type ${typeId}`);
    const e = new Entity(this.nextEntityId++, owner, typeId, x, y, def);
    this.entities.set(e.id, e);
    if (def.speed === undefined || def.speed === 0) {
      // static: occupy tiles (buildings, trees, mines, bushes) - but never
      // mobile type-80s like the packed trebuchet
      if (def.type === 80 || def.obstruction_type >= 2) {
        this.map.occupy(e, def.radius[0], def.radius[1]);
      }
    }
    this.map.indexEntity(e);
    if (opts?.foundation && def.type === 80) {
      e.state = "foundation";
      e.buildTotal = def.creatable?.train_locations[0]?.train_time ?? 0;
      // construction time for buildings is the train_time on their own creatable
      if (e.buildTotal === 0) e.buildTotal = 15;
      e.buildLeft = e.buildTotal;
      e.hp = 1;
    } else if (def.type === 80 && owner >= 0) {
      this.onBuildingComplete(e, def);
    }
    if (owner >= 0 && def.type !== 80) {
      this.popUsed[owner] += this.popCostOf(def);
    }
    return e;
  }

  popCostOf(def: UnitDef): number {
    const popEntry = def.creatable?.costs.find((c) => c.type === 4);
    let pop = popEntry ? popEntry.amount : 0;
    const factor = (def as UnitDef & { pop_factor?: number }).pop_factor;
    if (factor !== undefined) pop *= factor;
    return pop;
  }

  onBuildingComplete(e: Entity, def: UnitDef): void {
    const p = this.players[e.owner];
    if (!p) return;
    const st = def.storages?.find((s) => s.type === 4);
    if (st && st.amount) this.popHeadroom[e.owner] += st.amount;
    if (def.building_info) {
      p.grantBuildingTech(def.building_info.tech_id);
      // annex pieces (TC quadrants etc.) grant their own shadow techs; we model
      // composite buildings as one entity, so grant those here
      for (const annex of def.building_info.annexes) {
        const aDef = this.data.units.get(annex.unit_id);
        const t = aDef?.building_info?.tech_id;
        if (t !== undefined && t >= 0) p.grantBuildingTech(t);
      }
    }
    p.runAutoTechs();
  }

  kill(e: Entity): void {
    const def = this.defOf(e);
    if (def.type === 80 || def.obstruction_type >= 2) this.map.vacate(e, def.radius[0], def.radius[1]);
    this.map.unindexEntity(e);
    if (e.owner >= 0) {
      if (def.type === 80) {
        const st = def.storages?.find((s) => s.type === 4);
        if (st && st.amount && e.state !== "foundation") this.popHeadroom[e.owner] -= st.amount;
        if (def.building_info && e.state !== "foundation") {
          this.players[e.owner]?.revokeBuildingTech(def.building_info.tech_id);
        }
      } else {
        this.popUsed[e.owner] -= this.popCostOf(def);
      }
    }
    // corpse chain: animals leave a gatherable carcass carrying remaining food
    // (owner irrelevant: captured sheep still leave a carcass when slaughtered)
    if (def.dead_unit >= 0 && e.resAmount > 0 && e.resType === 0 && def.type === 70) {
      const corpse = new Entity(this.nextEntityId++, -1, def.dead_unit, e.x, e.y, this.data.units.get(def.dead_unit)!);
      corpse.state = "corpse";
      corpse.resAmount = e.resAmount;
      corpse.resType = 0;
      const cd = this.data.units.get(def.dead_unit);
      corpse.timer = cd?.storages?.find((s) => s.type === 12)?.amount ?? 60;
      this.entities.set(corpse.id, corpse);
      this.map.indexEntity(corpse);
    }
    // units inside a destroyed building die with it
    for (const gid of e.garrisoned) {
      const g = this.entities.get(gid);
      if (g) {
        if (g.owner >= 0) {
          const gDef = this.defOf(g);
          if (gDef.type !== 80) this.popUsed[g.owner] -= this.popCostOf(gDef);
        }
        if (g.hasRelic) {
          const relicDef = this.data.units.get(285);
          if (relicDef) {
            const r = new Entity(this.nextEntityId++, -1, 285, e.x, e.y, relicDef);
            this.entities.set(r.id, r);
            this.map.indexEntity(r);
          }
        }
        this.entities.delete(gid);
      }
    }
    e.garrisoned = [];
    // a monk carrying a relic drops it where it fell
    if (e.hasRelic) {
      const relicDef = this.data.units.get(285);
      if (relicDef) {
        const r = new Entity(this.nextEntityId++, -1, 285, e.x, e.y, relicDef);
        this.entities.set(r.id, r);
        this.map.indexEntity(r);
      }
    }
    e.state = "dead";
    this.entities.delete(e.id);
  }

  transformUnits(p: Player, from: number, to: number): void {
    for (const e of this.entities.values()) {
      if (e.owner !== p.id || e.typeId !== from) continue;
      const oldDef = p.getType(from);
      const newDef = p.getType(to);
      if (!newDef) continue;
      const damage = oldDef ? Math.max(0, oldDef.hp - e.hp) : 0;
      const wasBuilding = oldDef ? this.isBuildingType(oldDef) : false;
      if (wasBuilding) this.map.vacate(e, oldDef!.radius[0], oldDef!.radius[1]);
      e.typeId = to;
      e.hp = Math.max(1, newDef.hp - damage);
      if (this.isBuildingType(newDef)) this.map.occupy(e, newDef.radius[0], newDef.radius[1]);
    }
  }

  effectSpawn(p: Player, unitId: number, anchorId: number, count: number): void {
    const anchors: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.owner !== p.id) continue;
      const matches = TC_FAMILY.has(anchorId)
        ? TC_FAMILY.has(e.typeId)
        : e.typeId === anchorId || p.resolveUpgrade(anchorId) === e.typeId;
      if (matches && (e.state === "idle" || e.state === "training")) anchors.push(e);
    }
    for (const a of anchors) {
      for (let i = 0; i < count; i++) {
        const spot = this.findFreeSpotNear(a, p.getType(unitId));
        if (spot) this.spawn(p.id, p.resolveUpgrade(unitId), spot.x, spot.y);
      }
    }
  }

  findFreeSpotNear(anchor: Entity, def: UnitDef | null): { x: number; y: number } | null {
    const aDef = this.defOf(anchor);
    const r = Math.max(aDef.radius[0], aDef.radius[1]) + 0.5;
    for (let ring = 0; ring < 6; ring++) {
      const rr = r + ring * 0.7;
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const x = anchor.x + Math.cos(ang) * rr;
        const y = anchor.y + Math.sin(ang) * rr;
        if (this.map.isLand(x, y) && this.map.passableTile(Math.floor(x), Math.floor(y))) {
          return { x, y };
        }
      }
    }
    return null;
  }

  // ---- resources -------------------------------------------------------------------------

  canAfford(playerId: number, cost: Map<number, number>): boolean {
    const p = this.players[playerId];
    for (const [res, amt] of cost) {
      if (res === 4) continue;
      if ((p.resources[res] ?? 0) < amt) return false;
    }
    return true;
  }

  pay(playerId: number, cost: Map<number, number>): void {
    const p = this.players[playerId];
    for (const [res, amt] of cost) {
      if (res === 4) continue;
      p.resources[res] -= amt;
    }
  }

  refund(playerId: number, cost: Map<number, number>): void {
    const p = this.players[playerId];
    for (const [res, amt] of cost) {
      if (res === 4) continue;
      p.resources[res] += amt;
    }
  }

  unitCost(playerId: number, typeId: number): Map<number, number> {
    const def = this.players[playerId].getType(typeId);
    const out = new Map<number, number>();
    if (!def?.creatable) return out;
    for (const c of def.creatable.costs) {
      if (c.flag === 1 && c.type !== 4) out.set(c.type, c.amount);
    }
    return out;
  }

  // ---- commands --------------------------------------------------------------------------

  order(playerId: number, entityIds: number[], order: Order, queue = false, formation: "line" | "box" | "staggered" | "flank" = "line"): void {
    // group moves form up facing the destination: melee front, ranged and
    // villagers middle, siege and monks rear (line); box rings the point;
    // staggered doubles the spacing; flank splits into two wings
    const spread = (order.kind === "move" || order.kind === "attack_move") && entityIds.length > 1 && order.x !== undefined;
    let slots: Map<number, { x: number; y: number }> | null = null;
    if (spread) {
      const rank = (id: number): number => {
        const e = this.entities.get(id);
        if (!e) return 1;
        const d = this.defOf(e);
        if (d.class === 13 || d.class === 51 || d.class === 54 || d.class === 18 || d.class === 43) return 2;
        if ((d.combat?.projectile_unit_id ?? -1) >= 0 || d.class === 4) return 1;
        return 0;
      };
      const sorted = [...entityIds].sort((a, b) => rank(a) - rank(b));
      // face the destination: rows run perpendicular to the approach
      let cxm = 0;
      let cym = 0;
      let n = 0;
      for (const id of sorted) {
        const e = this.entities.get(id);
        if (e) {
          cxm += e.x;
          cym += e.y;
          n++;
        }
      }
      const ang = n > 0 ? Math.atan2(order.y! - cym / n, order.x! - cxm / n) : 0;
      const across = { x: -Math.sin(ang), y: Math.cos(ang) };
      const back = { x: -Math.cos(ang), y: -Math.sin(ang) };
      const cols = Math.max(1, Math.ceil(sorted.length / 3));
      const gap = formation === "staggered" ? 1.6 : 0.8;
      slots = new Map();
      sorted.forEach((id, i) => {
        let ax: number;
        let ay: number;
        if (formation === "box") {
          const ringN = sorted.length;
          const ang2 = (i / ringN) * Math.PI * 2;
          const rr = Math.max(1.2, ringN * 0.16);
          ax = order.x! + Math.cos(ang2) * rr;
          ay = order.y! + Math.sin(ang2) * rr;
        } else if (formation === "flank") {
          const wing = i % 2 === 0 ? 1 : -1;
          const k = Math.floor(i / 2);
          ax = order.x! + across.x * wing * (2.5 + k * 0.8);
          ay = order.y! + across.y * wing * (2.5 + k * 0.8);
        } else {
          const row = Math.floor(i / cols);
          const col = i % cols;
          ax = order.x! + across.x * (col - (cols - 1) / 2) * gap + back.x * row * (gap + 0.1);
          ay = order.y! + across.y * (col - (cols - 1) / 2) * gap + back.y * row * (gap + 0.1);
        }
        slots!.set(id, { x: ax, y: ay });
      });
    }
    for (const id of entityIds) {
      const e = this.entities.get(id);
      if (!e || e.owner !== playerId) continue;
      let o = order;
      const slot = slots?.get(id);
      if (slot) o = { ...order, x: slot.x, y: slot.y };
      if (!queue) {
        e.orders = [o];
        e.path = [];
        // manual orders reset monk conversion progress (the wiki rule)
        e.ci = 0;
        e.ciTimer = 0;
        if (e.state !== "foundation" && e.state !== "training") e.state = "idle";
      } else {
        e.orders.push(o);
      }
    }
  }

  trainUnit(playerId: number, buildingId: number, typeId: number): boolean {
    const b = this.entities.get(buildingId);
    const p = this.players[playerId];
    if (!b || b.owner !== playerId || b.state === "foundation") return false;
    if (!p.isUnitEnabled(typeId)) return false;
    if (b.queue.length >= 15) return false;
    const cost = this.unitCost(playerId, typeId);
    if (!this.canAfford(playerId, cost)) return false;
    this.pay(playerId, cost);
    const def = p.getType(p.resolveUpgrade(typeId))!;
    const tt = def.creatable?.train_locations.find((l) => true)?.train_time ?? 0;
    b.queue.push({ kind: "unit", id: typeId, timeLeft: tt, started: false });
    return true;
  }

  researchTech(playerId: number, buildingId: number, techId: number): boolean {
    const b = this.entities.get(buildingId);
    const p = this.players[playerId];
    if (!b || b.owner !== playerId || b.state === "foundation") return false;
    if (!p.canResearch(techId)) return false;
    // location gate: the tech must be researchable at this building type
    const tech = this.data.techs.get(techId)!;
    const locOk = tech.research_locations.some((l) => {
      const fam = this.familyOf(l.location_id, p);
      return fam.has(b.typeId);
    });
    if (!locOk) return false;
    if (b.queue.some((q) => q.kind === "tech" && q.id === techId)) return false;
    const cost = p.techCost(techId);
    if (!this.canAfford(playerId, cost)) return false;
    this.pay(playerId, cost);
    b.queue.push({ kind: "tech", id: techId, timeLeft: p.techTime(techId), started: false });
    return true;
  }

  /** All type ids reachable from `base` through this player's upgrade chain. */
  familyOf(base: number, p: Player): Set<number> {
    const fam = new Set<number>([base]);
    let cur = base;
    const seen = new Set<number>();
    while (p.upgradedTo.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = p.upgradedTo.get(cur)!;
      fam.add(cur);
    }
    return fam;
  }

  /** Docks (terrain restriction 6) sit on water tiles touching the shore. */
  private dockPlacementOk(x: number, y: number, rx: number, ry: number): boolean {
    const x0 = Math.round(x - rx);
    const y0 = Math.round(y - ry);
    const x1 = Math.ceil(x + rx) - 1;
    const y1 = Math.ceil(y + ry) - 1;
    let touchesLand = false;
    for (let ty = y0; ty <= Math.max(y0, y1); ty++) {
      for (let tx = x0; tx <= Math.max(x0, x1); tx++) {
        if (!this.map.inBounds(tx, ty)) return false;
        const i = ty * this.map.w + tx;
        if (this.map.terrain[i] !== 1 || this.map.occupied[i] !== 0) return false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (this.map.inBounds(tx + dx, ty + dy) && this.map.terrain[(ty + dy) * this.map.w + tx + dx] === 0) {
              touchesLand = true;
            }
          }
        }
      }
    }
    return touchesLand;
  }

  private waterPlacementOk(x: number, y: number, rx: number, ry: number): boolean {
    const x0 = Math.round(x - rx);
    const y0 = Math.round(y - ry);
    const x1 = Math.ceil(x + rx) - 1;
    const y1 = Math.ceil(y + ry) - 1;
    for (let ty = y0; ty <= Math.max(y0, y1); ty++) {
      for (let tx = x0; tx <= Math.max(x0, x1); tx++) {
        if (!this.map.inBounds(tx, ty)) return false;
        const i = ty * this.map.w + tx;
        if (this.map.terrain[i] !== 1 || this.map.occupied[i] !== 0) return false;
      }
    }
    return true;
  }

  placeFoundation(playerId: number, typeId: number, x: number, y: number): Entity | null {
    const p = this.players[playerId];
    if (!p.isUnitEnabled(typeId)) return null;
    const def = p.getType(typeId);
    if (!def || def.type !== 80) return null;
    const waterBuilding = def.terrain_restriction === 13; // fish traps
    const placeOk =
      def.terrain_restriction === 6
        ? this.dockPlacementOk(x, y, def.radius[0], def.radius[1])
        : waterBuilding
          ? this.waterPlacementOk(x, y, def.radius[0], def.radius[1])
          : this.map.isFreeForFootprint(x, y, def.radius[0], def.radius[1]);
    if (!placeOk) return null;
    const cost = this.unitCost(playerId, typeId);
    if (!this.canAfford(playerId, cost)) return null;
    this.pay(playerId, cost);
    return this.spawn(playerId, typeId, x, y, { foundation: true });
  }

  // ---- tick ------------------------------------------------------------------------------

  tick(): void {
    this.time += TICK;
    this.tickCount++;
    stepProduction(this, TICK);
    stepMovement(this, TICK);
    stepGather(this, TICK);
    stepBuild(this, TICK);
    stepMonk(this, TICK);
    stepGarrison(this, TICK);
    stepTrade(this, TICK);
    stepCombat(this, TICK);
    stepProjectiles(this, TICK);
    stepUpkeep(this, TICK);
    if (this.tickCount % 10 === 0) this.updateVisibility(); // every 0.5s
    if (this.tickCount % 40 === 0) this.checkConquest(); // every 2s
  }

  run(seconds: number): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) this.tick();
  }

  /** Fog of war: per-player tile state - 0 unexplored, 1 explored, 2 visible. */
  visibility: Uint8Array[] = [];

  updateVisibility(): void {
    if (this.visibility.length === 0) {
      this.visibility = this.players.map(() => new Uint8Array(this.map.w * this.map.h));
    }
    for (const vis of this.visibility) {
      for (let i = 0; i < vis.length; i++) if (vis[i] === 2) vis[i] = 1;
    }
    for (const e of this.entities.values()) {
      if (e.owner < 0 || e.state === "corpse" || e.state === "projectile" || e.state === "garrisoned") continue;
      const def = this.defOf(e);
      const los = Math.max(def.los, 1);
      // allies share line of sight
      for (const p of this.players) {
        if (!this.areAllied(p.id, e.owner)) continue;
        const vis = this.visibility[p.id];
        const x0 = Math.max(0, Math.floor(e.x - los));
        const x1 = Math.min(this.map.w - 1, Math.ceil(e.x + los));
        const y0 = Math.max(0, Math.floor(e.y - los));
        const y1 = Math.min(this.map.h - 1, Math.ceil(e.y + los));
        const los2 = los * los;
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const dx = tx + 0.5 - e.x;
            const dy = ty + 0.5 - e.y;
            if (dx * dx + dy * dy <= los2) vis[ty * this.map.w + tx] = 2;
          }
        }
      }
    }
  }

  isVisibleTo(playerId: number, x: number, y: number): boolean {
    const vis = this.visibility[playerId];
    if (!vis) return true;
    return vis[Math.floor(y) * this.map.w + Math.floor(x)] === 2;
  }

  isExploredBy(playerId: number, x: number, y: number): boolean {
    const vis = this.visibility[playerId];
    if (!vis) return true;
    return vis[Math.floor(y) * this.map.w + Math.floor(x)] >= 1;
  }

  /** Conquest: a player with nothing left on the map is defeated; the last
   *  team (or player) standing wins. -1 = game still running. */
  defeated: boolean[] = [];
  winnerTeam: number | null = null;
  /** wonder / relic countdowns, in game-seconds remaining (null = inactive) */
  wonderCountdown: { player: number; left: number } | null = null;
  relicCountdown: { team: number; left: number } | null = null;

  /** Standard victory countdown: years scale with map size, 1 year = 5s. */
  victorySeconds(): number {
    const years =
      this.config.victoryYears ??
      (this.map.w <= 132 ? 200 : this.map.w <= 168 ? 300 : this.map.w <= 200 ? 350 : 400);
    return years * 5;
  }

  private stepVictoryTimers(dt: number): void {
    if (this.winnerTeam !== null) return;
    // wonder: any standing, completed wonder starts/keeps its owner's countdown
    const WONDER = 276;
    let wonderOwner = -1;
    for (const e of this.entities.values()) {
      if (e.state !== "foundation" && e.owner >= 0) {
        const p = this.players[e.owner];
        if (this.familyOf(WONDER, p).has(e.typeId)) {
          wonderOwner = e.owner;
          break;
        }
      }
    }
    if (wonderOwner >= 0) {
      if (!this.wonderCountdown || this.wonderCountdown.player !== wonderOwner) {
        this.wonderCountdown = { player: wonderOwner, left: this.victorySeconds() };
      }
      this.wonderCountdown.left -= dt;
      if (this.wonderCountdown.left <= 0) {
        const t = this.config.players[wonderOwner]?.team ?? 0;
        this.winnerTeam = t === 0 ? -wonderOwner - 1 : t;
      }
    } else {
      this.wonderCountdown = null;
    }
    // relics: one team garrisoning every relic on the map starts the countdown
    let relicsOnMap = 0;
    for (const e of this.entities.values()) {
      const def = this.data.units.get(e.typeId);
      if (def?.class === 42) relicsOnMap++;
      if (e.hasRelic) relicsOnMap++;
    }
    const holders = this.players.filter((p) => this.relicsGarrisoned[p.id] > 0);
    if (relicsOnMap === 0 && holders.length > 0) {
      const teams = new Set(holders.map((p) => this.config.players[p.id]?.team ?? -p.id - 1));
      if (teams.size === 1) {
        const team = [...teams][0];
        if (!this.relicCountdown || this.relicCountdown.team !== team) {
          this.relicCountdown = { team, left: this.victorySeconds() };
        }
        this.relicCountdown.left -= dt;
        // team is a positive team id or the negative solo encoding - never 0
        if (this.relicCountdown.left <= 0) this.winnerTeam = team;
        return;
      }
    }
    this.relicCountdown = null;
  }

  checkConquest(): void {
    this.stepVictoryTimers(2);
    if (this.defeated.length === 0) this.defeated = this.players.map(() => false);
    const alive = new Set<number>();
    for (const e of this.entities.values()) {
      if (e.owner >= 0 && e.state !== "corpse" && e.state !== "projectile") alive.add(e.owner);
    }
    this.players.forEach((p) => {
      if (!alive.has(p.id)) this.defeated[p.id] = true;
    });
    const standing = this.players.filter((p) => !this.defeated[p.id]);
    if (standing.length > 0) {
      const teams = new Set(standing.map((p) => {
        const t = this.config.players[p.id]?.team ?? 0;
        return t === 0 ? `solo${p.id}` : `team${t}`;
      }));
      if (teams.size === 1) {
        const t = this.config.players[standing[0].id]?.team ?? 0;
        this.winnerTeam = t === 0 ? -standing[0].id - 1 : t; // negative encodes solo winner
      }
    }
  }

  areAllied(a: number, b: number): boolean {
    if (a === b) return true;
    if (a < 0 || b < 0) return false;
    const ta = this.config.players[a]?.team ?? 0;
    const tb = this.config.players[b]?.team ?? 0;
    return ta !== 0 && ta === tb;
  }

  housedCheck(playerId: number, def: UnitDef): boolean {
    const pop = this.popCostOf(def);
    const cap = Math.min(this.popHeadroom[playerId], this.config.popCap);
    return this.popUsed[playerId] + pop <= cap;
  }
}
