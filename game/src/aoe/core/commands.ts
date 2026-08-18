/**
 * The serializable command layer: every player action expressed as data, so a
 * game is exactly its config plus its command stream. This is what makes
 * saves, replays, and lockstep multiplayer possible - two simulations fed the
 * same stream stay bit-identical (see the determinism test).
 */

import type { Game } from "./game.ts";
import type { Order } from "./entity.ts";
import { marketBuy, marketSell, sendTribute } from "../systems/market.ts";

export type Command =
  | { t: "order"; ids: number[]; order: Order; queue?: boolean; formation?: "line" | "box" | "staggered" | "flank" }
  | { t: "stop"; ids: number[] }
  | { t: "rally"; id: number; x: number; y: number; targetId?: number }
  | { t: "train"; building: number; unit: number }
  | { t: "research"; building: number; tech: number }
  | { t: "place"; unit: number; x: number; y: number; builders?: number[] }
  | { t: "buy"; res: number }
  | { t: "sell"; res: number }
  | { t: "tribute"; to: number; res: number; amount: number }
  | { t: "stance"; ids: number[]; stance: number }
  | { t: "lock"; id: number; on: boolean }
  | { t: "reseed"; on: boolean };

export function applyCommand(game: Game, playerId: number, cmd: Command): void {
  switch (cmd.t) {
    case "order":
      game.order(playerId, cmd.ids, cmd.order, cmd.queue ?? false, cmd.formation ?? "line");
      return;
    case "stop":
      for (const id of cmd.ids) {
        const e = game.entities.get(id);
        if (e && e.owner === playerId && e.state !== "garrisoned" && e.state !== "foundation") {
          e.orders = [];
          e.path = [];
          e.state = "idle";
        }
      }
      return;
    case "rally": {
      const b = game.entities.get(cmd.id);
      if (b && b.owner === playerId) {
        b.rallyX = cmd.x;
        b.rallyY = cmd.y;
        b.targetId = cmd.targetId ?? 0;
      }
      return;
    }
    case "train":
      game.trainUnit(playerId, cmd.building, cmd.unit);
      return;
    case "research":
      game.researchTech(playerId, cmd.building, cmd.tech);
      return;
    case "place": {
      const f = game.placeFoundation(playerId, cmd.unit, cmd.x, cmd.y);
      if (f && cmd.builders?.length) {
        game.order(playerId, cmd.builders, { kind: "build", targetId: f.id });
      }
      return;
    }
    case "buy":
      marketBuy(game, playerId, cmd.res);
      return;
    case "sell":
      marketSell(game, playerId, cmd.res);
      return;
    case "tribute":
      sendTribute(game, playerId, cmd.to, cmd.res, cmd.amount);
      return;
    case "stance":
      for (const id of cmd.ids) {
        const e = game.entities.get(id);
        if (e && e.owner === playerId) e.stance = cmd.stance;
      }
      return;
    case "lock": {
      const e = game.entities.get(cmd.id);
      if (e && e.owner === playerId) e.locked = cmd.on;
      return;
    }
    case "reseed":
      game.autoReseed[playerId] = cmd.on;
      return;
  }
}

/** Order-independent-ish state digest for determinism checks (FNV-1a). */
export function stateHash(game: Game): number {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 0x01000193);
  };
  mix(game.tickCount);
  for (const p of game.players) {
    for (const r of [0, 1, 2, 3, 4, 6, 11]) mix(Math.round(p.resources[r] * 16));
    mix(p.researched.size);
  }
  const ids = [...game.entities.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const e = game.entities.get(id)!;
    mix(id);
    mix(e.typeId);
    mix(e.owner + 2);
    mix(Math.round(e.x * 64));
    mix(Math.round(e.y * 64));
    mix(Math.round(e.hp * 16));
  }
  return h >>> 0;
}
