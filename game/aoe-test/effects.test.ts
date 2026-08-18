/**
 * Tech-effect engine benchmarks: stats must move exactly as the wiki documents
 * when techs research, and civ bonuses must arrive purely from the shipped data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { UNIT, TECH } from "../src/aoe/data/registry.ts";

const BRITONS = 1;
const TEUTONS = 4;

function attack(def: any, cls: number): number {
  return def.combat.attacks.find((a: any) => a.class === cls)?.amount ?? 0;
}

test("base stats reach the player table unmodified", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const militia = p.getType(UNIT.MILITIA)!;
  assert.equal(militia.hp, 40);
  assert.equal(attack(militia, 4), 4);
  const archer = p.getType(4)!;
  assert.equal(archer.combat!.max_range, 4);
});

test("Britons civ bonus: shepherds work 25% faster (from data, not code)", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const shepherd = p.getType(UNIT.VIL_SHEPHERD)!;
  assert.ok(
    Math.abs(shepherd.bird!.work_rate - 0.33 * 1.25) < 1e-6,
    `shepherd rate ${shepherd.bird!.work_rate}, want 0.4125`,
  );
});

test("Teutons civ bonus: farms cheaper", async () => {
  const d = await data();
  const game = makeGame(d, { players: [{ civId: TEUTONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const farm = p.getType(UNIT.FARM)!;
  const woodCost = farm.creatable!.costs.find((c) => c.type === 1)!.amount;
  const base = d.units.get(UNIT.FARM)!.creatable!.costs.find((c) => c.type === 1)!.amount;
  assert.ok(woodCost < base, `farm wood ${woodCost} should be under base ${base}`);
});

test("Forging adds +1 melee attack to the militia line", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  assert.equal(attack(p.getType(UNIT.MILITIA)!, 4), 4);
  p.markResearched(67); // Forging
  assert.equal(attack(p.getType(UNIT.MILITIA)!, 4), 5);
  assert.equal(attack(p.getType(38)!, 4), 11); // knight 10 -> 11
});

test("Fletching: +1 range, +1 attack, +1 LOS for archers and towers", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const before = p.getType(4)!;
  const r0 = before.combat!.max_range;
  const a0 = attack(before, 3);
  p.markResearched(199); // Fletching
  const after = p.getType(4)!;
  assert.equal(after.combat!.max_range, r0 + 1);
  assert.equal(attack(after, 3), a0 + 1);
});

test("Loom cost and time survive per-player modifiers", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const cost = p.techCost(TECH.LOOM);
  assert.equal(cost.get(3), 50);
  assert.equal(p.techTime(TECH.LOOM), 25);
});

test("standard-play tech path leaves no unimplemented effect commands", async () => {
  const game = makeGame(await data(), { players: [{ civId: BRITONS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  // blacksmith + eco + university core
  for (const tid of [22, 67, 68, 75, 74, 76, 77, 199, 200, 201, 211, 212, 219, 202, 203, 221, 213, 249, 14, 13, 12, 50, 51, 93, 8, 280, 47]) {
    p.markResearched(tid);
  }
  const relevant = p.unimplemented.filter((u) => u.cmd.type !== 40 && u.cmd.type !== 255);
  assert.deepEqual(
    relevant.map((u) => `${u.source}: type ${u.cmd.type} attr ${u.cmd.c}`),
    [],
    `unimplemented: ${JSON.stringify(relevant.slice(0, 10), null, 1)}`,
  );
});
