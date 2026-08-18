/**
 * Market economy.
 *
 * Commodities trade in 100-unit lots against GLOBAL per-commodity exchange
 * rates (gold per 100): wood 100, food 115, stone 130 at game start. Selling
 * pays rate x (1 - fee), buying costs rate x (1 + fee); the fee is the
 * player's resource 78 (0.30 base, Guilds 0.15, Saracens 0.05). Every
 * transaction moves that commodity's global rate by 2 (floor 20, cap 9999).
 *
 * Tribute costs amount x (1 + resource 46) - 0.30 base, Banking free.
 *
 * Trade carts: gold per delivery = (2 x work_rate / speed) x d x (d/mapSize
 * + 0.3), the community-verified DE formula whose 0.46 coefficient is exactly
 * 2 x 0.2875 / 1.25 from the cart's own dat values - so Caravan and speed
 * changes compose the way the real engine composes them. d is the euclidean
 * distance between market centers with a 5-tile deadzone per axis.
 */

import type { Game } from "../core/game.ts";
import type { Entity } from "../core/entity.ts";
import { RES } from "../data/registry.ts";
import { findPath, followPath } from "./movement.ts";

export const MARKET = 84;
const START_RATES: Record<number, number> = { [RES.WOOD]: 100, [RES.FOOD]: 115, [RES.STONE]: 130 };

export function marketRates(game: Game): Record<number, number> {
  const g = game as Game & { _marketRates?: Record<number, number> };
  if (!g._marketRates) g._marketRates = { ...START_RATES };
  return g._marketRates;
}

function fee(game: Game, playerId: number): number {
  return game.players[playerId].resources[78] ?? 0.3;
}

export function marketSell(game: Game, playerId: number, resId: number): boolean {
  const rates = marketRates(game);
  const rate = rates[resId];
  const p = game.players[playerId];
  if (rate === undefined || p.resources[resId] < 100) return false;
  p.resources[resId] -= 100;
  p.resources[RES.GOLD] += Math.round(rate * (1 - fee(game, playerId)));
  rates[resId] = Math.max(20, rate - 2);
  return true;
}

export function marketBuy(game: Game, playerId: number, resId: number): boolean {
  const rates = marketRates(game);
  const rate = rates[resId];
  const p = game.players[playerId];
  if (rate === undefined) return false;
  const cost = Math.round(rate * (1 + fee(game, playerId)));
  if (p.resources[RES.GOLD] < cost) return false;
  p.resources[RES.GOLD] -= cost;
  p.resources[resId] += 100;
  rates[resId] = Math.min(9999, rate + 2);
  return true;
}

export function sendTribute(game: Game, from: number, to: number, resId: number, amount: number): boolean {
  const p = game.players[from];
  const q = game.players[to];
  if (!p || !q) return false;
  const cost = amount * (1 + (p.resources[RES.TRIBUTE_INEFFICIENCY] ?? 0.3));
  if (p.resources[resId] < cost) return false;
  p.resources[resId] -= cost;
  q.resources[resId] += amount;
  return true;
}

/** Trade-route distance: euclidean between centers, 5-tile deadzone per axis. */
export function tradeDistance(a: Entity, b: Entity): number {
  const dx = Math.max(0, Math.abs(a.x - b.x) - 5);
  const dy = Math.max(0, Math.abs(a.y - b.y) - 5);
  return Math.max(0.1, Math.hypot(dx, dy));
}

export function tradeGoldPerTrip(game: Game, cart: Entity, home: Entity, foreign: Entity): number {
  const def = game.players[cart.owner].getType(cart.typeId)!;
  const wr = def.bird?.work_rate ?? 0.2875;
  const speed = def.speed ?? 1.25;
  const d = tradeDistance(home, foreign);
  const mapSize = game.map.w;
  return ((2 * wr) / speed) * d * (d / mapSize + 0.3);
}

function nearestOwnMarket(game: Game, cart: Entity): Entity | null {
  const p = game.players[cart.owner];
  const fam = game.familyOf(MARKET, p);
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of game.entities.values()) {
    if (e.owner !== cart.owner || e.state === "foundation" || !fam.has(e.typeId)) continue;
    const d = Math.hypot(e.x - cart.x, e.y - cart.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function stepTrade(game: Game, dt: number): void {
  for (const e of game.entities.values()) {
    const order = e.orders[0];
    if (!order || order.kind !== "trade") continue;
    const foreign = order.targetId !== undefined ? game.entities.get(order.targetId) : undefined;
    if (!foreign || foreign.owner === e.owner || foreign.state === "foundation") {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    const def = game.defOf(e);
    const speed = def.speed ?? 1.25;
    // timer flags the leg: 0 = heading foreign, 1 = loaded, heading home
    const dest = e.timer === 0 ? foreign : nearestOwnMarket(game, e);
    if (!dest) {
      e.orders.shift();
      e.state = "idle";
      continue;
    }
    const dDef = game.defOf(dest);
    const reach = Math.max(dDef.radius[0], dDef.radius[1]) + Math.max(def.radius[0], def.radius[1]) + 0.4;
    if (Math.hypot(dest.x - e.x, dest.y - e.y) > reach) {
      if (e.path.length === 0) e.path = findPath(game, e, dest.x, dest.y);
      followPath(game, e, speed, dt);
      e.state = "moving";
      continue;
    }
    e.path = [];
    if (e.timer === 0) {
      e.timer = 1; // loaded with goods
    } else {
      const home = dest;
      game.players[e.owner].resources[RES.GOLD] += tradeGoldPerTrip(game, e, home, foreign);
      e.timer = 0;
    }
  }
}
