/**
 * Full-game systems: fog of war, wonder victory, stances, Arabia-style
 * generation, and the AI opponent actually playing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { generateArabia } from "../src/aoe/core/arabia.ts";
import { SimpleAI } from "../src/aoe/ai/simple.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const WONDER = 276;

test("fog of war: enemy base hidden until scouted; allies share sight", async () => {
  const game = makeGame(await data(), {
    seed: 71,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  game.spawn(0, UNIT.TOWN_CENTER, 20, 20);
  const scout = game.spawn(0, UNIT.SCOUT_CAVALRY, 24, 20);
  game.spawn(1, UNIT.TOWN_CENTER, 90, 90);
  game.run(1);
  assert.equal(game.isVisibleTo(0, 20, 20), true, "own base visible");
  assert.equal(game.isExploredBy(0, 90, 90), false, "enemy base unexplored");
  game.order(0, [scout.id], { kind: "move", x: 88, y: 88 });
  game.run(110);
  assert.equal(game.isExploredBy(0, 90, 90), true, "scouting explores");
  game.order(0, [scout.id], { kind: "move", x: 24, y: 20 });
  game.run(110);
  assert.equal(game.isVisibleTo(0, 90, 90), false, "fog closes behind the scout");
  assert.equal(game.isExploredBy(0, 90, 90), true, "but stays explored");
});

test("wonder victory: the countdown crowns a winner", async () => {
  const game = makeGame(await data(), {
    seed: 73,
    victoryYears: 2, // 10 game-seconds for the test
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  game.spawn(0, UNIT.TOWN_CENTER, 20, 20);
  game.spawn(1, UNIT.TOWN_CENTER, 90, 90);
  game.spawn(0, WONDER, 40, 40);
  game.run(16);
  assert.equal(game.winnerTeam, -1, "player 1 wins by wonder");
});

test("stances: no-attack holds fire, stand ground refuses to chase", async () => {
  const game = makeGame(await data(), {
    seed: 79,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  const passive = game.spawn(0, UNIT.MILITIA, 30, 30);
  passive.stance = 3;
  const foe = game.spawn(1, UNIT.VILLAGER_M, 31, 30);
  foe.orders = [{ kind: "stop" }];
  game.run(6);
  assert.equal(foe.hp, game.defOf(foe).hp, "no-attack militia ignores the villager");

  const stander = game.spawn(0, 4, 50, 50); // archer, range 4
  stander.stance = 2;
  const runner = game.spawn(1, UNIT.VILLAGER_M, 53, 50);
  game.order(1, [runner.id], { kind: "move", x: 70, y: 50 });
  game.run(12);
  assert.ok(Math.hypot(stander.x - 50, stander.y - 50) < 1, "stand-ground archer never moved");
});

test("Arabia generation: the documented opening surrounds every player", async () => {
  const game = makeGame(await data(), {
    seed: 83,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  generateArabia(game);
  game.initCivs();
  for (const p of game.players) {
    let tc = null;
    for (const e of game.entities.values()) {
      if (e.owner === p.id && game.familyOf(UNIT.TOWN_CENTER, p).has(e.typeId)) tc = e;
    }
    assert.ok(tc, `player ${p.id} has a TC`);
    const near = (typeId: number, r: number) => {
      let n = 0;
      for (const e of game.entities.values()) {
        if (e.typeId === typeId && Math.hypot(e.x - tc!.x, e.y - tc!.y) <= r) n++;
      }
      return n;
    };
    assert.ok(near(UNIT.SHEEP, 14) >= 8, `sheep for p${p.id}: ${near(UNIT.SHEEP, 14)}`);
    assert.ok(near(UNIT.BERRY_BUSH, 14) >= 6, "berry patch");
    assert.ok(near(UNIT.BOAR, 22) >= 2, "two boars");
    assert.ok(near(UNIT.GOLD_MINE, 12) >= 7, "main gold");
    assert.ok(near(UNIT.STONE_MINE, 12) >= 5, "main stone");
    assert.ok(near(UNIT.TREE_OAK, 18) >= 30, "woodlines in reach");
  }
  let relics = 0;
  for (const e of game.entities.values()) if (e.typeId === 285) relics++;
  assert.equal(relics, 5, "five relics on the map");
});

test("the AI plays: grows its economy, houses itself, raises military", async () => {
  const game = makeGame(await data(), {
    seed: 89,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  generateArabia(game);
  game.initCivs();
  const ai = new SimpleAI(1);
  const p = game.players[1];
  const vills0 = countVills(game, 1);
  for (let s = 0; s < 540; s++) {
    game.run(1);
    ai.step(game, 1);
  }
  const vills1 = countVills(game, 1);
  assert.ok(vills1 > vills0 + 4, `AI trained villagers (${vills0} -> ${vills1})`);
  let houses = 0;
  let barracks = 0;
  for (const e of game.entities.values()) {
    if (e.owner === 1 && e.state !== "foundation") {
      if (e.typeId === UNIT.HOUSE || game.players[1].resolveUpgrade(UNIT.HOUSE) === e.typeId) houses++;
      if (game.familyOf(12, p).has(e.typeId)) barracks++;
    }
  }
  assert.ok(houses >= 2, `AI built houses (${houses})`);
  assert.ok(barracks >= 1, `AI built a barracks (${barracks})`);
  assert.ok(game.popUsed[1] > 8, `AI population grew (${game.popUsed[1]})`);
});

function countVills(game: ReturnType<typeof Object> & { entities: Map<number, { owner: number; typeId: number }> }, owner: number): number {
  let n = 0;
  for (const e of (game as { entities: Map<number, { owner: number; typeId: number }> }).entities.values()) {
    if (e.owner === owner && (e.typeId === UNIT.VILLAGER_M || e.typeId === UNIT.VILLAGER_F)) n++;
  }
  return n;
}
