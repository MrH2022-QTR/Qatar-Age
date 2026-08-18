/**
 * Economy benchmarks against wiki-documented behavior: exact walk speed, the
 * 3T/(n+2) construction law, housed training, gather rates, age-up flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { approx, data } from "./helpers.ts";
import { makeGame, standardStart } from "../src/aoe/core/setup.ts";
import { UNIT, TECH, RES } from "../src/aoe/data/registry.ts";

const BRITONS = 1;

test("villager walks at exactly 0.8 tiles per second", async () => {
  const game = makeGame(await data());
  game.initCivs();
  const v = game.spawn(0, UNIT.VILLAGER_M, 20, 20);
  game.order(0, [v.id], { kind: "move", x: 28, y: 20 });
  let t = 0;
  while (v.orders.length > 0 && t < 20) {
    game.tick();
    t += 0.05;
  }
  approx(t, 8 / 0.8, 0.2, "walk time for 8 tiles");
});

test("house: 25 wood, 25s alone, 3T/(n+2) with two builders, +5 pop", async () => {
  const d = await data();
  {
    const game = makeGame(d);
    game.initCivs();
    const v = game.spawn(0, UNIT.VILLAGER_M, 20, 20);
    const wood0 = game.players[0].resources[RES.WOOD];
    const house = game.placeFoundation(0, UNIT.HOUSE, 24, 20)!;
    assert.ok(house, "foundation placed");
    assert.equal(wood0 - game.players[0].resources[RES.WOOD], 25);
    game.order(0, [v.id], { kind: "build", targetId: house.id });
    let t = 0;
    while (house.state === "foundation" && t < 60) {
      game.tick();
      t += 0.05;
    }
    // walk time ~3.2 tiles is part of t; construction itself must be 25s
    const walk = 3.15 / 0.8;
    approx(t - walk, 25, 0.8, "solo house build seconds");
    assert.equal(game.popHeadroom[0], 5);
  }
  {
    const game = makeGame(d);
    game.initCivs();
    const v1 = game.spawn(0, UNIT.VILLAGER_M, 23.2, 20);
    const v2 = game.spawn(0, UNIT.VILLAGER_M, 24.8, 20);
    const house = game.placeFoundation(0, UNIT.HOUSE, 24, 20)!;
    game.order(0, [v1.id], { kind: "build", targetId: house.id });
    game.order(0, [v2.id], { kind: "build", targetId: house.id });
    let t = 0;
    while (house.state === "foundation" && t < 60) {
      game.tick();
      t += 0.05;
    }
    approx(t, (3 * 25) / (2 + 2), 0.6, "two-builder house = 18.75s");
  }
});

test("TC trains villagers in 25s for 50 food; housed blocks the queue", async () => {
  const game = makeGame(await data());
  game.initCivs();
  const { tc } = standardStart(game, 0, { x: 30, y: 30 }); // pop 4/5
  const p = game.players[0];
  const food0 = p.resources[RES.FOOD];
  assert.ok(game.trainUnit(0, tc.id, UNIT.VILLAGER_M));
  assert.equal(food0 - p.resources[RES.FOOD], 50);
  assert.ok(game.trainUnit(0, tc.id, UNIT.VILLAGER_M)); // queued but will be housed
  game.run(25.2);
  assert.equal(game.popUsed[0], 5, "first villager out at 25s");
  game.run(30);
  assert.equal(game.popUsed[0], 5, "second villager housed at 5/5");
  // drop a house instantly via direct spawn to unblock
  game.spawn(0, UNIT.HOUSE, 36, 30);
  game.run(25.2);
  assert.equal(game.popUsed[0], 6, "house unblocks the queue");
});

test("shepherding: one villager on one sheep nets food at the documented rate", async () => {
  // Franks: no shepherding bonus, so the raw 0.33/s shows through
  const game = makeGame(await data(), { players: [{ civId: 2, team: 0 }] });
  game.initCivs();
  const { tc } = standardStart(game, 0, { x: 30, y: 30 });
  const sheep = game.spawn(-1, UNIT.SHEEP, 33, 30.5);
  const v = game.spawn(0, UNIT.VILLAGER_M, 32, 30);
  const p = game.players[0];
  const food0 = p.resources[RES.FOOD];
  game.order(0, [v.id], { kind: "gather", targetId: sheep.id });
  game.run(90);
  const gained = p.resources[RES.FOOD] - food0 + (v.carry?.[1] ?? 0);
  // 0.33/s pure gather, minus kill time, deposit walks and corpse rot:
  // must land in a believable band around ~0.30/s effective
  assert.ok(gained > 20 && gained < 31, `90s shepherding gained ${gained.toFixed(1)} food`);
});

test("two dark-age buildings gate Feudal; age-up transforms the TC and takes 130s", async () => {
  const game = makeGame(await data(), { startingResources: { food: 800, wood: 800, gold: 100, stone: 200 } });
  game.initCivs();
  const { tc } = standardStart(game, 0, { x: 30, y: 30 });
  const p = game.players[0];
  assert.equal(p.canResearch(TECH.FEUDAL_AGE), false, "feudal locked at start");
  game.spawn(0, UNIT.BARRACKS, 40, 30);
  assert.equal(p.canResearch(TECH.FEUDAL_AGE), false, "one building is not enough");
  game.spawn(0, UNIT.MILL, 40, 40);
  assert.equal(p.canResearch(TECH.FEUDAL_AGE), true, "two dark-age buildings unlock feudal");
  const food0 = p.resources[RES.FOOD];
  assert.ok(game.researchTech(0, tc.id, TECH.FEUDAL_AGE));
  assert.equal(food0 - p.resources[RES.FOOD], 500);
  game.run(129);
  assert.equal(p.currentAge(), 0, "still dark age before 130s");
  game.run(2);
  assert.equal(p.currentAge(), 1, "feudal at 130s");
  assert.equal(tc.typeId, 71, "TC transformed to its feudal variant");
});

test("Chinese start with extra villagers from their tech-tree effect", async () => {
  const game = makeGame(await data(), { players: [{ civId: 6, team: 0 }] });
  const { tc } = standardStart(game, 0, { x: 30, y: 30 });
  game.initCivs(); // civ effects spawn the bonus villagers at the TC
  let vills = 0;
  for (const e of game.entities.values()) {
    if (e.owner === 0 && (e.typeId === UNIT.VILLAGER_M || e.typeId === UNIT.VILLAGER_F)) vills++;
  }
  assert.equal(vills, 6, "Chinese: 3 base + 3 bonus villagers");
});
