# Kingdoms of Qatar

A Qatar-themed real-time strategy game for the browser — TypeScript, PixiJS v8, miniplex.

Built against the architectural reconnaissance in [`../docs/`](../docs/), which maps the
openage engine in this repository and works out what to borrow, what to reject, and in what
order to build. The reference engine is left untouched; nothing here imports from it.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # headless simulation tests
npm run fuzz       # pathfinder invariant fuzzing
```

`?lang=ar` switches to Arabic (RTL).

---

## What works today

Phases 0–3 of [`../docs/PORT_PLAN.md`](../docs/PORT_PLAN.md), plus parts of 4 and 7.

- **Isometric world.** 96×96 procedural Qatari peninsula — coastal sand flats, inland
  desert and gravel, oasis grass, rock outcrops, and Gulf shallows. Chunked terrain
  rendering with off-screen culling.
- **Camera.** Pan (middle-drag, WASD, arrows), zoom about the cursor, clamped to the map.
- **Entities.** miniplex ECS. Units, buildings, and resource nodes are all the same entity
  type distinguished only by their components — openage's composition model, kept.
- **Selection.** Click, box-select, selection rings. Units preferred over buildings.
- **Movement.** Grid A\* with soft collision, turn-rate modelling, group destination
  spreading, per-frame path budgeting.
- **Economy data.** Four resources (food, wood, stone, **pearls**), stockpiles, costs,
  affordability. Pearl banks spawn offshore in the shallows, so pearling is a coastal
  activity with real travel cost rather than a reskinned gold mine.
- **Tech and civilisations.** Per-player data views with declarative patches. Three civs
  (Al Bidda, Al Zubarah, Al Khor), four ages, five techs.
- **Localisation.** English and Arabic, RTL layout via CSS logical properties, DOM-rendered
  UI so the browser handles Arabic shaping and bidi.
- **Debug tooling.** `F3` overlay with per-system timings, `G` grid, `P` path visualisation.

Not yet built: gathering loop, construction, combat, AI, save/load. See the port plan.

---

## Architecture

The one rule everything else follows:

> **`src/sim/` never imports a renderer, and never calls `Math.random()`.**

Both are enforced by lint, not by good intentions. The payoff is that the entire simulation
runs headless in Node — which is what makes the test suite and the pathfinder fuzzer
possible, and what will make save/load straightforward.

```
src/
  sim/                    Headless simulation. No PixiJS, ever.
    math.ts               Arithmetic isolation (see below)
    random.ts             Seeded PRNG — save/load and determinism
    time.ts               Clock with the 50ms delta clamp
    coords.ts             Isometric projection and the five coordinate spaces
    grid.ts               Terrain + movement cost field (Uint8Array)
    components.ts         ECS component definitions
    player.ts             Per-player data views and patches
    world.ts              Entity store, spatial index
    simulation.ts         System order and the scheduled-event queue
    mapgen.ts             Peninsula generation
    pathfinding/          A*, binary heap, self-verification
    systems/              movement, steering
    tools/                fuzz-pathfinder.ts
  render/                 PixiJS. Reads simulation, writes display objects.
  data/                   Static content as JSON
  locales/                en, ar
```

### Three decisions worth knowing about

**1. We take openage's data model and reject its control-flow model.**
openage says "component" and "system" but its own docs admit it is not a data-oriented ECS —
entities are hash maps of polymorphic heap objects, and systems run per-entity via behaviour
graphs. That does not compose with miniplex. So components are plain data (its genuinely
good idea, including the static/runtime split), while control flow is ordinary queries plus a
small `state` discriminated union. Details in [`../docs/SYSTEMS.md`](../docs/SYSTEMS.md) §3.

**2. Soft collision, deliberately.**
The Engineering Director at Forgotten Empires — the studio shipping the official Age of
Empires Definitive Editions — spent 25 years on pathfinding bugs rooted in AoE2's strict
no-overlap rule, which makes every unit a dynamic obstacle. Asked what he'd do from a green
field, his answer was to simplify the movement model up front, StarCraft-style, because
"players just like that better." We have a green field. Buildings and terrain are hard
obstructions; units repel each other and may briefly overlap. That eliminates the entire bug
class by construction. The trade — losing body-blocking as a tactic — is documented in
[`../docs/PATHFINDING_NOTES.md`](../docs/PATHFINDING_NOTES.md) §7.1.

**3. Floats now, fixed-point reachable.**
Both openage and the commercial AoE engine use fixed-point arithmetic, because exact
geometric predicates need it. Decision 2 removes that requirement for us, so `sim/math.ts` is
thin float wrappers. But all simulation arithmetic and randomness stay behind two modules, so
if we ever add hard polygon collision or lockstep multiplayer, the switch is one file rather
than three hundred call sites.

---

## Testing

```bash
npm test                 # 50 unit tests
npm run fuzz             # pathfinder invariants over generated maps
npm run build && npm run preview &
node scripts/smoke-test.mjs --shots ./shots
```

**The fuzzer is the interesting one.** Every path the game produces can be checked against
cheap invariants — no waypoint on impassable ground, no segment crossing an obstruction, no
revisited tiles, endpoints correct. `npm run fuzz` generates thousands of maps across three
adversarial archetypes and asserts those invariants on every path, writing a full
reproduction snapshot to `test/fixtures/` on any failure.

This is lifted directly from how the AoE2 pathfinding bug was finally fixed, and it earned
its place on the first run: it immediately found 4,402 violations caused by `Path` never
reporting which goal it actually targeted when the requested tile was blocked. Current
status: **31,083 paths, zero violations.**

---

## Content

All game content is authored JSON in `src/data/` — the openage repository ships none
(it generates content from the user's own Age of Empires install), so what we inherited was a
schema, not a dataset. See [`../docs/DATA_INVENTORY.md`](../docs/DATA_INVENTORY.md).

Civilisations, ages, units and buildings draw on Qatari history — the pearling economy and
its divers, the Barzan towers, Al Zubarah and Al Bidda, the majlis, the dhow yards. This is
a first pass by an engineer, not a historian: the schema will accept whatever numbers it is
given, and making the civ set both historically defensible and good to play is real research
that should run alongside the engineering rather than after it.

---

## Rebuilding assets from the art library

`public/assets/sprites/` holds only the sheets the game currently references —
about 38 MB. The full library is roughly 186 MB across 59 sheets, and putting
that in git history would make every clone slow forever for art that is not yet
wired to anything.

To slice the whole library (e.g. after wiring a new category):

```bash
node tools/build-assets.mjs --lib <extracted-library> --out public/assets/sprites
node tools/measure-terrain.mjs        # terrain needs true diamond geometry
```

`build-assets.mjs` runs every sheet through the same connected-component slicer
and writes one `sheets.json`. Sheets are indexed `category/name`, and the
placement tables in `src/render/sheets.ts` (`RESOURCE_ART`, `DOODAD_ROWS`) map
game content onto specific rows — that is the seam where different art drops in.

Currently wired: terrain atlas, buildings, 5 unit sheets, HUD chrome, resource
depletion states, terrain decorations, map dressing.

Sliced but not yet wired: unit animations, faction unit sets (incl. Middle
Eastern), 4 further building sheets, construction states, projectiles, VFX,
wildlife, cursors, portraits, action buttons, heraldry, loading screens.
