/**
 * Walls, gates, and conquest: walls block pathing, gates auto-open for their
 * owner's team only, locking seals them, destruction reopens the hole, and a
 * player scoured from the map is defeated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { findPath } from "../src/aoe/systems/movement.ts";
import { UNIT } from "../src/aoe/data/registry.ts";

const PALISADE = 72;
const GATE_H = 487; // horizontal gate, 4x1

async function walledGame() {
  const game = makeGame(await data(), {
    seed: 61,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  // wall across x = 20..40 at y = 30, with a 4-tile gate filling x = 28..31
  for (let x = 20; x <= 40; x++) {
    if (x >= 28 && x <= 31) continue;
    game.spawn(0, PALISADE, x + 0.5, 30.5);
  }
  const gate = game.spawn(0, GATE_H, 30, 30.5); // radius 2 -> occupies tiles 28..31
  return { game, gate };
}

test("gates open for the owner, stay shut for the enemy", async () => {
  const { game, gate } = await walledGame();
  const own = game.spawn(0, UNIT.VILLAGER_M, 30, 25);
  const foe = game.spawn(1, UNIT.MILITIA, 31, 25);
  const ownPath = findPath(game, own, 30, 36);
  const foePath = findPath(game, foe, 31, 36);
  const len = (p: { x: number; y: number }[], sx: number, sy: number) => {
    let d = 0;
    let px = sx;
    let py = sy;
    for (const w of p) {
      d += Math.hypot(w.x - px, w.y - py);
      px = w.x;
      py = w.y;
    }
    return d;
  };
  const ownLen = len(ownPath, own.x, own.y);
  assert.ok(ownPath.length > 0 && ownLen < 14, `owner slips through the gate (${ownLen.toFixed(1)} tiles)`);
  const foeLen = len(foePath, foe.x, foe.y);
  assert.ok(foePath.length === 0 || foeLen > 20, `enemy must go the long way (${foeLen.toFixed(1)} tiles)`);
});

test("a locked gate blocks even the owner; killing it reopens the wall", async () => {
  const { game, gate } = await walledGame();
  const own = game.spawn(0, UNIT.VILLAGER_M, 30, 25);
  gate.locked = true;
  const locked = findPath(game, own, 30, 36);
  assert.ok(
    locked.length === 0 || locked.reduce((d, w, i, a) => d + (i ? Math.hypot(w.x - a[i - 1].x, w.y - a[i - 1].y) : 0), 0) > 18,
    "locked gate seals the wall",
  );
  game.kill(gate);
  const after = findPath(game, own, 30, 36);
  assert.ok(after.length > 0, "destroyed gate leaves a hole");
});

test("conquest: a player scoured from the map is defeated", async () => {
  const game = makeGame(await data(), {
    seed: 63,
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  game.spawn(0, UNIT.TOWN_CENTER, 30, 30);
  const foeTc = game.spawn(1, UNIT.TOWN_CENTER, 60, 60);
  const foeVill = game.spawn(1, UNIT.VILLAGER_M, 63, 60);
  game.run(3);
  assert.equal(game.winnerTeam, null, "game running");
  game.kill(foeTc);
  game.kill(foeVill);
  game.run(3);
  assert.equal(game.defeated[1], true, "player 2 defeated");
  assert.equal(game.winnerTeam, -1, "player 1 (solo) wins");
});
