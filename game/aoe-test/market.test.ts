/**
 * Market benchmarks: exchange rates and fees, global price drift, tribute,
 * and the trade-cart distance formula.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "./helpers.ts";
import { makeGame } from "../src/aoe/core/setup.ts";
import { marketBuy, marketSell, marketRates, sendTribute, tradeGoldPerTrip, MARKET } from "../src/aoe/systems/market.ts";
import { RES, UNIT } from "../src/aoe/data/registry.ts";

const TRADE_CART = 128;
const SARACENS = 9;

test("sell 100 wood for 70, buy 100 food for 150; rates drift by 2 globally", async () => {
  const game = makeGame(await data(), {
    players: [
      { civId: 1, team: 0 },
      { civId: 2, team: 0 },
    ],
  });
  game.initCivs();
  const p = game.players[0];
  const gold0 = p.resources[RES.GOLD];
  assert.ok(marketSell(game, 0, RES.WOOD));
  assert.equal(p.resources[RES.GOLD] - gold0, 70, "wood sells at 0.7 x 100");
  assert.equal(p.resources[RES.WOOD], 100);
  assert.equal(marketRates(game)[RES.WOOD], 98, "selling lowers the rate by 2");

  p.resources[RES.GOLD] = 500;
  assert.ok(marketBuy(game, 0, RES.FOOD));
  assert.equal(500 - p.resources[RES.GOLD], 150, "food buys at 1.3 x 115");
  assert.equal(marketRates(game)[RES.FOOD], 117, "buying raises the rate by 2");

  // rates are global: player 2 sells wood into the moved market
  const q = game.players[1];
  const qg = q.resources[RES.GOLD];
  assert.ok(marketSell(game, 1, RES.WOOD));
  assert.equal(q.resources[RES.GOLD] - qg, Math.round(98 * 0.7), "player 2 sees the drifted rate");
});

test("Saracens pay a 5% fee straight from their civ data", async () => {
  const game = makeGame(await data(), { players: [{ civId: SARACENS, team: 0 }] });
  game.initCivs();
  const p = game.players[0];
  assert.ok(Math.abs(p.resources[78] - 0.05) < 1e-9, `Saracen fee ${p.resources[78]}`);
  const gold0 = p.resources[RES.GOLD];
  marketSell(game, 0, RES.WOOD);
  assert.equal(p.resources[RES.GOLD] - gold0, 95, "wood sells at 0.95 x 100");
});

test("Guilds halves the fee to 15%", async () => {
  const game = makeGame(await data());
  game.initCivs();
  const p = game.players[0];
  p.markResearched(15); // Guilds
  assert.ok(Math.abs(p.resources[78] - 0.15) < 1e-9);
  const gold0 = p.resources[RES.GOLD];
  marketSell(game, 0, RES.WOOD);
  assert.equal(p.resources[RES.GOLD] - gold0, 85);
});

test("tribute costs 30% extra, free after Banking", async () => {
  const game = makeGame(await data(), {
    players: [
      { civId: 1, team: 1 },
      { civId: 2, team: 1 },
    ],
  });
  game.initCivs();
  const p = game.players[0];
  const q = game.players[1];
  p.resources[RES.GOLD] = 400;
  const qg = q.resources[RES.GOLD];
  assert.ok(sendTribute(game, 0, 1, RES.GOLD, 100));
  assert.equal(400 - p.resources[RES.GOLD], 130, "100 sent costs 130");
  assert.equal(q.resources[RES.GOLD] - qg, 100);
  p.markResearched(17); // Banking
  p.resources[RES.GOLD] = 400;
  sendTribute(game, 0, 1, RES.GOLD, 100);
  assert.equal(400 - p.resources[RES.GOLD], 100, "Banking removes the fee");
});

test("trade cart: gold per trip follows the distance formula and gets delivered", async () => {
  const game = makeGame(await data(), {
    players: [
      { civId: 1, team: 1 },
      { civId: 2, team: 1 },
    ],
  });
  game.initCivs();
  const home = game.spawn(0, MARKET, 20, 30);
  const foreign = game.spawn(1, MARKET, 60, 30);
  const cart = game.spawn(0, TRADE_CART, 22, 30);
  // d = |60-20| - 5 = 35; gold = 0.46 * 35 * (35/120 + 0.3)
  const expected = 0.46 * 35 * (35 / 120 + 0.3);
  const computed = tradeGoldPerTrip(game, cart, home, foreign);
  assert.ok(Math.abs(computed - expected) < 0.01, `formula: ${computed.toFixed(2)} vs ${expected.toFixed(2)}`);

  const p = game.players[0];
  const gold0 = p.resources[RES.GOLD];
  game.order(0, [cart.id], { kind: "trade", targetId: foreign.id });
  // one round trip is ~80 tiles at 1.25 t/s plus turnarounds
  game.run(90);
  const gained = p.resources[RES.GOLD] - gold0;
  assert.ok(gained > expected * 0.9, `at least one delivery: ${gained.toFixed(1)}`);
  const trips = Math.round(gained / expected);
  assert.ok(Math.abs(gained - trips * expected) < 0.6, `gold is whole trips (${gained.toFixed(1)} ~ ${trips} x ${expected.toFixed(2)})`);
});
