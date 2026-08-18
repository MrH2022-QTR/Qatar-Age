/**
 * Naval and siege completeness: water domains, docks on the shore, fishing at
 * the dat rates, ship combat, trebuchet pack/unpack at 50/work_rate,
 * attack-ground bombardment, and farm auto-reseed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { findPath } from "../src/aoe/systems/movement.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const FISHING_SHIP = 13;
const DOCK = 45;
const GALLEY = 539;
const DEEP_FISH = 53;
const TREB_PACKED = 331;
const TREB_UNPACKED = 42;
const MANGONEL = 280;

function waterGame(d: Awaited<ReturnType<typeof data>>, seed = 91) {
  const game = makeGame(d, {
    seed,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  // east half water
  for (let y = 0; y < game.map.h; y++) {
    for (let x = 60; x < game.map.w; x++) game.map.terrain[y * game.map.w + x] = 1;
  }
  game.initCivs();
  return game;
}

test("domains: knights stay off the water, galleys stay on it", async () => {
  const game = waterGame(await data());
  const knight = game.spawn(0, 38, 50, 50);
  const galley = game.spawn(0, GALLEY, 70, 50);
  assert.equal(findPath(game, knight, 80, 50).length, 0, "knight cannot path into the sea");
  assert.equal(findPath(game, galley, 40, 50).length, 0, "galley cannot path onto land");
  assert.ok(findPath(game, galley, 90, 70).length > 0, "galley sails freely");
});

test("dock sits on the shoreline; fishing ship works deep fish at 0.42/s to the dock", async () => {
  const game = waterGame(await data(), 93);
  const p = game.players[0];
  game.spawn(0, UNIT.VILLAGER_M, 58, 50);
  assert.equal(game.placeFoundation(0, DOCK, 50, 50), null, "no dock on dry land");
  assert.equal(game.placeFoundation(0, DOCK, 80, 50), null, "no dock in open sea");
  const dock = game.placeFoundation(0, DOCK, 61, 50);
  assert.ok(dock, "dock on the shoreline");
  dock!.state = "idle";
  dock!.buildLeft = 0;
  game.onBuildingComplete(dock!, game.defOf(dock!));

  const ship = game.spawn(0, FISHING_SHIP, 64, 52);
  const fish = game.spawn(-1, DEEP_FISH, 66, 54);
  assert.equal(fish.resAmount, 200, "deep fish holds 200 food");
  const food0 = p.resources[RES.FOOD];
  game.order(0, [ship.id], { kind: "gather", targetId: fish.id });
  game.run(120);
  const gained = p.resources[RES.FOOD] - food0 + (ship.carry?.[1] ?? 0);
  // 0.24 x 1.75 = 0.42/s gross, short hops to the dock
  assert.ok(gained > 35 && gained < 52, `120s of fishing gained ${gained.toFixed(1)}`);
});

test("war galleys sink fishing ships", async () => {
  const game = waterGame(await data(), 97);
  const galley = game.spawn(0, 21, 70, 50); // war galley
  const prey = game.spawn(1, FISHING_SHIP, 74, 50);
  game.order(0, [galley.id], { kind: "attack", targetId: prey.id });
  game.run(40);
  assert.ok(!game.entities.has(prey.id), "fishing ship sunk");
});

test("trebuchet: unpacks in 11.1s to fire at range 16, packs to move", async () => {
  const d = await data();
  const game = makeGame(d, {
    seed: 101,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  const treb = game.spawn(0, TREB_PACKED, 30, 30);
  const house = game.spawn(1, UNIT.HOUSE, 44, 30); // 14 tiles: inside range 16
  game.order(0, [treb.id], { kind: "attack", targetId: house.id });
  game.run(2);
  assert.equal(treb.state, "transforming", "unpacking");
  game.run(8);
  assert.equal(treb.typeId, TREB_PACKED, "still packed at 10s");
  game.run(2);
  assert.equal(treb.typeId, TREB_UNPACKED, "unpacked at ~11.1s");
  const hp0 = house.hp;
  game.run(15);
  assert.ok(house.hp < hp0 || !game.entities.has(house.id), "stones are landing");
  // now order it away: it must pack first
  game.order(0, [treb.id], { kind: "move", x: 20, y: 30 });
  game.run(2);
  assert.equal(treb.state, "transforming", "packing to move");
  game.run(10);
  assert.equal(treb.typeId, TREB_PACKED, "packed again");
  game.run(6);
  assert.ok(treb.x < 28, "rolling away");
});

test("Kataparuto packs trebuchets four times faster", async () => {
  const d = await data();
  const game = makeGame(d, { seed: 103, players: [{ civId: 5, team: 0 }] }); // Japanese
  game.initCivs();
  const p = game.players[0];
  p.markResearched(59); // Kataparuto
  const treb = game.spawn(0, TREB_UNPACKED, 30, 30);
  game.order(0, [treb.id], { kind: "move", x: 40, y: 30 });
  game.run(1);
  assert.equal(treb.state, "transforming");
  game.run(2.2); // 50 / (4.5 x 4) = 2.78s
  assert.equal(treb.typeId, TREB_PACKED, "packed in ~2.8s with Kataparuto");
});

test("attack ground: the mangonel bombards a tile, not a unit", async () => {
  const game = makeGame(await data(), {
    seed: 107,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  const mang = game.spawn(0, MANGONEL, 30, 30);
  const a = game.spawn(1, UNIT.MILITIA, 36, 30);
  const b = game.spawn(1, UNIT.MILITIA, 36.6, 30.4);
  a.orders = [{ kind: "stop" }];
  b.orders = [{ kind: "stop" }];
  game.order(0, [mang.id], { kind: "attack_ground", x: 36.3, y: 30.2 });
  game.run(6);
  const aHurt = !game.entities.has(a.id) || a.hp < game.defOf(a).hp;
  const bHurt = !game.entities.has(b.id) || b.hp < game.defOf(b).hp;
  assert.ok(aHurt && bHurt, "both militia caught in the blast on the ground point");
});

test("farms auto-reseed: the farmer replants and keeps farming", async () => {
  const d = await data();
  const game = makeGame(d, { seed: 109, startingResources: { food: 0, wood: 500, gold: 0, stone: 0 } });
  game.initCivs();
  const p = game.players[0];
  p.resources[36] = 25; // tiny farms so the cycle is quick
  game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  game.spawn(0, UNIT.MILL, 26, 26);
  const v = game.spawn(0, UNIT.VILLAGER_M, 33, 30);
  const farm = game.placeFoundation(0, UNIT.FARM, 35, 30)!;
  const woodAfterFirst = p.resources[RES.WOOD];
  game.order(0, [v.id], { kind: "build", targetId: farm.id });
  game.run(20);
  game.order(0, [v.id], { kind: "gather", targetId: farm.id });
  game.run(140);
  assert.ok(!game.entities.has(farm.id), "first farm expired");
  let farms = 0;
  for (const e of game.entities.values()) if (e.owner === 0 && e.typeId === UNIT.FARM) farms++;
  assert.ok(farms >= 1, "a replacement farm exists");
  assert.ok(p.resources[RES.WOOD] < woodAfterFirst, "the reseed paid its wood");
  assert.ok(v.orders.length > 0 || v.state === "gathering" || v.state === "building" || v.state === "returning", "farmer still working");
});
