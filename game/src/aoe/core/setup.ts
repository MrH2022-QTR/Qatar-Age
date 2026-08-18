/**
 * Scenario construction. `standardStart` reproduces AoE2's standard opening for
 * one player: Town Center + 3 villagers + Scout Cavalry, 200f 200w 100g 200s
 * (civ effects then adjust - Chinese get their extra villagers and resource
 * deltas from their own tech-tree effect bundle, exactly as shipped).
 * Tests can also place individual entities for exact micro-scenarios.
 */

import { Game, type GameConfig } from "./game.ts";
import type { GameData } from "../data/registry.ts";
import { UNIT } from "../data/registry.ts";

export interface StartSpot {
  x: number;
  y: number;
}

export function makeGame(data: GameData, cfg?: Partial<GameConfig>): Game {
  const config: GameConfig = {
    mapW: cfg?.mapW ?? 120,
    mapH: cfg?.mapH ?? 120,
    seed: cfg?.seed ?? 42,
    players: cfg?.players ?? [{ civId: 1, team: 0 }],
    popCap: cfg?.popCap ?? 200,
    startingResources: cfg?.startingResources,
    victoryYears: cfg?.victoryYears,
  };
  return new Game(data, config);
}

/** Place TC + 3 villagers + scout for a player. Returns the placed entity ids. */
export function standardStart(game: Game, playerId: number, at: StartSpot) {
  const tc = game.spawn(playerId, UNIT.TOWN_CENTER, at.x, at.y);
  const vills = [
    game.spawn(playerId, UNIT.VILLAGER_M, at.x - 3, at.y + 1),
    game.spawn(playerId, UNIT.VILLAGER_M, at.x - 3, at.y + 2),
    game.spawn(playerId, UNIT.VILLAGER_M, at.x + 3, at.y + 1),
  ];
  const scout = game.spawn(playerId, UNIT.SCOUT_CAVALRY, at.x, at.y + 5);
  return { tc, vills, scout };
}

/** Sprinkle a standard-ish resource opening around a start (distances in tiles). */
export function standardResources(game: Game, at: StartSpot) {
  const sheep: number[] = [];
  for (let i = 0; i < 4; i++) {
    sheep.push(game.spawn(-1, UNIT.SHEEP, at.x + 2 + i * 0.7, at.y + 4).id);
  }
  const berries: number[] = [];
  for (let i = 0; i < 6; i++) {
    berries.push(game.spawn(-1, UNIT.BERRY_BUSH, at.x - 10 + (i % 3), at.y + 8 + Math.floor(i / 3)).id);
  }
  const gold: number[] = [];
  for (let i = 0; i < 7; i++) {
    gold.push(game.spawn(-1, UNIT.GOLD_MINE, at.x + 12 + (i % 3), at.y - 6 + Math.floor(i / 3)).id);
  }
  const stone: number[] = [];
  for (let i = 0; i < 5; i++) {
    stone.push(game.spawn(-1, UNIT.STONE_MINE, at.x - 14 + (i % 3), at.y - 10 + Math.floor(i / 3)).id);
  }
  const trees: number[] = [];
  for (let tx = -20; tx <= 20; tx += 2) {
    for (let ty = 14; ty <= 20; ty += 2) {
      trees.push(game.spawn(-1, UNIT.TREE_OAK, at.x + tx, at.y + ty).id);
    }
  }
  const boar = [game.spawn(-1, UNIT.BOAR, at.x + 16, at.y + 12).id];
  return { sheep, berries, gold, stone, trees, boar };
}
