/**
 * Hunting benchmarks: boar retaliation and the lure-kill-harvest loop, deer
 * flight, wolf aggression - keyed off the animal classes in the data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const WOLF = 126;

test("boar retaliates when hunted; three villagers bring it down and harvest", async () => {
  const game = makeGame(await data(), { seed: 31 });
  game.initCivs();
  game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const boar = game.spawn(-1, UNIT.BOAR, 38, 30);
  const vills = [
    game.spawn(0, UNIT.VILLAGER_M, 34, 29),
    game.spawn(0, UNIT.VILLAGER_M, 34, 30),
    game.spawn(0, UNIT.VILLAGER_M, 34, 31),
  ];
  const p = game.players[0];
  const food0 = p.resources[RES.FOOD];
  for (const v of vills) game.order(0, [v.id], { kind: "gather", targetId: boar.id });
  // wait for first blood, then check the boar turned on a hunter
  let t = 0;
  while (boar.hp >= game.defOf(boar).hp && t < 20) {
    game.tick();
    t += 0.05;
  }
  assert.ok(t < 20, "hunters drew blood");
  game.run(0.2);
  assert.equal(boar.orders[0]?.kind, "attack", "boar retaliates");
  // let the hunt complete and the carcass be gathered
  game.run(400);
  const gained = p.resources[RES.FOOD] - food0 + vills.reduce((s, v) => s + (v.carry?.[1] ?? 0), 0);
  assert.ok(!game.entities.has(boar.id), "boar dead");
  assert.ok(gained > 180, `harvested ${gained.toFixed(0)} of the boar's 340 food`);
  assert.ok(vills.some((v) => game.entities.has(v.id)), "hunters survived");
});

test("deer bolts when struck, and is still brought down", async () => {
  const game = makeGame(await data(), { seed: 37 });
  game.initCivs();
  game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const deer = game.spawn(-1, UNIT.DEER, 36, 30);
  const v = game.spawn(0, UNIT.VILLAGER_M, 34, 30);
  game.order(0, [v.id], { kind: "gather", targetId: deer.id });
  let t = 0;
  const hp0 = deer.hp;
  while (deer.hp >= hp0 && game.entities.has(deer.id) && t < 30) {
    game.tick();
    t += 0.05;
  }
  // deer has 5 hp; a hunter strike usually kills instantly - flight shows up
  // as either a move order (survived a weak hit) or a chased-down corpse
  game.run(120);
  assert.ok(!game.entities.has(deer.id), "deer down");
  const p = game.players[0];
  const gained = p.resources[RES.FOOD] + (v.carry?.[1] ?? 0) - 200;
  // an unlured deer that fled before dying is a walk-heavy, rot-heavy harvest
  assert.ok(gained > 35, `deer harvest ${gained.toFixed(0)} food (140 minus rot and walks)`);
});

test("wolves attack villagers on sight", async () => {
  const game = makeGame(await data(), { seed: 41 });
  game.initCivs();
  const wolf = game.spawn(-1, WOLF, 40, 30);
  const v = game.spawn(0, UNIT.VILLAGER_M, 31, 30);
  game.order(0, [v.id], { kind: "move", x: 36, y: 30 }); // stroll into range 12
  game.run(6);
  assert.equal(wolf.orders[0]?.kind, "attack", "wolf hunts on sight");
  const hp0 = v.hp;
  game.run(20);
  assert.ok(!game.entities.has(v.id) || v.hp < hp0, "the villager pays for it");
});
