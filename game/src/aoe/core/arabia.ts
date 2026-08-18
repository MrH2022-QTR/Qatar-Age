/**
 * Arabia-style map generation: each player gets the documented standard
 * opening at the documented distances - 4 sheep close with 2+2 further out,
 * 6-bush berry patch ~10 tiles, two boars ~16-18, a 7-tile main gold at 7-9
 * with two 4-tile secondaries further afield, 5+4 stone, straggler trees by
 * the TC, woodlines per quadrant, and 5 relics spread across the middle.
 * Distances use ring placement with seeded jitter; exact tile layouts within
 * a cluster follow compact packing like the real generator's grid clumps.
 */

import type { Game } from "./game.ts";
import { UNIT } from "../data/registry.ts";
import { standardStart } from "./setup.ts";

const RELIC = 285;

function ringSpot(game: Game, cx: number, cy: number, dist: number, jitter: number, baseAngle: number): { x: number; y: number } {
  for (let attempt = 0; attempt < 24; attempt++) {
    const ang = baseAngle + game.rng.range(-0.9, 0.9);
    const d = dist + game.rng.range(-jitter, jitter);
    const x = cx + Math.cos(ang) * d;
    const y = cy + Math.sin(ang) * d;
    if (x > 4 && y > 4 && x < game.map.w - 4 && y < game.map.h - 4 && game.map.passableTile(Math.floor(x), Math.floor(y))) {
      return { x, y };
    }
  }
  return { x: cx + dist, y: cy };
}

function cluster(game: Game, typeId: number, n: number, at: { x: number; y: number }): void {
  let placed = 0;
  for (let r = 0; r < 4 && placed < n; r++) {
    for (let dy = -r; dy <= r && placed < n; dy++) {
      for (let dx = -r; dx <= r && placed < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.floor(at.x) + dx + 0.5;
        const y = Math.floor(at.y) + dy + 0.5;
        if (game.map.isFreeForFootprint(x, y, 0.4, 0.4)) {
          game.spawn(-1, typeId, x, y);
          placed++;
        }
      }
    }
  }
}

const DEEP_FISH = 53;
const SHORE_FISH = 69;

export function generateArabia(game: Game, opts?: { coastal?: boolean }): void {
  const coastal = opts?.coastal ?? true;
  const seaW = coastal ? 14 : 0;
  if (coastal) {
    // an ocean strip along the east edge, with deep and shore fish
    for (let y = 0; y < game.map.h; y++) {
      for (let x = game.map.w - seaW; x < game.map.w; x++) {
        game.map.terrain[y * game.map.w + x] = 1;
      }
    }
    for (let i = 0; i < 14; i++) {
      const fy = game.rng.range(6, game.map.h - 6);
      const deep = game.rng.chance(0.6);
      const fx = deep ? game.rng.range(game.map.w - seaW + 4, game.map.w - 2) : game.map.w - seaW + 1.5;
      game.spawn(-1, deep ? DEEP_FISH : SHORE_FISH, fx, fy);
    }
  }

  const n = game.players.length;
  const cx = (game.map.w - seaW) / 2;
  const cy = game.map.h / 2;
  const spawnR = Math.min(game.map.w - seaW, game.map.h) * 0.3;
  const baseRot = game.rng.range(0, Math.PI * 2);

  game.players.forEach((p, i) => {
    const ang = baseRot + (i / n) * Math.PI * 2;
    const px = cx + Math.cos(ang) * spawnR;
    const py = cy + Math.sin(ang) * spawnR;
    standardStart(game, p.id, { x: px, y: py });

    // 4 close sheep + two pairs further out
    cluster(game, UNIT.SHEEP, 4, ringSpot(game, px, py, 4, 1, ang + 1));
    cluster(game, UNIT.SHEEP, 2, ringSpot(game, px, py, 9, 1.5, ang + 2.4));
    cluster(game, UNIT.SHEEP, 2, ringSpot(game, px, py, 9, 1.5, ang - 2.4));
    // berries ~10 tiles
    cluster(game, UNIT.BERRY_BUSH, 6, ringSpot(game, px, py, 10, 1.5, ang + 0.7));
    // two boars
    game.spawn(-1, UNIT.BOAR, ...xy(ringSpot(game, px, py, 16, 2, ang - 0.7)));
    game.spawn(-1, UNIT.BOAR, ...xy(ringSpot(game, px, py, 18, 2, ang + 1.9)));
    // four deer
    cluster(game, UNIT.DEER, 4, ringSpot(game, px, py, 14, 2, ang + 2.9));
    // gold: 7-tile main at 7-9, two 4-tile secondaries
    cluster(game, UNIT.GOLD_MINE, 7, ringSpot(game, px, py, 8, 1, ang - 1.6));
    cluster(game, UNIT.GOLD_MINE, 4, ringSpot(game, px, py, 16, 2, ang + 0.3));
    cluster(game, UNIT.GOLD_MINE, 4, ringSpot(game, px, py, 20, 2, ang - 2.6));
    // stone: 5 main, 4 secondary
    cluster(game, UNIT.STONE_MINE, 5, ringSpot(game, px, py, 9, 1.5, ang + 1.9));
    cluster(game, UNIT.STONE_MINE, 4, ringSpot(game, px, py, 18, 2, ang - 1.1));
    // straggler trees by the TC
    for (let s = 0; s < 5; s++) {
      const sp = ringSpot(game, px, py, 5, 1.5, ang + s * 1.3);
      if (game.map.isFreeForFootprint(sp.x, sp.y, 0.4, 0.4)) game.spawn(-1, UNIT.TREE_OAK, sp.x, sp.y);
    }
    // two woodlines
    cluster(game, UNIT.TREE_OAK, 24, ringSpot(game, px, py, 13, 2, ang + 1.35));
    cluster(game, UNIT.TREE_OAK, 30, ringSpot(game, px, py, 15, 2, ang - 2.0));
  });

  // five relics around the middle band
  for (let r = 0; r < 5; r++) {
    const sp = ringSpot(game, cx, cy, spawnR * 0.45, spawnR * 0.3, game.rng.range(0, Math.PI * 2));
    game.spawn(-1, RELIC, sp.x, sp.y);
  }
}

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}
