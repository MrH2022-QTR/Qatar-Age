/**
 * Movement: A* over the tile grid (statics block; moving units do not), string-
 * pulled paths, exact per-second speeds from the player's type table.
 * Pathfinding QUALITY is engine art; speeds and reachability are the contract.
 */

import type { Game } from "../core/game.ts";
import type { Entity, Waypoint } from "../core/entity.ts";
import { beginTransform } from "./upkeep.ts";

const SQRT2 = Math.SQRT2;
const GATE_CLASS = 39;

/** Water-bound terrain restriction ids in the dat (ships, fish, transports). */
const WATER_RESTRICTIONS = new Set([3, 13, 15, 19, 30]);

export type Domain = "land" | "water";

export function domainOf(def: { terrain_restriction: number }): Domain {
  return WATER_RESTRICTIONS.has(def.terrain_restriction) ? "water" : "land";
}

/** Tile passability for a specific mover: gates auto-open for their owner's
 *  team (unless locked) and always block everyone else; ships stay on water,
 *  everyone else stays off it. */
export function passableFor(game: Game, tx: number, ty: number, owner: number, domain: Domain = "land"): boolean {
  const map = game.map;
  if (!map.inBounds(tx, ty)) return false;
  const i = ty * map.w + tx;
  if (domain === "water") {
    if (map.terrain[i] !== 1) return false;
  } else if (map.terrain[i] !== 0) {
    return false;
  }
  const occ = map.occupied[i];
  if (occ === 0) return true;
  const blocker = game.entities.get(occ);
  if (!blocker) return true;
  const def = game.data.units.get(blocker.typeId);
  if (def?.class === GATE_CLASS && !blocker.locked && blocker.state !== "foundation") {
    return game.areAllied(owner, blocker.owner);
  }
  return false;
}

export function findPath(game: Game, e: Entity, tx: number, ty: number): Waypoint[] {
  const map = game.map;
  const dom = domainOf(game.defOf(e));
  const sx = Math.floor(e.x);
  const sy = Math.floor(e.y);
  let gx = Math.floor(tx);
  let gy = Math.floor(ty);
  if (!map.inBounds(gx, gy)) return [];
  // goal blocked (e.g. walking to a tree): path to nearest passable neighbour
  if (!passableFor(game, gx, gy, e.owner, dom)) {
    const alt = nearestPassable(game, gx, gy, 3, e.owner, dom);
    if (!alt) return [];
    gx = alt.x;
    gy = alt.y;
  }
  if (sx === gx && sy === gy) return [{ x: tx, y: ty }];

  const w = map.w;
  const open: number[] = [];
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const start = sy * w + sx;
  const goal = gy * w + gx;
  gScore.set(start, 0);
  fScore.set(start, heur(sx, sy, gx, gy));
  open.push(start);
  const closed = new Set<number>();
  let iterations = 0;
  const MAX_ITER = 20000;

  while (open.length > 0 && iterations++ < MAX_ITER) {
    let bi = 0;
    let bf = Infinity;
    for (let i = 0; i < open.length; i++) {
      const f = fScore.get(open[i]) ?? Infinity;
      if (f < bf) {
        bf = f;
        bi = i;
      }
    }
    const cur = open.splice(bi, 1)[0];
    if (cur === goal) {
      return smooth(game, reconstruct(cameFrom, cur, w, tx, ty), e.owner, dom);
    }
    closed.add(cur);
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        const ni = ny * w + nx;
        if (closed.has(ni)) continue;
        if (!(ni === goal) && !passableFor(game, nx, ny, e.owner, dom)) continue;
        if (ni === goal && !map.inBounds(nx, ny)) continue;
        // no diagonal corner cutting through blocked tiles
        if (dx !== 0 && dy !== 0 && (!passableFor(game, cx + dx, cy, e.owner, dom) || !passableFor(game, cx, cy + dy, e.owner, dom)))
          continue;
        const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const tentative = (gScore.get(cur) ?? Infinity) + step;
        if (tentative < (gScore.get(ni) ?? Infinity)) {
          cameFrom.set(ni, cur);
          gScore.set(ni, tentative);
          fScore.set(ni, tentative + heur(nx, ny, gx, gy));
          if (!open.includes(ni)) open.push(ni);
        }
      }
    }
  }
  return [];
}

function heur(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
}

function reconstruct(cameFrom: Map<number, number>, cur: number, w: number, tx: number, ty: number): Waypoint[] {
  const pts: Waypoint[] = [{ x: tx, y: ty }];
  let c = cur;
  while (cameFrom.has(c)) {
    c = cameFrom.get(c)!;
    pts.push({ x: (c % w) + 0.5, y: Math.floor(c / w) + 0.5 });
  }
  pts.pop(); // drop the start tile
  return pts.reverse();
}

/** String-pulling: drop waypoints reachable in a straight passable line. */
function smooth(game: Game, pts: Waypoint[], owner: number, dom: Domain): Waypoint[] {
  if (pts.length <= 2) return pts;
  const out: Waypoint[] = [];
  let anchorIdx = 0;
  out.push(pts[0]);
  for (let i = 2; i < pts.length; i++) {
    if (!lineFree(game, pts[anchorIdx], pts[i], owner, dom)) {
      out.push(pts[i - 1]);
      anchorIdx = i - 1;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function lineFree(game: Game, a: Waypoint, b: Waypoint, owner: number, dom: Domain): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(dist * 3);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!passableFor(game, Math.floor(x), Math.floor(y), owner, dom)) return false;
  }
  return true;
}

/** Advance an entity along its path. Returns true when the path is finished. */
export function followPath(game: Game, e: Entity, speed: number, dt: number): boolean {
  let budget = speed * dt;
  while (budget > 0 && e.path.length > 0) {
    const wp = e.path[0];
    const dx = wp.x - e.x;
    const dy = wp.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d <= budget) {
      game.map.moveEntity(e, wp.x, wp.y);
      e.path.shift();
      budget -= d;
    } else {
      game.map.moveEntity(e, e.x + (dx / d) * budget, e.y + (dy / d) * budget);
      budget = 0;
    }
  }
  return e.path.length === 0;
}

export function nearestPassable(game: Game, tx: number, ty: number, maxR: number, owner = -1, dom: Domain = "land"): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (passableFor(game, tx + dx, ty + dy, owner, dom)) return { x: tx + dx, y: ty + dy };
      }
    }
  }
  return null;
}

/** Generic move-order handling for any mobile entity. */
export function stepMovement(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    if (e.state === "projectile" || e.state === "dead" || e.state === "corpse" || e.state === "transforming") continue;
    const order = e.orders[0];
    if (!order || order.kind !== "move") continue;
    const def = game.defOf(e);
    let speed = def.speed ?? 0;
    // rams speed up with garrisoned infantry
    if (def.class === 13 && e.garrisoned.length > 0) speed *= 1 + 0.05 * e.garrisoned.length;
    if (speed <= 0) {
      // an unpacked trebuchet packs itself before it can move
      const to = def.building_info?.transform_unit ?? -1;
      const toDef = to >= 0 ? game.data.units.get(to) : undefined;
      if (toDef && (toDef.speed ?? 0) > 0) {
        beginTransform(game, e, def);
        continue;
      }
      e.orders.shift();
      continue;
    }
    if (e.path.length === 0 && e.state !== "moving") {
      e.path = findPath(game, e, order.x!, order.y!);
      if (e.path.length === 0) {
        e.orders.shift();
        e.state = "idle";
        continue;
      }
      e.state = "moving";
    }
    if (followPath(game, e, speed, dt)) {
      e.orders.shift();
      e.state = "idle";
    }
  }
}
