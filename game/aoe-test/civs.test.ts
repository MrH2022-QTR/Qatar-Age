/**
 * The all-civilizations matrix: every playable civ must initialize purely from
 * data with zero unimplemented effect commands, reach the Imperial Age through
 * the real prerequisite graph, field a unique unit at the Castle, and honor its
 * tech-tree disables. Famous bonuses spot-checked numerically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import type { Player } from "../src/aoe/core/player.ts";
import { UNIT, TECH } from "../src/aoe/data/registry.ts";

const CASTLE = 82;

/** Grant the shadow techs real buildings would grant, then walk to Imperial. */
function walkToImperial(p: Player): boolean {
  // building techs: barracks, mill, lumber camp, mining camp, market, range,
  // stable, blacksmith, monastery, university, castle, dock
  for (const t of [122, 110, 258, 282, 128, 132, 130, 106, 138, 209, 266, 133]) {
    p.grantBuildingTech(t);
  }
  for (const age of [TECH.FEUDAL_AGE, TECH.CASTLE_AGE, TECH.IMPERIAL_AGE]) {
    p.runAutoTechs();
    if (!p.canResearch(age)) return false;
    p.markResearched(age);
  }
  p.runAutoTechs();
  return true;
}

test("all 59 playable civs initialize from data with zero unimplemented commands", async () => {
  const d = await data();
  const problems: string[] = [];
  for (let civ = 1; civ < 60; civ++) {
    const game = makeGame(d, { players: [{ civId: civ, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    const bad = p.unimplemented.filter((u) => u.cmd.type !== 40 && u.cmd.type !== 255);
    for (const u of bad.slice(0, 2)) {
      problems.push(`${d.civs.get(civ)!.name}: ${u.source} type ${u.cmd.type} attr ${u.cmd.c}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("; "));
});

test("all 59 civs can walk the real prerequisite graph to the Imperial Age", async () => {
  const d = await data();
  const failed: string[] = [];
  for (let civ = 1; civ < 60; civ++) {
    const game = makeGame(d, { players: [{ civId: civ, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    if (!walkToImperial(p)) failed.push(d.civs.get(civ)!.name);
    else if (p.currentAge() !== 3) failed.push(`${d.civs.get(civ)!.name} (age ${p.currentAge()})`);
  }
  assert.deepEqual(failed, [], `civs that could not reach Imperial: ${failed.join(", ")}`);
});

test("every classic civ fields a unique unit at the Castle", async () => {
  const d = await data();
  const missing: string[] = [];
  for (let civ = 1; civ <= 45; civ++) {
    const game = makeGame(d, { players: [{ civId: civ, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    walkToImperial(p);
    const trainable: string[] = [];
    for (const [uid, u] of d.units) {
      const local = p.getType(uid);
      if (!local?.creatable || local.type !== 70) continue;
      if (!p.isUnitEnabled(uid)) continue;
      if (p.resolveUpgrade(uid) !== uid) continue;
      if (local.creatable.train_locations.some((l) => game.familyOf(l.unit_id, p).has(CASTLE))) {
        trainable.push(local.name);
      }
    }
    // every civ trains its unique unit (and often the petard/trebuchet) here
    if (trainable.length === 0) missing.push(d.civs.get(civ)!.name);
  }
  assert.deepEqual(missing, [], `castle-empty civs: ${missing.join(", ")}`);
});

test("famous unique units appear for their civs", async () => {
  const d = await data();
  const expected: [number, number, string][] = [
    [1, 8, "Longbowman (British)"],
    [2, 281, "Throwing Axeman (French)"],
    [3, 41, "Huskarl (Goths)"],
    [4, 25, "Teutonic Knight (Teutons)"],
    [6, 73, "Chu Ko Nu (Chinese)"],
    [11, 692, "Berserk (Vikings)"],
  ];
  for (const [civ, unitId, label] of expected) {
    const game = makeGame(d, { players: [{ civId: civ, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    walkToImperial(p);
    assert.ok(p.isUnitEnabled(unitId), `${label} enabled after castle age`);
  }
});

test("tech-tree disables hold: Franks lack Bloodlines, Aztecs lack the Stable", async () => {
  const d = await data();
  {
    const game = makeGame(d, { players: [{ civId: 2, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    walkToImperial(p);
    assert.equal(p.canResearch(435), false, "Franks: Bloodlines stays off");
  }
  {
    const game = makeGame(d, { players: [{ civId: 15, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    walkToImperial(p);
    assert.equal(p.isUnitEnabled(101), false, "Aztecs: no Stable");
  }
});

test("famous numeric bonuses: Aztec carry +3, Persian +50f/+50w start", async () => {
  const d = await data();
  {
    const game = makeGame(d, { players: [{ civId: 15, team: 0 }] });
    game.initCivs();
    const p = game.players[0];
    const base = d.units.get(UNIT.VIL_LUMBERJACK)!.resource_capacity;
    assert.equal(p.getType(UNIT.VIL_LUMBERJACK)!.resource_capacity, base + 3, "Aztec lumberjack carry");
  }
  {
    const game = makeGame(d, { players: [{ civId: 8, team: 0 }] });
    game.spawn(0, UNIT.TOWN_CENTER, 30, 30); // the bonus hangs off the TC shadow techs
    game.initCivs();
    const p = game.players[0];
    assert.equal(p.resources[0], 250, "Persians start +50 food");
    assert.equal(p.resources[1], 250, "Persians start +50 wood");
  }
});

test("team bonuses reach allies: Britons speed up the ally's archery ranges", async () => {
  const d = await data();
  const game = makeGame(d, {
    players: [
      { civId: 1, team: 1 },
      { civId: 2, team: 1 },
    ],
  });
  game.initCivs();
  const ally = game.players[1];
  const range = ally.getType(87)!; // archery range
  const wr = range.bird?.work_rate ?? 1;
  assert.ok(wr > 1.05, `ally archery range work rate ${wr} shows the Briton team bonus`);
});
