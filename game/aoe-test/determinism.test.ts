/**
 * Lockstep backbone: two independent simulations built from the same config
 * and fed the same command stream stay bit-identical - plus the trample and
 * splash modes decoded from the blast_damage field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { generateArabia } from "../src/aoe/core/arabia.ts";
import { applyCommand, stateHash, type Command } from "../src/aoe/core/commands.ts";
import { UNIT } from "../src/aoe/data/registry.ts";

test("two sims fed the same command stream stay bit-identical", async () => {
  const d = await data();
  const build = () => {
    const g = makeGame(d, {
      seed: 4242,
      players: [
        { civId: 6, team: 0 },
        { civId: 9, team: 0 },
      ],
    });
    generateArabia(g);
    g.initCivs();
    return g;
  };
  const a = build();
  const b = build();
  assert.equal(stateHash(a), stateHash(b), "identical after generation");

  // a scripted opening issued to both sims at the same ticks
  const tcOf = (g: ReturnType<typeof build>, owner: number) => {
    for (const e of g.entities.values()) {
      if (e.owner === owner && g.familyOf(UNIT.TOWN_CENTER, g.players[owner]).has(e.typeId)) return e.id;
    }
    return 0;
  };
  const villsOf = (g: ReturnType<typeof build>, owner: number) => {
    const out: number[] = [];
    for (const e of g.entities.values()) {
      if (e.owner === owner && g.defOf(e).class === 4) out.push(e.id);
    }
    return out.sort((x, y) => x - y);
  };
  const sheepNear = (g: ReturnType<typeof build>, owner: number) => {
    for (const e of g.entities.values()) if (e.owner === owner && e.typeId === UNIT.SHEEP) return e.id;
    return 0;
  };
  const script: [number, number, (g: ReturnType<typeof build>) => Command][] = [
    [20, 0, (g) => ({ t: "train", building: tcOf(g, 0), unit: UNIT.VILLAGER_M })],
    [20, 1, (g) => ({ t: "train", building: tcOf(g, 1), unit: UNIT.VILLAGER_M })],
    [40, 0, (g) => ({ t: "order", ids: villsOf(g, 0), order: { kind: "gather", targetId: sheepNear(g, 0) } })],
    [40, 1, (g) => ({ t: "order", ids: villsOf(g, 1), order: { kind: "gather", targetId: sheepNear(g, 1) } })],
    [200, 0, (g) => ({ t: "place", unit: UNIT.HOUSE, x: 12, y: 12 })],
    [200, 1, (g) => ({ t: "sell", res: 1 })],
  ];
  for (let tick = 0; tick < 1200; tick++) {
    for (const [at, player, make] of script) {
      if (at === tick) {
        applyCommand(a, player, make(a));
        applyCommand(b, player, make(b));
      }
    }
    a.tick();
    b.tick();
  }
  assert.equal(stateHash(a), stateHash(b), "bit-identical after a minute of play");
});

test("Druzhina trample: bystanders take exactly 5 armor-free damage", async () => {
  const d = await data();
  const game = makeGame(d, {
    seed: 113,
    players: [
      { civId: 23, team: 0 }, // Slavs
      { civId: 1, team: 0 },
    ],
  });
  game.initCivs();
  const p = game.players[0];
  // find and research Druzhina (Slav castle UT)
  let druzhina = -1;
  for (const [tid, t] of d.techs) {
    const effName = t.effect_id >= 0 ? d.effects.get(t.effect_id)?.name ?? "" : "";
    if (t.name.toLowerCase().includes("druzhina") || effName.toLowerCase().includes("druzhina")) druzhina = tid;
  }
  assert.ok(druzhina > 0, "Druzhina tech exists");
  p.markResearched(druzhina);
  const champ = game.spawn(0, UNIT.MILITIA, 30, 30);
  assert.ok(p.getType(UNIT.MILITIA)!.combat!.blast_width > 0, "Druzhina grants blast width");
  const target = game.spawn(1, UNIT.MILITIA, 30.4, 30);
  const bystander = game.spawn(1, UNIT.MILITIA, 30.7, 30.2);
  target.orders = [{ kind: "stop" }];
  bystander.orders = [{ kind: "stop" }];
  const bHp = bystander.hp;
  game.order(0, [champ.id], { kind: "attack", targetId: target.id });
  let t = 0;
  while (bystander.hp === bHp && t < 8) {
    game.tick();
    t += 0.05;
  }
  assert.equal(bHp - bystander.hp, 5, "flat 5 trample, armor ignored");
});

test("War Elephant splash deals half damage to neighbours", async () => {
  const d = await data();
  const game = makeGame(d, {
    seed: 127,
    players: [
      { civId: 8, team: 0 }, // Persians
      { civId: 1, team: 0 },
    ],
  });
  game.initCivs();
  const ele = game.spawn(0, 239, 30, 30);
  const target = game.spawn(1, UNIT.MILITIA, 30.7, 30);
  const neighbour = game.spawn(1, UNIT.MILITIA, 31.0, 30.3);
  target.orders = [{ kind: "stop" }];
  neighbour.orders = [{ kind: "stop" }];
  const full = (await import("../src/aoe/systems/damage.ts")).computeDamage(
    game.players[0].getType(239)!.combat!.attacks,
    game.defOf(neighbour),
  );
  const nHp = neighbour.hp;
  game.order(0, [ele.id], { kind: "attack", targetId: target.id });
  let t = 0;
  while (neighbour.hp === nHp && t < 8) {
    game.tick();
    t += 0.05;
  }
  assert.equal(nHp - neighbour.hp, Math.max(1, Math.floor(full * 0.5)), "50% splash");
});
