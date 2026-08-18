/**
 * Combat benchmarks: the damage matrix must reproduce wiki-documented numbers
 * exactly, projectiles must kill on the documented timeline, and line upgrades
 * must transform live units.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { computeDamage } from "../src/aoe/systems/damage.ts";
import { UNIT } from "../src/aoe/data/registry.ts";

const BRITONS = 1;

async function playerTable() {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }, { civId: 2, team: 0 }] });
  game.initCivs();
  return game;
}

test("damage matrix: spearman hits knight for 16 (1 base + 15 anti-cavalry)", async () => {
  const game = await playerTable();
  const p = game.players[0];
  const spear = p.getType(93)!;
  const knight = p.getType(38)!;
  assert.equal(computeDamage(spear.combat!.attacks, knight), 16);
});

test("damage matrix: skirmisher hits archer for 5, militia for 1", async () => {
  const game = await playerTable();
  const p = game.players[0];
  const skirm = p.getType(7)!;
  assert.equal(computeDamage(skirm.combat!.attacks, p.getType(4)!), 5);
  assert.equal(computeDamage(skirm.combat!.attacks, p.getType(74)!), 1);
});

test("damage matrix: militia hits skirmisher for 4; knight hits militia for 10", async () => {
  const game = await playerTable();
  const p = game.players[0];
  assert.equal(computeDamage(p.getType(74)!.combat!.attacks, p.getType(7)!), 4);
  assert.equal(computeDamage(p.getType(38)!.combat!.attacks, p.getType(74)!), 10);
});

test("damage never drops below 1 (militia punching a castle)", async () => {
  const game = await playerTable();
  const p = game.players[0];
  const militia = p.getType(74)!;
  const castle = p.getType(82)!;
  const dmg = computeDamage(militia.combat!.attacks, castle);
  assert.ok(dmg >= 1, `castle poke ${dmg}`);
});

test("elevation: +25% from above, -25% from below", async () => {
  const game = await playerTable();
  const p = game.players[0];
  const knight = p.getType(38)!;
  const militia = p.getType(74)!;
  assert.equal(computeDamage(knight.combat!.attacks, militia, { elevationFactor: 1.25 }), 12);
  assert.equal(computeDamage(knight.combat!.attacks, militia, { elevationFactor: 0.75 }), 7);
});

test("melee fight runs on reload timing: two militia trade at 2.0s per swing", async () => {
  const game = await playerTable();
  const a = game.spawn(0, UNIT.MILITIA, 30, 30);
  const b = game.spawn(1, UNIT.MILITIA, 30.35, 30); // already in melee reach
  game.order(0, [a.id], { kind: "attack", targetId: b.id });
  // militia: 40 hp, 4 attack vs 0 melee armor -> 4 per swing, 10 swings,
  // first swing immediate, then 9 reloads x 2.0s = 18s
  let t = 0;
  while (game.entities.has(b.id) && t < 40) {
    game.tick();
    t += 0.05;
  }
  assert.ok(game.entities.has(a.id), "attacker survives");
  assert.ok(!game.entities.has(b.id), "defender dies");
  assert.ok(Math.abs(t - 18.05) < 0.3, `kill took ${t.toFixed(2)}s, want ~18.05`);
});

test("archer kills a villager through real projectiles", async () => {
  const game = await playerTable();
  const archer = game.spawn(0, 4, 30, 30);
  const vill = game.spawn(1, UNIT.VILLAGER_M, 33, 30);
  game.order(0, [archer.id], { kind: "attack", targetId: vill.id });
  let t = 0;
  while (game.entities.has(vill.id) && t < 60) {
    game.tick();
    t += 0.05;
  }
  assert.ok(!game.entities.has(vill.id), "villager dies to arrows");
  // 25 hp at 4+3(vs villager class) per hit with 80% accuracy: ~4-6 hits
  assert.ok(t > 4 && t < 30, `took ${t.toFixed(1)}s`);
});

test("Man-at-Arms upgrade transforms live militia", async () => {
  const game = await playerTable();
  const p = game.players[0];
  const m = game.spawn(0, UNIT.MILITIA, 30, 30);
  m.hp -= 10; // 30/40
  p.markResearched(222); // Man-at-Arms upgrade tech
  assert.equal(m.typeId, 75, "live unit transformed");
  const maa = p.getType(75)!;
  assert.equal(m.hp, maa.hp - 10, "damage taken carries over");
  assert.ok(p.resolveUpgrade(UNIT.MILITIA) === 75, "training militia now yields man-at-arms");
});

test("farms yield exactly the farm-food resource, upgrades add to it", async () => {
  const d = await data();
  const game = makeGame(d, { startingResources: { food: 0, wood: 500, gold: 0, stone: 0 } });
  game.initCivs();
  game.autoReseed[0] = false; // this test measures ONE farm's lifetime yield
  const p = game.players[0];
  assert.equal(p.resources[36], 175, "base farm food 175");
  p.markResearched(14); // Horse Collar
  assert.equal(p.resources[36], 250, "Horse Collar makes farms 250");

  game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const v = game.spawn(0, UNIT.VILLAGER_M, 33, 33);
  assert.equal(game.placeFoundation(0, UNIT.FARM, 35, 30), null, "farms need a mill first");
  game.spawn(0, UNIT.MILL, 26, 26); // mill-built shadow tech enables farms
  const farm = game.placeFoundation(0, UNIT.FARM, 35, 30)!; // hugging the TC, as farms do
  assert.ok(farm, "farm placeable once a mill exists");
  game.order(0, [v.id], { kind: "build", targetId: farm.id });
  game.run(20);
  assert.ok(farm.state !== "foundation", "farm built");
  game.order(0, [v.id], { kind: "gather", targetId: farm.id });
  game.run(800);
  const gained = p.resources[0] + (v.carry?.[1] ?? 0);
  assert.ok(Math.abs(gained - 250) < 15, `farm lifetime yielded ${gained.toFixed(1)}, want ~250`);
  assert.ok(!game.entities.has(farm.id), "farm expired when its food ran out");
});
