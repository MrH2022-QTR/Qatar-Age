/**
 * Special combat mechanics: secondary projectiles (Chu Ko Nu volley), blast
 * level filtering and taper (mangonel), charge attacks (Coustillier),
 * regeneration (Berserk).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { UNIT } from "../src/aoe/data/registry.ts";

const CHU_KO_NU = 73;
const MANGONEL = 280;
const COUSTILLIER = 1655;
const BERSERK = 692;
const VIKINGS = 11;
const CHINESE = 6;
const BURGUNDIANS = 36;

test("Chu Ko Nu volley: main arrow full damage, secondaries carry their own 3 pierce", async () => {
  const game = makeGame(await data(), {
    seed: 51,
    players: [
      { civId: CHINESE, team: 0 },
      { civId: 1, team: 0 },
    ],
  });
  game.initCivs();
  const ckn = game.spawn(0, CHU_KO_NU, 30, 30);
  const dummy = game.spawn(1, UNIT.MILITIA, 33, 30);
  dummy.orders = [{ kind: "stop" }];
  game.order(0, [ckn.id], { kind: "attack", targetId: dummy.id });
  // one volley: main 8 pierce - 1 armor = 7; two secondaries 3 - 1 = 2 each
  let t = 0;
  const hp0 = dummy.hp;
  while (dummy.hp === hp0 && t < 10) {
    game.tick();
    t += 0.05;
  }
  game.run(0.8); // let the trailing arrows land
  const taken = hp0 - dummy.hp;
  assert.ok(taken >= 9 && taken <= 11, `first volley dealt ${taken}, want ~11 (7+2+2)`);
});

test("mangonel blast: spares trees at level 2, tapers with distance, hits own units", async () => {
  const game = makeGame(await data(), {
    seed: 53,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  const mang = game.spawn(0, MANGONEL, 30, 30);
  const center = game.spawn(1, UNIT.MILITIA, 36, 30);
  const rim = game.spawn(1, UNIT.MILITIA, 36.9, 30);
  const friendly = game.spawn(0, UNIT.MILITIA, 36, 30.5);
  const tree = game.spawn(-1, UNIT.TREE_OAK, 36, 29.4);
  center.orders = [{ kind: "stop" }];
  rim.orders = [{ kind: "stop" }];
  friendly.orders = [{ kind: "stop" }];
  const treeWood0 = tree.resAmount;
  game.order(0, [mang.id], { kind: "attack", targetId: center.id });
  let t = 0;
  const hp0 = center.hp;
  while (center.hp === hp0 && game.entities.has(center.id) && t < 15) {
    game.tick();
    t += 0.05;
  }
  game.run(0.5);
  assert.ok(!game.entities.has(center.id) || center.hp < hp0, "centre hit");
  assert.ok(!game.entities.has(rim.id) || rim.hp < rim.hp + 1, "rim unit also caught");
  assert.ok(!game.entities.has(friendly.id) || friendly.hp < game.defOf(friendly).hp, "friendly fire is real");
  assert.equal(game.entities.has(tree.id), true, "tree survives a level-2 blast");
  assert.equal(tree.resAmount, treeWood0, "tree wood untouched");
});

test("Coustillier charge: +20 on the charged strike, 40s to recharge", async () => {
  const game = makeGame(await data(), {
    seed: 57,
    players: [
      { civId: BURGUNDIANS, team: 0 },
      { civId: 1, team: 0 },
    ],
  });
  game.initCivs();
  const cous = game.spawn(0, COUSTILLIER, 30, 30);
  cous.charge = 20; // rode in charged
  const dummy = game.spawn(1, 38, 30.6, 30); // knight: 100 hp, 2 melee armor
  dummy.orders = [{ kind: "stop" }];
  game.order(0, [cous.id], { kind: "attack", targetId: dummy.id });
  let t = 0;
  const hp0 = dummy.hp;
  while (dummy.hp === hp0 && t < 6) {
    game.tick();
    t += 0.05;
  }
  const first = hp0 - dummy.hp;
  // base 8 - 2 armor = 6, plus the 20-point charge
  assert.equal(first, 26, `charged strike ${first}`);
  const hp1 = dummy.hp;
  game.run(2.1); // next swing, charge spent
  const second = hp1 - dummy.hp;
  assert.equal(second, 6, `uncharged strike ${second}`);
  // charge rebuilds at 0.5/s
  assert.ok(cous.charge > 0.5 && cous.charge < 3, `recharging (${cous.charge.toFixed(1)})`);
});

test("Berserks regenerate at their native 40 hp/min", async () => {
  const game = makeGame(await data(), { seed: 59, players: [{ civId: VIKINGS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  const def = p.getType(BERSERK)!;
  assert.equal(def.creatable!.rear_attack_modifier, 40, "native regen rate rides rear_attack_modifier");
  const b = game.spawn(0, BERSERK, 30, 30);
  b.hp = 10;
  game.run(30); // half a minute at 40/min = +20
  assert.ok(Math.abs(b.hp - 30) < 1, `30s healed to ${b.hp.toFixed(1)}, want ~30`);
});
