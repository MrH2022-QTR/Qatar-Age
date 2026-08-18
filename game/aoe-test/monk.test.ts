/**
 * Monk benchmarks: the conversion-interval model, faith economy, resistance
 * techs, stat locking, healing rates, and the relic pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const MONK = 125;
const MONASTERY = 104;
const RELIC = 285;

async function duelGame(seed = 7) {
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

test("conversion lands inside the 5-9 CI window and drains faith", async () => {
  const game = await duelGame();
  const monk = game.spawn(0, MONK, 30, 30);
  const target = game.spawn(1, UNIT.MILITIA, 34, 30); // inside range 9
  game.order(0, [monk.id], { kind: "convert", targetId: target.id });
  let t = 0;
  while (target.owner === 1 && t < 30) {
    game.tick();
    t += 0.05;
  }
  assert.equal(target.owner, 0, "militia converted");
  // window: first roll at CI 5 (6.25s), guaranteed at CI 9 (11.25s)
  assert.ok(t >= 6.2 && t <= 11.6, `converted at ${t.toFixed(2)}s`);
  assert.ok(monk.faith < 1, `faith spent (${monk.faith.toFixed(2)}; recharge may tick once)`);
  // faith recharge: 1.6/s -> full in 62.5s
  game.run(63);
  assert.ok(monk.faith >= 100, `faith recharged (${monk.faith.toFixed(1)})`);
});

test("defender's Faith tech pushes the window out by +4/+4 CIs", async () => {
  const game = await duelGame(11);
  game.players[1].markResearched(45); // Faith on the DEFENDER
  assert.equal(game.players[1].resources[RES.CONV_RESIST_MIN], 4);
  const monk = game.spawn(0, MONK, 30, 30);
  const target = game.spawn(1, UNIT.MILITIA, 34, 30);
  game.order(0, [monk.id], { kind: "convert", targetId: target.id });
  let t = 0;
  while (target.owner === 1 && t < 40) {
    game.tick();
    t += 0.05;
  }
  assert.equal(target.owner, 0);
  assert.ok(t >= 11.2, `with Faith conversion cannot land before 11.25s (got ${t.toFixed(2)})`);
  assert.ok(t <= 16.6, `guaranteed by CI 13 = 16.25s (got ${t.toFixed(2)})`);
});

test("scouts resist: first roll CI 8, halved-ish chance, guaranteed CI 10", async () => {
  // two monks, because a lone monk dies to the scout's +6 anti-monk bonus first -
  // exactly as in the real game
  const game = await duelGame(13);
  const m1 = game.spawn(0, MONK, 30, 30);
  const m2 = game.spawn(0, MONK, 30, 33);
  const scout = game.spawn(1, UNIT.SCOUT_CAVALRY, 34, 31);
  game.order(0, [m1.id], { kind: "convert", targetId: scout.id });
  game.order(0, [m2.id], { kind: "convert", targetId: scout.id });
  let t = 0;
  while (scout.owner === 1 && t < 40) {
    game.tick();
    t += 0.05;
  }
  assert.equal(scout.owner, 0);
  assert.ok(t >= 9.9, `scout (+3 min) cannot convert before CI 8 = 10s (got ${t.toFixed(2)})`);
  assert.ok(t <= 13.4, `guaranteed by CI 10 = 12.5s (got ${t.toFixed(2)})`);
});

test("converted units lock their stats against the old owner's future techs", async () => {
  const game = await duelGame(17);
  const monk = game.spawn(0, MONK, 30, 30);
  const target = game.spawn(1, UNIT.MILITIA, 34, 30);
  game.order(0, [monk.id], { kind: "convert", targetId: target.id });
  game.run(15);
  assert.equal(target.owner, 0);
  game.players[1].markResearched(67); // old owner researches Forging
  const atk = game.defOf(target).combat!.attacks.find((a) => a.class === 4)!.amount;
  assert.equal(atk, 4, "converted militia keeps attack 4");
  const enemyOwn = game.players[1].getType(UNIT.MILITIA)!.combat!.attacks.find((a) => a.class === 4)!.amount;
  assert.equal(enemyOwn, 5, "the old owner's own militia get 5");
});

test("healing: one monk 2.5 hp/s, a second adds half", async () => {
  const game = await duelGame(19);
  const monk = game.spawn(0, MONK, 30, 30);
  const knight = game.spawn(0, 38, 32, 30);
  knight.hp = 50; // 50 damage taken
  game.order(0, [monk.id], { kind: "heal", targetId: knight.id });
  game.run(10.05);
  assert.ok(Math.abs(knight.hp - 75) < 1.5, `10s of one monk: ${knight.hp.toFixed(1)}, want ~75`);
  const monk2 = game.spawn(0, MONK, 31, 31);
  game.order(0, [monk2.id], { kind: "heal", targetId: knight.id });
  game.run(6);
  // 75 + 6s at 3.75/s = 97.5
  assert.ok(Math.abs(knight.hp - 97.5) < 2, `two monks: ${knight.hp.toFixed(1)}, want ~97.5`);
});

test("relics: pickup transforms the monk, deposit pays 0.5 gold/s", async () => {
  const game = await duelGame(23);
  const p = game.players[0];
  const monk = game.spawn(0, MONK, 30, 30);
  const relic = game.spawn(-1, RELIC, 33, 30);
  const mon = game.spawn(0, MONASTERY, 26, 30);
  game.order(0, [monk.id], { kind: "gather", targetId: relic.id });
  game.run(8);
  assert.ok(!game.entities.has(relic.id), "relic picked up");
  assert.equal(monk.typeId, 286, "monk transformed to relic carrier");
  game.order(0, [monk.id], { kind: "garrison", targetId: mon.id });
  game.run(10);
  assert.equal(monk.typeId, MONK, "monk back to normal after deposit");
  assert.equal(game.relicsGarrisoned[0], 1);
  const g0 = p.resources[RES.GOLD];
  game.run(60);
  assert.ok(Math.abs(p.resources[RES.GOLD] - g0 - 30) < 0.5, `a relic minute pays 30 gold (got ${(p.resources[RES.GOLD] - g0).toFixed(1)})`);
});

test("Theocracy: only the converting monk loses faith", async () => {
  const game = await duelGame(29);
  game.players[0].markResearched(438); // Theocracy
  const m1 = game.spawn(0, MONK, 30, 30);
  const m2 = game.spawn(0, MONK, 30, 32);
  const target = game.spawn(1, UNIT.MILITIA, 34, 31);
  game.order(0, [m1.id], { kind: "convert", targetId: target.id });
  game.order(0, [m2.id], { kind: "convert", targetId: target.id });
  let t = 0;
  while (target.owner === 1 && t < 30) {
    game.tick();
    t += 0.05;
  }
  assert.equal(target.owner, 0);
  const faiths = [m1.faith, m2.faith].sort((a, b) => a - b);
  assert.ok(faiths[0] < 1, `the converter spent faith (${faiths[0].toFixed(2)})`);
  assert.ok(faiths[1] >= 99, "the other monk kept faith under Theocracy");
});
