# PORT PLAN — Proposed Order for Rebuilding in TypeScript + PixiJS v8 + miniplex

**Companion to `ARCHITECTURE.md`, `SYSTEMS.md`, `DATA_INVENTORY.md`, `PATHFINDING_NOTES.md`.**

---

## 0. Reframing the job

Before sequencing anything, the reconnaissance changed what this project *is*. Three
findings, from `ARCHITECTURE.md`:

1. **The engine has no gameplay.** Of the twelve gameplay systems that make an RTS an RTS,
   exactly one — movement — is implemented. Combat, resources, construction, tech, AI,
   save/load, and networking do not exist in C++ at all.
2. **The repository has no content.** Not one unit, civ, tech, or map. All content is
   generated at install time from the user's own Age of Empires files.
3. **The largest subsystem is one we won't port.** The renderer is 26,164 lines — 15% of
   the codebase — doing what PixiJS provides as a library. The converter is another 73,391
   lines that is entirely irrelevant to us.

So this is **not a port in the usual sense.** It is closer to:

> *Build an RTS from scratch, guided by an excellent architectural reference and a complete
> data specification, borrowing algorithms where they're genuinely good.*

That's a more honest framing, and it's a bigger job than "port openage" sounds — but a more
tractable one, because we're not fighting someone else's 80,000 lines of C++.

**What we actually inherit, and it's worth a lot:**

| Asset | Value |
| --- | --- |
| `doc/nyan/api_reference/` (5,188 lines) | A complete, coherent RTS data model |
| `nyan_api_loader.py` (4,973 lines) | The same model, machine-readable |
| Flow-field pathfinder (7,695 lines) | A working reference implementation for later |
| Curve/timeline model | A genuinely novel state representation |
| Per-player database views | The best idea in the codebase (see §Tech, and `SYSTEMS.md` §8) |
| Coordinate system spec | Isometric math, correct, with the `sqrt(8)` |
| Activity graphs | A behaviour model to borrow from selectively |
| **`PATHFINDING_NOTES.md`** | 25 years of shipped evidence on the hardest system |

---

## 1. Sequencing principles

The order below follows five rules, in priority order:

1. **Something playable early.** A visible, interactive loop beats a perfect foundation.
   Motivation is a real project resource, and this is a long project.
2. **Dependency order, not difficulty order.** A system whose absence blocks three others
   comes first even if it's dull.
3. **Decisions that are cheap now and expensive later come first.** Per-player data views,
   entity-IDs-not-references, arithmetic isolation, `t()` on strings. Each costs ~nothing
   on day one and is a painful retrofit on day two hundred.
4. **Defer the genuinely hard things until their requirements are known.** Flow fields,
   determinism, and networking should be informed by a working game, not guessed at.
5. **Keep the simulation headless at all times.** If it can't run without PixiJS, we've
   coupled something we shouldn't have — and we've lost testability and fuzzing.

---

## 2. Difficulty assessment

Honest ratings. "Hard" means *genuinely* hard, not just large.

| System | Difficulty | Why |
| --- | --- | --- |
| Localization | **Trivial** | JSON + a lookup function. Only cost is remembering to do it early. |
| Config loading | **Trivial** | `fetch` + JSON. openage's `cvar` system is over-engineered for us. |
| Audio | **Easy** | Web Audio/Howler exceeds what openage has working. Watch the autoplay policy. |
| Static data loading | **Easy** | JSON + TypeScript types. |
| Terrain (flat) | **Easy** | A `Uint8Array` and a tilemap. |
| Rendering | **Easy–Medium** | PixiJS does the work. Depth sorting and player-colour shaders are the real tasks. |
| Input & selection | **Easy–Medium** | Standard, but box-select + HUD click-through need care. |
| Resources | **Easy–Medium** | Arithmetic is trivial; the gather *loop* has real state complexity. |
| Building placement | **Easy–Medium** | Validation + ghost. Must stamp the pathfinding grid from day one. |
| Save/load | **Medium** | Easy *if* state is plain data. It's a canary for architectural leaks. |
| UI/HUD | **Medium** | Lots of surface area. DOM makes it ordinary web work. |
| Tech tree | **Medium** | Easy with per-player views; miserable to retrofit. Decide in week one. |
| Combat | **Medium–Hard** | Damage math is easy. Projectiles, stances, and auto-acquisition are fiddly and bug-prone. |
| Simulation loop | **Medium–Hard** | The loop is simple; event-driven *debugging* requires tooling we must build. |
| Entity model | **Medium–Hard** | Mostly a design decision (see §3.2). Wrong choice is expensive. |
| Map generation | **Hard** | Symmetric fairness is a real algorithmic problem. |
| AI | **Hard** | Scripted v1 is easy; anything strategic is a research problem. |
| **Pathfinding** | **Hard** | See `PATHFINDING_NOTES.md`. 25 years of shipped bugs. |
| **Deterministic sim** | **Very hard** | All-or-nothing, and must be decided before line one. |
| **Networking** | **Very hard** | Hardest thing in the project. Defer explicitly. |

---

## 3. The plan

Ten phases. Phases are sequenced by dependency; durations are deliberately omitted because
I don't know the team size, and a fake schedule is worse than none.

---

### Phase 0 — Foundations and irreversible decisions

**Goal:** make the decisions that are free now and expensive later. Nothing visible ships.

**Why first:** every item here is a retrofit nightmare and a five-minute decision.

1. **Project skeleton.** Vite + TypeScript, strict mode. Two packages or at least two
   directories: `sim/` (no PixiJS import, ever) and `render/`. Enforce with a lint rule —
   this single constraint protects headless testing, fuzzing, and save/load.
2. **Arithmetic isolation.** All simulation math behind `sim/math.ts`; all randomness behind
   a seeded PRNG in `sim/random.ts`. **No `Math.random()` in `sim/`, enforced by lint.**
   Per `PATHFINDING_NOTES.md` §7.4, this keeps the fixed-point decision reversible for
   about ten minutes of work.
3. **Entity references are numeric IDs.** Never object references, anywhere in simulation
   state. This is what makes save/load possible at all (`SYSTEMS.md` §11).
4. **Per-player data views.** Implement `PlayerDataView` (`SYSTEMS.md` §8) *before* any
   stat is read. Every stat lookup goes through `player.data.get(typeId)`. Do this now and
   tech trees and civ bonuses are nearly free later; skip it and they're a refactor across
   the whole codebase.
5. **`t()` from the first string.** Even if `locales/ar.json` is empty. Use CSS logical
   properties in all stylesheets from the first rule (`SYSTEMS.md` §16).
6. **Coordinate module + tests.** Port openage's isometric math including the `sqrt(8)`
   (`doc/code/coordinate-systems.md`). One module, thoroughly tested. Coordinate bugs are
   the most time-consuming and most preventable class of bug in isometric games.
7. **Time module.** Float seconds, clamped delta (keep openage's 50 ms ceiling — it matters
   more in a browser because backgrounded tabs throttle `requestAnimationFrame`).

**Deliverable:** a repo that renders nothing but has the right bones.

---

### Phase 1 — Render a world you can look at

**Goal:** an isometric map on screen with a camera you can move.

**Why second:** visual feedback makes every later phase debuggable. Without it we're
writing an RTS blind.

1. PixiJS v8 app, containers per render stage (terrain → world → HUD).
2. Flat terrain: `Uint8Array` of tile types; tilemap rendering from one atlas.
3. Camera: pan (drag + edge scroll), zoom, clamp to map bounds.
4. Coordinate conversion wired to the mouse — click a tile, log the tile.
5. Placeholder art. **Do not wait for real art.** Coloured diamonds are fine.

**Deliverable:** pan and zoom around a tile map.

**Gotcha:** get **atlas discipline** right now. One atlas per logical group, everything
batched. Retrofitting this after 200 sprites exist is miserable, and it's the single
largest determinant of frame rate (`SYSTEMS.md` §1).

---

### Phase 2 — Entities on screen

**Goal:** entities exist, render, and can be selected.

1. **miniplex world**, components as plain objects: `position`, `sprite`, `owner`,
   `selectable`, `unitType`.
2. **The render system** — the *only* code that reads simulation state and writes PixiJS
   properties. Keep openage's render-entity discipline (`SYSTEMS.md` §1) even though we're
   single-threaded; it's what keeps `sim/` headless.
3. Depth sorting by `(NE + SE)`. Benchmark it — consider row bucketing over a full sort.
4. Selection: single click, box select, selection ring rendering.
5. Static data loading: `units.json` → typed definitions → spawn entities.

**Deliverable:** click and box-select units on a map.

**Decision point — the entity model.** Per `SYSTEMS.md` §3: take openage's *data* model
(components, two-tier static/runtime split), reject its *control-flow* model (activity
graphs). Use a `state` discriminated union per entity plus ordinary miniplex queries. Do
**not** build a behaviour-graph interpreter yet.

---

### Phase 3 — Movement (and the pathfinding decision)

**Goal:** right-click to move. The first real gameplay.

This phase is where `PATHFINDING_NOTES.md` earns its place.

1. **Grid A\***, binary heap, octile heuristic, over a `Uint8Array` passability grid.
   Not flow fields. Not yet.
2. **Soft collision** — per `PATHFINDING_NOTES.md` §7.1, units repel each other with
   steering rather than hard-blocking; only buildings and terrain are hard obstructions.
   This is the shipping AoE engineering director's own answer to "what would you do from
   scratch," and it eliminates by construction the entire bug class his talk is about.
3. **Two-tier structure from the start** (§7.2): coarse A* over 8×8 blocks → waypoints;
   fine A* between them. Both codebases converged on this independently; retrofitting a
   hierarchy is invasive.
4. **Path validation + failure dumps** (§7.3): a debug mode that checks every returned path
   (no impassable tiles, endpoints correct, waypoints adjacent, iteration count sane) and
   serialises failures to JSON.
5. **Turn-delay modelling.** Steal this from `move.cpp:140-160` — pausing to rotate before
   each leg is ~10 lines and it's much of what makes AoE2 units feel weighty.
6. **Path budgeting** (§7.5): cap paths per frame, exempt human-issued commands.
7. **Unreachability detection** (§7.5): detect "no path" cheaply and fall back to nearest
   reachable point.

**Deliverable:** select units, right-click, they walk there and look right doing it.

**Explicitly deferred:** flow fields. Revisit only when 100+ units share a destination and
profiling proves A* is the bottleneck. When that happens, port incrementally — cost field →
integration field → flow field on a *single* whole-map sector — and add the portal
hierarchy only if map size forces it (`SYSTEMS.md` §4).

---

### Phase 4 — Economy

**Goal:** gather resources and spend them. The game becomes a *game*.

**Why here:** it's the easiest major gameplay system (nothing to port, good spec), it makes
the game feel real, and construction and production both depend on it.

1. Stockpile per player; `canAfford` / `deduct`.
2. Resource spots (trees, mines, fish) as entities with `resourceSpot`.
3. Drop sites; nearest-drop-site query via a simple spatial grid.
4. **The gather loop** as a `state` union — approach → gather → seek drop site → deposit →
   return. This is where the discriminated union earns its keep, and it's the real work of
   this phase.
5. Depletion and graceful reassignment when a spot runs out.
6. HUD resource readout (DOM).

**Deliverable:** villagers gather and deposit; the counter goes up.

**Design opportunity:** per `SYSTEMS.md` §5 — pearls, dates, fish, and livestock map onto
the historical Qatari coastal economy, and pearl diving suggests a genuinely different
gather rhythm (boats, dive duration, risk) than chopping wood. `Gather` is generic over
resource type, so the schema accommodates this. Worth prototyping here rather than
retrofitting a fifth resource later.

---

### Phase 5 — Construction and production

**Goal:** build buildings; buildings make units.

1. Placement ghost: semi-transparent sprite, green/red validity tint.
2. Footprint validation: terrain type, bounds, occupancy grid.
3. **Stamp the footprint into the pathfinding cost grid on completion; clear on
   destruction.** Per `SYSTEMS.md` §6 — do this now, not later, or units walk through
   buildings and the fix touches path caching.
4. Construction progress; foundation → completed as a component swap (not a nyan-style
   entity transformation).
5. Production queue; rally points; population cap.

**Deliverable:** build a town centre, train villagers, build houses, raise the pop cap.

At this point there is a real economic game loop. **This is the first milestone worth
showing anyone.**

---

### Phase 6 — Combat

**Goal:** units fight and die.

1. Attributes (HP) and death (remove entity, spawn rubble/corpse).
2. **Simplified effect/resistance** per `SYSTEMS.md` §7 — attack types vs armour types,
   `max(1, attack[t] - armor[t])`. Adopt the spec's *structure*, not its full generality
   (skip batches, chaining, hyperbolic stacking).
3. Melee first: approach → cooldown → apply damage.
4. Target acquisition within radius via the spatial grid.
5. **Stances** — aggressive / defensive / stand-ground / no-attack. Implement early but
   with a **tight leash radius**; runaway chasing is a classic frustration bug.
6. Projectiles as entities: spawn, travel, resolve on arrival, with accuracy and leading.
7. Health bars (PixiJS, world-space).

**Deliverable:** armies fight.

**Warning:** this phase generates more emergent bugs than any other. Auto-acquisition,
retargeting, and stance interactions produce the "weird dance" behaviour Ry describes in
the talk's Q&A — a knight picks a target, gets blocked, the target moves, repeat. Budget
debugging time, and build a combat-event log early.

---

### Phase 7 — Tech, ages, and civilizations

**Goal:** progression and asymmetry.

**Nearly free if Phase 0 item 4 was done.** A refactor if it wasn't.

1. Patch application against `PlayerDataView`.
2. Tech DAG with prerequisites; `researched: Set<string>` per player.
3. Age advancement as a gating tech.
4. **Civilizations as named patch lists** — per `SYSTEMS.md` §8, civs and techs are the
   same mechanism. A Qatari civ becomes a JSON file, not code.
5. Tech tree UI (DOM grid).

**Deliverable:** research upgrades, advance ages, play asymmetric civs.

**This is the highest-leverage phase for the project's content goals.** It's where
*Kingdoms of Qatar* stops being a generic RTS.

---

### Phase 8 — Save/load, audio, polish

**Goal:** a game people can actually play across sessions.

1. **Save/load** — `JSON.stringify` of world + players + RNG seed + time; IndexedDB;
   gzip via `CompressionStream`. If this is hard, Phase 0 discipline leaked and we should
   find out now — it's a canary as much as a feature (`SYSTEMS.md` §11).
2. **Audio** — Web Audio/Howler; category gain nodes; preload short effects, stream music;
   **handle the autoplay policy at a click-to-start screen**; voice-spam cooldowns;
   distance culling (`SYSTEMS.md` §15).
3. **Minimap** — a canvas redrawn at a few Hz.
4. **Full HUD** — DOM, with `pointer-events` click-through handled once and properly.
5. **Localization pass** — populate `ar.json`; verify RTL layout, Noto Sans Arabic, and
   bidi in mixed strings. **Test this properly**; it's the phase where DOM-UI pays off.

---

### Phase 9 — AI opponent

**Goal:** something to play against.

Per `SYSTEMS.md` §9 — scripted build order + reactive rules, roughly 500 lines:

1. Build order as JSON, executed against affordability.
2. Economy: villager reassignment toward target resource ratios.
3. Military: accumulate to threshold → attack-move → retreat below threshold.
4. Difficulty via reaction delay and resource multipliers.

**Non-negotiable:** the AI issues **the same commands a player issues**, through the same
command queue. No direct state mutation, no special-casing. This keeps it honest and
debuggable, and it makes it automatically compatible with everything added later.

Also: an AI enables the **fuzz harness** from `PATHFINDING_NOTES.md` §7.3 — headless
matches at maximum speed harvesting pathfinding failures. That's a second, large payoff
from this phase.

---

### Phase 10 — Deferred indefinitely

Listed so they're never silently assumed into a schedule.

| System | Status | Note |
| --- | --- | --- |
| **Networking** | Deferred | Hardest thing in the project. If ever pursued, prefer **server-authoritative with interest management** over lockstep (`SYSTEMS.md` §12) — no determinism requirement, and it's what openage's own goal architecture targets. |
| **Deterministic sim** | Deferred, reversible | Only needed for lockstep. Phase 0 item 2 keeps the door open. |
| **Elevation** | Deferred | Roughly triples terrain complexity for modest visual gain (`SYSTEMS.md` §13). |
| **Flow-field pathfinding** | Deferred | Only if profiling demands it (Phase 3). |
| **Random map generation** | Deferred | Symmetric fairness is a real problem; hand-authored JSON maps first. |
| **Campaigns / scenario editor** | Deferred | No reference implementation exists in openage either. |
| **Formations** | Deferred | Interacts badly with soft collision; needs design thought. |

---

## 4. Justification of the order

**Why not start with pathfinding, the hardest system?** Because "port the hard thing first"
assumes the hard thing's requirements are known. They aren't. `PATHFINDING_NOTES.md` shows
a team spending 25 years on this in a codebase where the movement model was already fixed.
We get to choose the movement model, and that choice (§7.1) determines what pathfinding
even has to do. Choosing it before we have units moving on screen would be guessing.

**Why economy (Phase 4) before combat (Phase 6)?** Three reasons: it's easier, it has no
dependency on combat, and it produces the first genuine gameplay loop. An RTS with economy
and no combat is a city builder — playable. An RTS with combat and no economy is a skirmish
demo with nothing to do.

**Why tech (Phase 7) so late, when Phase 0 sets it up?** The *mechanism* is built in Phase
0 because retrofitting it is expensive. The *content* comes late because tech is only
meaningful once there are stats worth upgrading — which requires economy and combat to
exist.

**Why AI last?** It consumes every other system. Building it earlier means rebuilding it
each time a system lands.

**Why rendering (Phase 1) before entities (Phase 2)?** Purely for debuggability. Every
subsequent phase is easier when you can see the world.

---

## 5. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Simulation/render coupling creeps in | **High** | Lint rule banning PixiJS imports in `sim/`; save/load as a canary (Phase 8) |
| Stats cached at spawn, breaking tech | **High** | Phase 0 item 4; every read through `player.data.get()` |
| Object references in state, breaking save | **High** | Phase 0 item 3; numeric IDs only |
| Event-driven sim becomes undebuggable | **High** | Build queue inspector + timeline view **in Phase 0–3**, not later (`SYSTEMS.md` §2) |
| Atlas sprawl kills frame rate | Medium | Atlas discipline from Phase 1 |
| Combat auto-acquisition bug swamp | Medium | Tight leash radius; combat event log; Phase 6 buffer |
| Curves adopted too broadly | Medium | Use for position only, if at all (`SYSTEMS.md` §3) |
| Arabic/RTL retrofit | Medium | `t()` and CSS logical properties from Phase 0 |
| Pathfinding rewritten late | Medium | Two-tier structure + validation harness from Phase 3 |
| **Content design underestimated** | **High** | Start historical research in parallel with Phase 0 — see `DATA_INVENTORY.md` §5.5 |

That last row deserves emphasis. Everything in this document is engineering sequencing, and
engineering is the part we can plan. But the schema will accept whatever numbers we give
it, and what will make *Kingdoms of Qatar* worth playing is a Qatari civilization set that
is both historically defensible and mechanically interesting. That research should start
now, in parallel, not after Phase 7.

---

## 6. First system to port

**Recommendation: the coordinate system and time module (Phase 0, items 6–7), immediately
followed by terrain rendering (Phase 1).**

Reasoning is in §7 of the chat summary, but briefly: coordinates are the true foundation
(every other system speaks in them), they're self-contained and fully testable without any
other system, openage has them documented and correct so we're copying rather than
inventing, and getting them wrong poisons everything downstream in ways that surface late
and cost days. It's a small, unglamorous, high-certainty first win — and it unblocks the
visual feedback loop that makes every subsequent phase tractable.
