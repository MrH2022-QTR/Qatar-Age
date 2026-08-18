/**
 * Fish traps and transports: the last naval mechanics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const FISHING_SHIP = 13;
const FISH_TRAP = 199;
const TRANSPORT = 545;

function waterGame(d: Awaited<ReturnType<typeof data>>, seed = 131) {
  const game = makeGame(d, {
    seed,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  for (let y = 0; y < game.map.h; y++) {
    for (let x = 60; x < game.map.w; x++) game.map.terrain[y * game.map.w + x] = 1;
  }
  game.initCivs();
  return game;
}

test("fish traps: built by the fishing ship on water, yield the res-88 pool", async () => {
  const d = await data();
  const game = waterGame(d);
  const p = game.players[0];
  p.resources[88] = 30; // small trap pool so the cycle is testable
  game.autoReseed[0] = false;
  const dock = game.spawn(0, 45, 61, 50);
  const ship = game.spawn(0, FISHING_SHIP, 64, 50);
  // traps are a Feudal Age availability - walk there first
  for (const t of [122, 110, 258, 282]) p.grantBuildingTech(t);
  p.runAutoTechs();
  p.markResearched(101);
  p.runAutoTechs();
  assert.equal(game.placeFoundation(0, FISH_TRAP, 50, 50), null, "no trap on land");
  const trap = game.placeFoundation(0, FISH_TRAP, 66, 51);
  assert.ok(trap, "trap placed on water");
  const wood0 = p.resources[RES.WOOD];
  game.order(0, [ship.id], { kind: "build", targetId: trap!.id });
  let t = 0;
  while (trap!.state === "foundation" && t < 30) {
    game.tick();
    t += 0.05;
  }
  // 40 points at the ship's build rate 3.57 -> (2 + 3.57)/3 = 1.86/s -> ~21.6s
  assert.ok(t > 18 && t < 26, `ship built the trap in ${t.toFixed(1)}s`);
  const food0 = p.resources[RES.FOOD];
  game.order(0, [ship.id], { kind: "gather", targetId: trap!.id });
  game.run(200);
  const gained = p.resources[RES.FOOD] - food0 + (ship.carry?.[1] ?? 0);
  assert.ok(Math.abs(gained - 30) < 3, `trap pool drained: ${gained.toFixed(1)} of 30`);
  assert.ok(!game.entities.has(trap!.id), "trap expired");
});

test("transports: load at the waterline, sail, unload on the far shore", async () => {
  const d = await data();
  const game = waterGame(d, 137);
  // land pocket on the far side of the channel
  for (let y = 40; y < 60; y++) {
    for (let x = 100; x < game.map.w; x++) game.map.terrain[y * game.map.w + x] = 0;
  }
  const transport = game.spawn(0, TRANSPORT, 61, 50);
  const m1 = game.spawn(0, UNIT.MILITIA, 58, 50);
  const m2 = game.spawn(0, UNIT.MILITIA, 58, 51);
  game.order(0, [m1.id], { kind: "garrison", targetId: transport.id });
  game.order(0, [m2.id], { kind: "garrison", targetId: transport.id });
  game.run(10);
  assert.equal(transport.garrisoned.length, 2, "militia aboard");
  game.order(0, [transport.id], { kind: "move", x: 98.5, y: 50 });
  game.run(40);
  assert.ok(transport.x > 90, `transport crossed (${transport.x.toFixed(1)})`);
  game.order(0, [transport.id], { kind: "ungarrison" });
  game.run(2);
  assert.equal(transport.garrisoned.length, 0, "unloaded");
  assert.ok(game.entities.has(m1.id) && m1.state !== "garrisoned", "militia ashore");
  const mDef = game.defOf(m1);
  assert.equal(game.map.terrain[Math.floor(m1.y) * game.map.w + Math.floor(m1.x)], 0, "standing on land");
});
