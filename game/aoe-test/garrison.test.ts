/**
 * Garrison benchmarks: entry masks, defensive fire scaling, garrison healing
 * rates, death inside buildings, ungarrison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { UNIT } from "../src/aoe/data/registry.ts";

const CASTLE = 82;
const KNIGHT = 38;

async function g(seed = 3) {
  const game = makeGame(await data(), {
    seed,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  return game;
}

test("entry masks: villagers into TCs, cavalry only into castles", async () => {
  const game = await g();
  const tc = game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const castle = game.spawn(0, CASTLE, 44, 30);
  const vill = game.spawn(0, UNIT.VILLAGER_M, 33, 30);
  const knight = game.spawn(0, KNIGHT, 34, 30);
  game.order(0, [vill.id], { kind: "garrison", targetId: tc.id });
  game.order(0, [knight.id], { kind: "garrison", targetId: tc.id });
  game.run(8);
  assert.equal(vill.state, "garrisoned", "villager inside the TC");
  assert.notEqual(knight.state, "garrisoned", "knight rejected by the TC");
  game.order(0, [knight.id], { kind: "garrison", targetId: castle.id });
  game.run(12);
  assert.equal(knight.state, "garrisoned", "knight welcome in the castle");
  assert.equal(castle.garrisoned.length, 1);
});

test("TC fire: 1 arrow empty, +1 per garrisoned villager", async () => {
  const game = await g(5);
  const tc = game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const dummy = game.spawn(1, KNIGHT, 34.5, 30); // in TC range, tanky
  dummy.orders = [{ kind: "stop" }]; // occupy order slot so auto-engage leaves it dumb

  const countVolley = () => {
    // run until projectiles appear, count them, then let them land
    for (let i = 0; i < 200; i++) {
      game.tick();
      let n = 0;
      for (const e of game.entities.values()) if (e.state === "projectile") n++;
      if (n > 0) return n;
    }
    return 0;
  };
  assert.equal(countVolley(), 1, "empty TC fires a single arrow");
  for (let i = 0; i < 5; i++) {
    const v = game.spawn(0, UNIT.VILLAGER_M, 31.5, 31.5);
    game.order(0, [v.id], { kind: "garrison", targetId: tc.id });
  }
  game.run(6);
  assert.equal(tc.garrisoned.length, 5);
  // wait out the current reload, then count a fresh volley
  game.run(2.2);
  assert.equal(countVolley(), 6, "five villagers add five arrows");
});

test("garrison healing: castle 0.2 hp/s, x6 with Herbal Medicine", async () => {
  const game = await g(7);
  const castle = game.spawn(0, CASTLE, 30, 30);
  const m = game.spawn(0, UNIT.MILITIA, 33.5, 30);
  m.hp = 20;
  game.order(0, [m.id], { kind: "garrison", targetId: castle.id });
  game.run(5);
  assert.equal(m.state, "garrisoned");
  const hp0 = m.hp;
  game.run(20);
  assert.ok(Math.abs(m.hp - (hp0 + 4)) < 0.4, `20s at 0.2/s: ${(m.hp - hp0).toFixed(2)} hp, want 4`);
  game.players[0].markResearched(441); // Herbal Medicine
  const hp1 = m.hp;
  game.run(10);
  assert.ok(Math.abs(m.hp - (hp1 + 12)) < 0.8, `10s at 1.2/s: ${(m.hp - hp1).toFixed(2)} hp, want 12`);
});

test("a destroyed building kills everyone inside", async () => {
  const game = await g(9);
  const tc = game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const v1 = game.spawn(0, UNIT.VILLAGER_M, 32.5, 30);
  const v2 = game.spawn(0, UNIT.VILLAGER_M, 32.5, 31);
  game.order(0, [v1.id], { kind: "garrison", targetId: tc.id });
  game.order(0, [v2.id], { kind: "garrison", targetId: tc.id });
  game.run(6);
  assert.equal(tc.garrisoned.length, 2);
  const popBefore = game.popUsed[0];
  game.kill(tc);
  assert.ok(!game.entities.has(v1.id) && !game.entities.has(v2.id), "villagers died inside");
  assert.equal(game.popUsed[0], popBefore - 2, "population freed");
});

test("ungarrison puts units back on the map; rams speed up when loaded", async () => {
  const game = await g(11);
  const tc = game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const v = game.spawn(0, UNIT.VILLAGER_M, 32.5, 30);
  game.order(0, [v.id], { kind: "garrison", targetId: tc.id });
  game.run(6);
  assert.equal(v.state, "garrisoned");
  game.order(0, [tc.id], { kind: "ungarrison" });
  game.run(1);
  assert.equal(v.state, "idle");
  assert.equal(tc.garrisoned.length, 0);

  const ram = game.spawn(0, 35, 40, 40);
  const m1 = game.spawn(0, UNIT.MILITIA, 41.5, 40);
  const m2 = game.spawn(0, UNIT.MILITIA, 41.5, 41);
  game.order(0, [m1.id], { kind: "garrison", targetId: ram.id });
  game.order(0, [m2.id], { kind: "garrison", targetId: ram.id });
  game.run(5);
  assert.equal(ram.garrisoned.length, 2, "infantry rides the ram");
  // loaded ram speed: base x (1 + 0.05*2)
  const t0x = ram.x;
  game.order(0, [ram.id], { kind: "move", x: 48, y: 40 });
  game.run(4);
  const moved = ram.x - t0x;
  const base = game.players[0].getType(35)!.speed!;
  assert.ok(Math.abs(moved - base * 1.1 * 4) < 0.4, `loaded ram moved ${moved.toFixed(2)} in 4s`);
});
