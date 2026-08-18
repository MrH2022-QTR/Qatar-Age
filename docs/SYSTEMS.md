# SYSTEMS — Per-System Detail and Port Notes

**Companion to `ARCHITECTURE.md`.** One section per system, each with: what it does, key
files, key data structures, key algorithms, dependencies, and port notes for
**TypeScript + PixiJS v8 + miniplex** in the browser.

**Source provenance:** analysis was performed against the working tree (master, shortly
after tag `v0.6.0`). The uploaded `openage_v0.6.0_release_source_code.zip` (commit
`8488314`) was diffed against it: the two are substantively identical for architectural
purposes — same 5 API components, same 4 systems, same flow-field pathfinder. The working
tree adds ~1,600 lines, of which the only engine-relevant changes are
`libopenage/pathfinding/field_cache.{cpp,h}` (path memoisation),
`libopenage/renderer/resources/shader_template.{cpp,h}`, and a reorganisation of the curve
containers into `libopenage/curve/container/`. Every conclusion in these documents holds
for both trees. Paths below refer to the working tree; for the v0.6.0 zip, substitute
`libopenage/curve/queue.h` for `libopenage/curve/container/queue.h` and note that
`field_cache` does not exist there.

A recurring theme in the port notes: **openage's hardest problems are not your hardest
problems.** Much of its complexity exists to serve determinism for future lockstep-free
multiplayer, to interoperate with 1999 binary file formats, and to run across three
threads in C++. A single-player browser game inherits none of that. Where openage chose a
sophisticated solution for a constraint you don't have, I say so.

---

## 1. Rendering / Graphics

### What it does
Draws the isometric game world: terrain chunks, animated unit/building sprites, HUD
overlays, skybox, and the final screen composite. It is a two-level architecture — a
backend-agnostic GPU resource abstraction underneath, and a set of high-level "render
stages" on top, each responsible for one visual category.

### Key files
- `libopenage/renderer/renderer.h` — the abstract backend interface
- `libopenage/renderer/opengl/` (4,295 lines) — the working OpenGL backend
- `libopenage/renderer/vulkan/` (1,239 lines) — **a stub, not a functioning backend**
- `libopenage/renderer/stages/terrain/`, `world/`, `hud/`, `skybox/`, `screen/`
- `libopenage/renderer/stages/render_entity.h` — the simulation↔renderer seam
- `libopenage/renderer/camera/camera.h`, `frustum_*.h` — camera and culling
- `libopenage/renderer/resources/` (5,763 lines) — textures, meshes, animation defs, parsers
- `libopenage/renderer/resources/frame_timing.h` — animation frame selection
- `libopenage/renderer/render_pass.h`, `renderable.h`, `uniform_buffer.h`
- `assets/shaders/*.glsl` — 67 shader files
- `doc/code/renderer/level1.md`, `level2.md` — genuinely good docs

### Key data structures
| Structure | Purpose |
| --- | --- |
| `Renderer` | Abstract GPU backend; creates textures, shaders, passes |
| `RenderPass` | A render target plus an ordered list of `Renderable`s |
| `Renderable` | One draw: geometry + shader + uniform inputs |
| `ShaderProgram` / `UniformInput` / `UniformBuffer` | Shader binding and parameters |
| `Texture2d` / `Texture2dArray` / `TextureInfo` / `TextureSubInfo` | Image data and sub-rects within an atlas |
| `RenderStage` (per stage dir) | Owns one pass and the objects drawn in it |
| `RenderEntity` | Per-object mirror of simulation state, dirty-flagged |
| `WorldObject` / `TerrainChunk` (renderer-side) | Per-stage drawable holding mesh + uniforms |
| `Animation` / `LayerInfo` / `AngleInfo` / `FrameInfo` | Parsed `.sprite` animation model |
| `Camera` | View/projection matrices, zoom, viewport |

### Key algorithms
- **Isometric projection.** World coordinates are NE/SE/UP, not X/Y/Z. The renderer
  converts via `Eigen(x, y, z) = (SE, UP / sqrt(8), -NE)`
  (`doc/code/coordinate-systems.md`). The `sqrt(8)` is the dimetric foreshortening that
  gives AoE2's 2:1 tile look.
- **Render-entity double buffering.** The simulation writes updates into a render entity
  under a lock and sets a dirty flag; the render thread reads and clears it. This is the
  only synchronisation between simulation and rendering, and it is why the two can run at
  totally independent rates.
- **Animation frame selection.** `frame_timing.h` picks a frame from *real* elapsed time
  (not simulation time — deliberately, so animations don't slow down when the game is
  slowed), given a `.sprite` definition's layer/angle/frame table.
- **Angle-based sprite selection.** A unit's facing angle selects one of N angle buckets
  (typically 8 or 16), each with its own frame sequence — and mirroring flags let the
  format store only half the angles.
- **Frustum culling** (`camera/frustum_2d.h`, `frustum_3d.h`) before submitting drawables.
- **Depth sorting** for isometric overlap correctness.

### Dependencies
**Calls:** Qt6 (window, GL context, event handling), OpenGL, Eigen, `coord/`, `util/`,
`assets/` (asset lookup). **Called by:** `presenter/presenter.cpp`, which owns the render
thread; and indirectly by `gamestate` through `RenderFactory` → `RenderEntity`.

### Port notes — TypeScript + PixiJS v8

**This system you should not port. You should delete it and use PixiJS.**

That sounds glib, but it is the single biggest saving in the whole project. Roughly 26,000
lines — 15% of the entire codebase and by far its largest subsystem — exists to do what
PixiJS gives you as a library: batched sprite rendering, texture atlases, shader
management, render targets, and a scene graph. Do not port `renderer/opengl/`, do not port
the Vulkan stub, do not port `render_pass`/`renderable`/`uniform_buffer`.

**What to keep — three ideas, not the code:**

1. **The render-entity pattern.** Keep this even though you're single-threaded, because
   it enforces the discipline that gameplay never touches display objects. In miniplex
   terms: a `Sprite` component holding a PixiJS `Sprite` reference, updated by one
   dedicated render system that reads simulation components and writes display properties.
   The payoff is that your simulation stays headless-testable — you can run the whole game
   with no PixiJS at all, which is enormously valuable for testing.
2. **Render stages as separate PixiJS `Container`s.** Terrain container → world container
   → HUD container, in that z-order. Trivial in PixiJS, and it keeps the same clean
   separation.
3. **The isometric transform.** Steal the math directly, including the `sqrt(8)`. Getting
   isometric projection subtly wrong is a classic time sink and openage has it right.

**Easy in the browser:** sprite batching (PixiJS v8's renderer batches automatically and
is genuinely fast — tens of thousands of sprites), texture atlases (`Assets` + spritesheet
JSON), camera (just a `Container` transform), zoom, tinting for player colours.

**Harder than it looks:**
- **Depth sorting.** Isometric overlap needs per-sprite depth. PixiJS v8 removed the old
  `zIndex`-sorting plugin behaviour people relied on; you will want `sortableChildren` on
  the world container with `zIndex` set from `(NE + SE)`, and you should benchmark it —
  sorting thousands of sprites per frame is a real cost. Consider bucketing by tile row
  instead of a full sort.
- **Player colour remapping.** AoE2 does this with palette index swapping
  (`assets/shaders/teamcolors.frag.glsl` in openage). WebGL has no palettes. You need
  either a small fragment shader that maps a mask channel to a player colour (PixiJS v8
  custom `Filter` or a custom shader on a `Mesh`), or pre-generated per-player atlases.
  The shader is the right answer; budget a day for it.
- **Sprite count.** An AoE2-scale battle is 200+ animated units. Fine for PixiJS, but only
  if every sprite comes from one atlas so batching isn't broken. Atlas discipline matters
  more than anything else for your frame rate.

**Different approach needed:** openage's terrain is chunked 3D meshes with elevation and
blend masks. For a browser port I would strongly recommend **starting flat** — no
elevation — and rendering terrain as a tilemap. Elevation in an isometric renderer means
per-vertex terrain meshes, slope-aware tile transitions, and depth-sorting units against
terrain. It roughly triples terrain complexity for a visual refinement most players won't
consciously notice in a first release. Add it later or never.

---

## 2. Game Simulation Loop

### What it does
Advances the game world. Uniquely among RTS engines I've read, **it has no tick and no
fixed timestep.** It repeatedly asks a clock for the current time and instructs an event
loop to execute everything scheduled up to that moment.

### Key files
- `libopenage/gamestate/simulation.cpp:45-52` — the entire loop, six lines
- `libopenage/gamestate/simulation.h` — `GameSimulation`
- `libopenage/gamestate/game.h` / `game.cpp` — one session
- `libopenage/gamestate/game_state.h` — the state container
- `libopenage/time/time_loop.cpp` — the clock thread
- `libopenage/time/clock.h` — simulation speed, real vs simulation time
- `libopenage/time/time.h` — `time::time_t`
- `libopenage/engine/engine.cpp` — thread setup
- `doc/code/time.md`, `doc/code/architecture.md`

### Key data structures
| Structure | Purpose |
| --- | --- |
| `GameSimulation` | Owns event loop, factories, mod manager, spawner, commander |
| `Game` | One game session; owns `GameState` |
| `GameState : event::State` | Entity map, player map, `Map` ref, nyan DB view |
| `Clock` | Simulation time, real time, speed multiplier (can be negative) |
| `TimeLoop` | Thread that advances `Clock` |
| `time::time_t` | 64-bit fixed-point seconds, 16-bit fraction |

### Key algorithms
- **The loop:** `while (running) { t = clock->get_time(); event_loop->reach_time(t, state); }`
- **Clock advance:** real delta × speed, clamped to [1 ms, 50 ms] per update. The 50 ms
  ceiling prevents a debugger pause from fast-forwarding the game; the 1 ms floor prevents
  the thread spinning.
- **Threading:** three threads — time loop, presenter (optional), simulation (main).
  `mode::HEADLESS` omits the presenter entirely.

### Dependencies
**Calls:** `event/`, `time/`, `assets/` (mod manager), `gamestate/` factories.
**Called by:** `engine/engine.cpp`. **Notifies:** `renderer/` via `RenderFactory`.

### Port notes

**Easy:** you get a free simplification. The browser gives you `requestAnimationFrame`,
you are single-threaded, and openage's entire three-thread dance collapses into one loop.

```ts
let simTime = 0                       // seconds, float
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05)   // keep openage's 50ms clamp
  simTime += dt * speed
  eventLoop.reachTime(simTime, state)              // simulation
  renderSystem.update(simTime)                     // display sync
  app.render()
  last = now
  requestAnimationFrame(frame)
}
```

Keep the 50 ms clamp — in a browser it matters *more* than in a native app, because
backgrounded tabs throttle `requestAnimationFrame` and you will otherwise get a
multi-second delta when the user tabs back and the entire game will lurch.

**The real decision: keep the event-driven model, or go fixed-tick?**

My recommendation: **keep it, with one pragmatic exception.** The event model's payoff is
enormous for an RTS — a unit walking for 8 seconds costs you *zero* CPU during those 8
seconds, versus 480 update calls at 60 Hz. With hundreds of units mostly idle or
executing long actions, this is the difference between a smooth browser game and a
struggling one. Combat, however, is naturally periodic (attack every N seconds), and
forcing it through event rescheduling is more awkward than a simple repeating event —
which openage's `REPEAT` trigger type already supports.

**Hard:** the debugging experience. A fixed-tick loop is trivially inspectable — you can
log every tick. An event-driven simulation with time-warping requires you to build
tooling: an event-queue inspector, a timeline visualiser, the ability to dump all
scheduled events. **Budget for this from day one**; it is not optional, and retrofitting
it is painful.

**Different approach:** use plain `number` (float seconds), *not* fixed-point, unless and
until you want deterministic multiplayer. Fixed-point in TypeScript means either BigInt
(slow) or manual integer scaling (error-prone, invasive). Since your near-term target is
single-player, take floats and keep the option open by isolating all time arithmetic
behind a small `Time` module — so that if you ever need determinism, you change one file
rather than three hundred call sites.

---

## 3. Entity Model

### What it does
Represents every physical object in the world — units, buildings, trees, resource piles,
projectiles, decoration — as a single `GameEntity` type whose capabilities are determined
entirely by which components are attached to it.

### Key files
- `libopenage/gamestate/game_entity.h` / `.cpp`
- `libopenage/gamestate/component/types.h` — the component enum (9 types)
- `libopenage/gamestate/component/api/` — `idle`, `live`, `move`, `selectable`, `turn`
- `libopenage/gamestate/component/internal/` — `position`, `command_queue`, `ownership`, `activity`
- `libopenage/gamestate/component/internal/commands/` — command objects
- `libopenage/gamestate/system/` — `idle.cpp`, `move.cpp`, `activity.cpp`, `types.h`
- `libopenage/gamestate/activity/` — the behaviour-graph node types
- `libopenage/gamestate/manager.h` — `GameEntityManager`
- `libopenage/gamestate/entity_factory.cpp` — construction from nyan
- `doc/code/game_simulation/game_entity.md`, `components.md`, `activity.md`, `systems.md`

### Key data structures
| Structure | Purpose |
| --- | --- |
| `GameEntity` | ID + `unordered_map<component_t, shared_ptr<Component>>` + render entity + manager |
| `Component` (abstract) | Base; splits into `APIComponent` (nyan-backed) and `InternalComponent` |
| `Position` | `Continuous<phys3>` positions + `Segmented<angle>` angles |
| `CommandQueue` | `curve::Queue<shared_ptr<Command>>` — a *time-aware* queue |
| `Ownership` | `Discrete<player_id_t>` — owner over time (so conversion is a keyframe) |
| `Activity` | Reference to the behaviour graph + last visited node |
| `Live` | Attribute values (HP etc.) on curves |
| `Move`, `Turn`, `Idle`, `Selectable` | nyan ability refs + any runtime state |
| `Activity` graph nodes | `StartNode`, `EndNode`, `TaskNode`, `TaskSystemNode`, `XorGate`, `XorEventGate` |
| `GameEntityManager` | Routes events to the entity, advances its activity graph |

### Key algorithms
- **Composition over inheritance.** No Unit/Building class hierarchy. A building is an
  entity without a `Move` component. Systems check `has_component()` before acting —
  see `move.cpp:99`.
- **Two-tier data.** Immutable stats live in nyan and are only referenced; mutable state
  lives on curves in the component. A unit's max HP is a nyan lookup; its current HP is a
  curve query at time `t`.
- **Activity graphs.** Behaviour is a directed graph walked per entity. `XorGate` branches
  immediately on a predicate; `XorEventGate` *suspends* until one of several events fires,
  then branches on which fired. The canonical loop
  (`entity_factory.cpp:47-105`) is: Start → Idle → is-moveable? → command-queued? →
  wait-for-command → Move → wait-for-arrival → back to Idle.
- **Stateless systems.** Systems are static functions taking `(entity, state, time)` and
  returning a duration. Any state they need must live in a component.

### Dependencies
**Calls:** `curve/`, `event/`, `pathfinding/` (from the move system), nyan, `coord/`.
**Called by:** the event loop, via `GameEntityManager`.

### Port notes — miniplex

**This is the section where you must be most careful, because the names lie.**

openage says "component" and "system" but it is *not* a data-oriented ECS, and its own
documentation admits this (`game_entity.md`: *"you shouldn't think of the openage game
simulation as a traditional ECS-driven architecture"*). Its entities are hash maps of
polymorphic heap objects, and its systems are invoked *per entity* by that entity's
behaviour graph — never as a query over a component array.

miniplex is a real ECS: entities are plain objects, and you write
`world.with("position", "movement")` to get an archetype-bucketed iterable. **You cannot
transplant openage's model onto miniplex; you have to make a decision.**

My recommendation, and I think this is the most consequential architectural call in the
whole port:

**Take openage's *data* model. Reject its *control-flow* model — mostly.**

- **Data:** miniplex components as plain objects — `{ position, movement, health, owner,
  selectable, sprite }`. This maps cleanly and is where miniplex shines. Keep openage's
  two-tier split: a `type` component holding a reference into your static data (the
  "nyan" equivalent), plus separate components holding mutable runtime state. This is
  genuinely good design and it makes tech upgrades tractable (see §8).
- **Control flow:** for most behaviour, use ordinary miniplex queries.
  `for (const e of world.with("position", "moveTarget"))` is idiomatic, fast, and
  debuggable. Do *not* build a general behaviour-graph interpreter to start.
- **The exception:** RTS units genuinely do need something like a state machine —
  "gather until full, then walk to drop-off, deposit, walk back, repeat, unless
  interrupted by an attack command." Trying to express that in flat queries produces a
  tangle of boolean flags. So keep a small `state` component (a discriminated union:
  `{kind: 'idle'} | {kind: 'moving', path} | {kind: 'gathering', target, until}`) and one
  system that switches on it. That is 90% of openage's activity graph value at 5% of its
  complexity. If you later need designer-authored behaviour, *then* build the graph
  interpreter.

**Easy:** components as plain TS objects; archetype queries; adding/removing components to
change capability (miniplex handles reindexing).

**Hard — the honest warning:** **curves.** openage's components store *timelines*, not
values. `Position` is not a point, it is a `Continuous<phys3>`. If you adopt curves, then
every miniplex component holding simulation state becomes a keyframe container, and every
read becomes `curve.get(t)` rather than a property access. That is a significant tax on
ergonomics, memory, and — importantly — on miniplex's archetype model, which assumes
components are cheap plain data.

**My recommendation: do not adopt curves wholesale.** Use them surgically, for position
only, where the payoff (free interpolation between path waypoints, no per-frame movement
integration) is largest and the implementation is simplest. Store everything else — HP,
resources, owner — as plain mutable values. You lose time-travel and cheap rollback; you
were not going to build those in v1 anyway. Revisit if and when you do multiplayer.

**Different approach:** openage's `Component` is a polymorphic C++ class with virtual
dispatch. In TypeScript, prefer plain data objects and free functions. Do not build a
`Component` base class; you will get nothing from it and pay in indirection.

---

## 4. Pathfinding and Movement

### What it does
Finds routes across the map and converts them into motion. Pathfinding is a complete,
working, hierarchical **flow-field** implementation. Movement is a thin system that turns
waypoints into position keyframes.

### Key files
- `libopenage/pathfinding/pathfinder.cpp` / `.h` — entry point, two-phase search
- `libopenage/pathfinding/grid.h`, `sector.h`, `portal.h` — spatial hierarchy
- `libopenage/pathfinding/cost_field.h` — per-cell movement cost
- `libopenage/pathfinding/integration_field.h` — wavefront cost accumulation
- `libopenage/pathfinding/flow_field.h` — direction vectors
- `libopenage/pathfinding/integrator.cpp` — builds integration + flow fields
- `libopenage/pathfinding/field_cache.h` — memoisation (**not present in the v0.6.0 zip**)
- `libopenage/pathfinding/definitions.h`, `types.h` — constants and packed cell types
- `libopenage/pathfinding/legacy/a_star.cpp` — the old A*, no longer on the live path
- `libopenage/gamestate/system/move.cpp` — **movement lives here, not in pathfinding/**
- `doc/code/pathfinding/README.md`, `field_types.md`

### Key data structures
| Structure | Purpose |
| --- | --- |
| `Grid` | One per movement type (land, water, air); holds sectors |
| `Sector` | Square block of cells; owns a `CostField` |
| `CostField` | `uint8_t` per cell: 1 = cheap … 254 = expensive, 255 = impassable |
| `IntegrationField` | `uint16_t` accumulated cost to target; 65535 = unreachable; plus flags |
| `FlowField` | `uint8_t` per cell packing 8-way direction + target/LOS/pathable flags |
| `Portal` | Contiguous passable run along a sector edge; knows reachable portals |
| `PortalNode` | A* node over the portal graph |
| `PathRequest` / `Path` | `{grid, start, target, time}` → `{status, waypoints}` |
| `FieldCache` | `(portal_id, sector_id)` → cached `(integration, flow)` pair |

### Key algorithms
- **Two-phase hierarchical search** (`pathfinder.cpp`):
  1. A* over the **portal graph** to select the sequence of sectors to traverse.
  2. Per selected sector, build the integration + flow fields and follow the vectors.
  This is what makes it scale — the expensive per-cell work happens only in the handful of
  sectors the route crosses, not across the whole map.
- **Wavefront integration.** From the target cell(s), propagate outward; each cell's value
  is its own cost plus the minimum integrated value of its four cardinal neighbours. The
  target is 0.
- **Flow field derivation.** Each cell points at its cheapest neighbour; direction is
  quantised to 8 compass values and packed into 4 bits alongside flags.
- **Line-of-sight optimisation.** Cells with clear LOS to the target are flagged so units
  can beeline instead of following the field cell-by-cell — this is what stops flow-field
  movement looking robotic.
- **Field caching.** Because flow fields are computed *toward a target*, many units
  sharing a destination reuse one field. This is the central efficiency argument for flow
  fields over per-unit A* in RTS games.
- **Movement** (`move.cpp:95-187`): call pathfinder once → walk waypoints → for each leg,
  optionally insert a turn-delay keyframe (`angle_diff / turn_speed`), then a
  position keyframe at `start_time + accumulated_time`. Return total duration. **All of a
  unit's motion is computed at command time.**

### Dependencies
**Calls:** `coord/` only — deliberately decoupled from terrain.
**Called by:** `gamestate/system/move.cpp` via `Map::get_pathfinder()`.

### Port notes

**This is the hardest system in the port. Plan accordingly.**

> **See also `PATHFINDING_NOTES.md`** — analysis of a Meeting C++ 2025 talk by the
> Engineering Director at Forgotten Empires (the studio shipping the official AoE
> Definitive Editions) on 25 years of pathfinding bugs in the *real* AoE2 codebase. It
> corroborates and sharpens the recommendations below, and adds three: **simplify the
> movement model up front** (allow soft collision — his own answer to "what would you do
> from scratch"), **make the pathfinder self-verifying and fuzz it from day one**, and
> **adopt the coarse-then-fine two-tier structure immediately**. That document supersedes
> this section where the two differ.

**What's genuinely hard:**
- Flow fields are a lot of machinery: cost fields, integration fields, flow fields, portal
  graphs, portal-graph A*, and a cache. Porting faithfully is a multi-week job even with
  openage's implementation as a reference.
- The packed-bitfield representations (`flow_t`, `integrated_t`) are C++ idioms.
  TypeScript can do this with `Uint8Array`/`Uint16Array` and bit twiddling — and you
  *should*, because typed arrays are where JS performance actually lives — but it's fiddly
  and needs tests.
- **Dynamic obstacles.** Buildings appear and units block. Cost fields must be updated and
  affected cached fields invalidated. openage has a `TODO: Cost stamps` comment in
  `types.h` — meaning they haven't fully solved this either. Do not assume the reference
  implementation covers it.

**Strong recommendation: do not start here.** Ship **A\* on a flat grid** first. For maps
up to ~200×200 with a binary passable/impassable grid, a decent binary-heap A* with a
Manhattan/octile heuristic runs in well under a millisecond and will carry you through the
entire early game. openage itself kept A* around (`pathfinding/legacy/`) and it served the
project for years. Flow fields become worth it when you have 100+ units moving to the same
destination — which is a *late* problem, not an early one.

When you do need flow fields, port them **incrementally and in this order**: cost field →
integration field → flow field on a *single* sector covering the whole map (skip the
hierarchy entirely). A single-sector flow field is maybe 200 lines and already gives you
the big win: N units sharing a destination share one field. Add sectors and the portal
graph only when map size makes whole-map integration too slow.

**Easy:** the cost field itself — a `Uint8Array` over the tile grid, same semantics
(1–254 passable, 255 blocked). Adopt openage's exact encoding; it's well chosen.

**Different approach — movement:** openage bakes the entire journey into position
keyframes up front. In a browser single-player game, I'd instead keep a `path: Point[]` +
`pathIndex` component and advance position each frame in a movement system. Reasons: it's
far easier to debug, it handles interruption naturally (a new command just replaces the
path), and it avoids the curve tax discussed in §3. The keyframe approach's advantage is
network synchronisation, which you don't have yet. **But do steal the turn-delay
modelling** — inserting a rotation pause before each leg is exactly what makes AoE2 units
feel weighty rather than gliding, and it's ten lines of code.

---

## 5. Resource System

### What it does
**In this codebase: nothing.** There is no resource implementation. `Player`
(`gamestate/player.h`) contains exactly two fields — an ID and a nyan database view. It
holds no stockpile. Nothing gathers, stores, deposits, or spends.

What exists is a complete **specification** with no runtime behind it.

### Key files
Specification only:
- `doc/nyan/api_reference/reference_ability.md` — `Gather`, `Harvestable`, `DropResources`,
  `DropSite`, `ResourceStorage`, `ExchangeResources`, `Restock`,
  `RegenerateResourceSpot`, `Trade`, `TradePost`
- `doc/nyan/api_reference/reference_util.md` — `util.resource.*`, `util.cost.ResourceCost`,
  `util.cost.AttributeCost`, `util.exchange_rate.*`, `util.exchange_mode.*`
- `openage/convert/processor/conversion/aoc/ability_subprocessor.py` — emits all of it
- `openage/convert/service/read/nyan_api_loader.py` — defines the resource types
- `libopenage/gamestate/player.h` — the empty shell where this would live

### Key data structures
Specified but unimplemented: a resource type registry; per-player `ResourceStorage` with
per-resource capacity; `ResourceSpot` on harvestable entities with an amount and a
depletion rule; `ResourceCost` as a list of `(resource, amount)` pairs;
`ExchangeRate` for market mechanics.

### Key algorithms
Per the spec (not the code): a gatherer with a `Gather` ability targets an entity with
`Harvestable`, transfers at a rate into its own `ResourceStorage` up to capacity, then
seeks the nearest entity with `DropSite` for that resource type and deposits into the
player stockpile. Farms use `Restock`. Markets use `ExchangeResources` with an
`ExchangeRate` that shifts with trade volume.

### Dependencies
Would depend on: entity components, pathfinding (walking to and from), the event system
(gather ticks), and the tech system (gather-rate upgrades).

### Port notes

**This is the easiest major gameplay system to build, and it is where I'd start
gameplay** (see `PORT_PLAN.md`).

Because there is nothing to port, you are designing fresh against a good spec — which is
faster than porting. A workable model:

```ts
type ResourceKind = 'food' | 'wood' | 'stone' | 'gold'          // or pearls/dates/fish...
type Stockpile = Record<ResourceKind, number>

// components
{ stockpile: Stockpile }                                         // on player entity
{ carrying: { kind: ResourceKind, amount: number }, capacity: number }   // on gatherer
{ resourceSpot: { kind: ResourceKind, remaining: number } }      // on tree/mine/farm
{ dropSite: ResourceKind[] }                                     // on town centre/mill
```

**Easy:** stockpile arithmetic, cost checking (`canAfford`), deduction, capacity limits,
depletion. This is a few hundred lines and no algorithmic difficulty.

**Moderately hard:** the gather *loop* — approach → gather until full → find nearest
drop-site → deposit → return to the same spot → repeat, with graceful handling of the
resource depleting mid-loop. This is exactly the case where a `state` discriminated union
(per §3) earns its keep. Note "find nearest drop-site" needs a spatial query; a simple
grid bucket is plenty.

**Watch out for:** the classic AoE2 subtleties that make it feel right — gatherers
carrying a partial load when reassigned, drop-site distance mattering enough that players
place mills deliberately, and per-resource gather rates. These are balance details, but
they're what makes the economy a *game* rather than a spreadsheet. Get the loop working,
then tune.

**Qatari content note:** this system is where your theming will be most visible. The
four-resource model is not sacred — pearls, dates, fish, and livestock map naturally onto
historical Qatari coastal economy, and pearl diving in particular suggests a gather
mechanic with genuinely different rhythm (boats, dive duration, risk) than chopping wood.
That's a design opportunity the spec accommodates: `Gather` is generic over resource type.

---

## 6. Building Placement and Construction

### What it does
**Not implemented.** Specified only.

### Key files
Specification only:
- `doc/nyan/api_reference/reference_ability.md` — `Foundation`, `Constructable`, `Create`,
  `ProductionQueue`, `RallyPoint`, `TerrainRequirement`, `OverlayTerrain`
- `doc/nyan/api_reference/reference_util.md` — `util.create.CreatableGameEntity`,
  `util.construct.*`, `util.placement_mode.*`
- `openage/convert/processor/conversion/aoc/auxiliary_subprocessor.py` — emits creatables
- `libopenage/gamestate/terrain.h` — where placement validation would query

Note there is **no distinction between units and buildings at runtime** — both are
`GameEntity`. A building is simply an entity with no `Move` component.

### Key data structures
Specified: `Foundation` (the pre-construction footprint), `Constructable` (progress state
and completion effects), `CreatableGameEntity` (what a building can produce, with costs
and build time), `ProductionQueue`, `RallyPoint`, `PlacementMode` (how the ghost snaps).

### Key algorithms
Per spec: validate a candidate footprint against terrain type
(`TerrainRequirement`), map bounds, and overlap with existing entities; on commit,
deduct cost and spawn a foundation entity; villagers with a construct ability apply
progress over time; at 100% the foundation transforms into the finished building
(`ability.type.PassiveTransformTo`).

### Dependencies
Would depend on: terrain, resources (cost), entity factory (spawning), pathfinding
(footprint must stamp cost into the grid), and input/UI (the placement ghost).

### Port notes

**Easy, and satisfying to build early — it makes the game feel real fast.**

- **Placement validation:** iterate the footprint tiles, check `terrainType` is allowed,
  check bounds, check an occupancy grid. A `Uint8Array` occupancy grid over tiles makes
  this O(footprint) and trivial.
- **The ghost:** a semi-transparent PixiJS sprite following the cursor, tinted green/red
  by validity. Pure presentation; ~50 lines.
- **Construction progress:** one number, 0→1. With the event model, schedule a completion
  event; with a tick model, increment. Either is fine.
- **Grid snapping:** convert mouse position → world → tile, then floor. You'll already
  have this from selection.

**The one thing to get right early: stamping the footprint into the pathfinding cost
grid on completion, and clearing it on destruction.** This is the coupling between
buildings and pathfinding, and if you leave it until later you will find units walking
through your buildings and then discover the fix touches path caching. Build it in from
the start.

**Different approach:** openage models the foundation→building transition as a nyan
`PassiveTransformTo` — an entity type change. In miniplex, just mutate components: remove
`underConstruction`, add `completed`, swap the sprite. Much simpler; no transformation
machinery needed.

---

## 7. Combat Resolution

### What it does
**Not implemented in C++ at all.** I grepped the entire `libopenage/gamestate/` tree for
`attack`, `combat`, `damage`, `effect`, and `resistance`; the only match is an unrelated
identifier in `gamestate/event/spawn_entity.h`.

The *specification*, however, is the most valuable single artifact in this repository for
your project, and I'd urge you to read it before designing your own combat.

### Key files
Specification only — but read these:
- `doc/nyan/api_reference/reference_effect.md` (403 lines) — what an attack *does*
- `doc/nyan/api_reference/reference_resistance.md` (340 lines) — what a target *resists*
- `doc/nyan/api_reference/reference_ability.md` — `ApplyDiscreteEffect`,
  `ApplyContinuousEffect`, `ShootProjectile`, `Projectile`, `Resistance`,
  `ability.property.type.Ranged`, `GameEntityStance`
- `doc/nyan/api_reference/reference_util.md` — `util.attribute.*`, `util.accuracy.*`,
  `util.dropoff_type.*`, `util.calculation_type.*`, `util.effect_batch.*`
- `openage/convert/processor/conversion/aoc/effect_subprocessor.py` (981 lines) — the
  translation of AoE2's actual armour-class system into this model
- `doc/reverse_engineering/game_mechanics/` — notes on the original's behaviour

### Key data structures
Specified: `Attribute` (HP and similar); `FlatAttributeChange` (discrete damage, with an
attack *type* — the armour-class mechanism); `Resistance` objects paired to effect types;
`Accuracy` (hit chance, with dispersion); `DropoffType` (damage falloff over distance —
`Linear`, `InverseLinear`, `NoDropoff`); `CalculationType` (`Linear`, `Hyperbolic`,
`NoStack` — how multiple modifiers combine); `EffectBatch` (`Ordered`, `Unordered`,
`Chained`, with `Chance` and `Priority` properties).

### Key algorithms
The model is **symmetric effect/resistance**, and it is a genuinely elegant generalisation
of AoE2's armour classes: an attacker carries a set of effects, each tagged with a type;
the target carries a set of resistances, each tagged with a type; damage is resolved by
matching tags and applying the calculation type. AoE2's "this unit does +12 vs cavalry" is
just an effect tagged `cavalry` meeting (or not meeting) a resistance tagged `cavalry`.

Everything else — conversion (`Convert`), garrisoning (`SendToContainer`), making a corpse
harvestable (`MakeHarvestable`), healing, area damage — is expressed as effects in the
same framework.

### Dependencies
Would depend on: entity components (attributes), the event system (attack timing),
pathfinding (closing to range), and projectiles (themselves entities).

### Port notes

**Medium difficulty, high design leverage. This is where I'd spend design thought rather
than implementation effort.**

**Recommendation: adopt the effect/resistance model, but implement a simplified version.**
The full spec — batches, chained effects, priorities, hyperbolic stacking — is more than
you need and more than AoE2 itself uses. A tractable subset that captures ~95% of the feel:

```ts
type DamageType = 'melee' | 'pierce' | 'siege' | 'anti-cavalry' | ...
type Attack   = { type: DamageType, amount: number }[]
type Armor    = Partial<Record<DamageType, number>>

// AoE2's actual formula, near enough:
damage = max(1, sum over attack types of max(0, attack[t] - armor[t]))
```

The floor of 1 is important — it's why AoE2 has no truly invulnerable units.

**Easy:** the damage formula; HP tracking; death (remove entity, spawn corpse/rubble);
attack cooldowns as repeating events; target acquisition within a radius via a spatial
grid.

**Harder:**
- **Projectiles.** These are full entities with their own movement, spawned at fire time,
  resolving on arrival. AoE2's arrows *lead* their target and can miss if the target
  moves — that's `Accuracy` plus travel time in the spec. Faithful projectiles are
  noticeably more work than instant hit resolution, but they're a large part of why ranged
  combat reads well.
- **Stances.** `GameEntityStance` (aggressive/defensive/stand-ground/no-attack) drives
  auto-acquisition, and auto-acquisition is what makes an RTS army feel alive rather than
  inert. It's also a common source of frustrating bugs (units chasing across the map).
  Implement stances early but conservatively — a tight leash radius.
- **Area effects** need a spatial query; reuse the same grid as target acquisition.

**Different approach:** openage's `ApplyContinuousEffect` (damage-over-time) needs care in
an event model — either many small repeating events, or an integral computed at start and
end. Prefer the latter: compute total damage when the effect ends or is interrupted, not
every 100 ms.

---

## 8. Tech Tree and Age Progression

### What it does
**Not implemented in C++.** But the *design* here is the cleverest thing in the codebase
after curves, and you should copy it.

### Key files
- `openage/convert/processor/conversion/aoc/tech_subprocessor.py` (603 lines)
- `openage/convert/processor/conversion/aoc/upgrade_ability_subprocessor.py` (2,135 lines)
- `openage/convert/processor/conversion/aoc/upgrade_attribute_subprocessor.py` (2,774 lines)
- `openage/convert/processor/conversion/aoc/upgrade_resource_subprocessor.py` (1,540 lines)
- `openage/convert/processor/conversion/aoc/upgrade_effect_subprocessor.py` (583 lines)
- `openage/convert/entity_object/conversion/aoc/genie_tech.py` (616 lines)
- `doc/nyan/api_reference/reference_ability.md` — `ability.type.Research`
- `doc/nyan/api_reference/reference_util.md` — `util.patch.Patch`, `util.research.*`
- `libopenage/gamestate/player.h:85` — `std::shared_ptr<nyan::View> db_view` ← **the key line**
- `libopenage/gamestate/api/patch.h` — patch reading

### Key data structures
`Tech` (cost, prerequisites, the patches it applies); `Patch` — nyan's native mechanism for
one object modifying another's members; `nyan::View` — a **per-player layered view of the
game database**.

### Key algorithms
**This is the insight:** each `Player` owns its own `nyan::View` onto the shared database.
Researching a tech applies patches *to that player's view*. Every stat lookup a unit does
goes through its owner's view, so upgraded stats are simply what that player now sees.

The consequences are worth spelling out, because they're what make it good:
- No iterating over existing units to bump their stats.
- Units created *before* and *after* the upgrade automatically agree.
- Per-player divergence is free — two players can have wildly different stats for the same
  unit type with no per-entity storage.
- Civilization bonuses are just patches applied at game start. **Civs and techs are the
  same mechanism.**
- Age advancement is just a tech.

That last pair is the real prize: you don't build a civ system *and* a tech system, you
build one patch system and get both.

### Dependencies
Would depend on: nyan (or your equivalent), player state, resources (research cost), the
event system (research duration), and UI.

### Port notes

**Easy to build, if you design the data layer for it from the start. Painful to retrofit.
Decide this in week one.**

You don't have nyan and shouldn't build it — nyan is a full language with a parser,
inheritance, and patch semantics. What you need is its *effect*:

```ts
// Static definitions loaded from JSON
const BASE: Record<string, UnitDef> = { ... }

// Per-player overlay
class PlayerDataView {
  private cache = new Map<string, UnitDef>()
  private patches: Patch[] = []
  get(id: string): UnitDef {
    let v = this.cache.get(id)
    if (!v) { v = applyPatches(BASE[id], this.patches); this.cache.set(id, v) }
    return v
  }
  applyPatch(p: Patch) { this.patches.push(p); this.cache.delete(p.target) }
}
```

A patch is a small declarative object: `{ target: 'archer', field: 'attack.pierce', op: 'add', value: 1 }`.

**The critical discipline:** **every** stat read in the simulation must go through
`player.data.get(unitTypeId)` — never through a direct import of the base table, and never
copied into the entity at spawn time. If you get this right on day one it costs nothing.
If entities cache their stats at spawn, then adding tech later means hunting down every
cached value and writing invalidation logic, and you will get it wrong.

**Easy:** the tech tree graph itself (prerequisites, availability) is just a DAG with a
`researched: Set<string>` per player. Age advancement is a node in that DAG that gates
others. The UI is a grid of buttons with enabled/disabled state.

**Trivial, genuinely:** civilization bonuses. Once patches exist, a civ is a named list of
patches applied at match start, plus a list of units/techs it may not access. For a Qatari
civ set — Al Bidda, Zubarah, Al Khor, Doha, whatever you choose — this is a JSON file, not
code. This is the single highest-leverage system for your content goals.

**Watch out for:** patches that modify *other patches*, and patch ordering. nyan has full
semantics for this. Keep yours simple — flat, ordered, last-write-wins for `set` and
accumulate for `add` — and resist generalising until something concrete forces you to.

---

## 9. AI Opponent

### What it does
**Does not exist.** No AI module anywhere in `libopenage/`. My search found only a Pong
paddle AI in `libopenage/main/demo/pong/pong.cpp` and an unrelated identifier in
`input/controller/game/controller.h`.

### Key files
- `doc/ideas/ai.md` — aspirational design notes
- `README.md:61` — the stated goal of Python-scripted AI, with a nod toward scikit-learn
  and machine learning

There is nothing else. This is a greenfield system for you.

### Key data structures / algorithms
None exist. For reference, a conventional RTS AI stack is: a **build order** (scripted
opening), an **economy manager** (villager allocation across resources against target
ratios), a **military manager** (composition, grouping, attack timing), a **scout/map
awareness** layer, and a **difficulty model** (usually resource handicaps and reaction
delays rather than smarter play).

### Dependencies
Would depend on essentially everything else — it's a consumer of all other systems.

### Port notes

**Nothing to port. Build the simplest thing that works, and build it late.**

Strong recommendation: **a scripted build order plus reactive rules will beat most human
beginners and is perhaps 500 lines.** Do not start with planning, utility systems, or
behaviour trees, and emphatically do not start with machine learning.

A concrete v1:
1. **Build order:** a JSON list — `[{at: 'start', build: 'house'}, {at: 'pop:8', train: 'villager'}, ...]`. Executed top to bottom against affordability.
2. **Economy:** maintain target villager ratios per resource (e.g. 40% food, 30% wood,
   15% stone, 15% gold); reassign idle villagers to whichever resource is furthest below
   target.
3. **Military:** accumulate units until a threshold, then attack-move at the nearest known
   enemy building. Retreat below a health/count threshold.
4. **Difficulty:** vary reaction delay and give the AI resource multipliers. This is what
   commercial RTS games actually do, and it's honest as long as you don't pretend
   otherwise.

**The single most valuable AI decision:** make the AI issue *the same commands a player
issues*, through the same command queue. No special-casing, no direct state mutation. This
keeps it honest, makes it debuggable (you can watch its commands in the same log), and
means it's automatically compatible with everything you add later.

**Easy in TypeScript:** all of the above. JS's async model is actually pleasant for
"decide every N seconds" loops.

**Hard, and worth deferring indefinitely:** anything resembling strategic reasoning —
map control, tech-switching in response to scouting, army composition counters. Genuinely
hard AI problems, and not what will make or break your game.

---

## 10. UI / HUD

### What it does
Draws the interface: resource readouts, minimap, selection panel, command buttons, menus.

**This is the module I understand least**, and I want to be explicit about that. There are
two overlapping mechanisms and I could not determine from static reading which one
actually draws the in-game interface.

### Key files
Path A — Qt Quick (likely legacy):
- `assets/qml/` — 19 QML files: `main.qml`, `IngameHud.qml`, `ActionsGrid.qml`, styled controls
- `libopenage/renderer/gui/` (3,754 lines) — `gui.cpp`, `guisys/`, `integration/`
- `doc/code/gui.md` — **explicitly marked outdated**; references a `libopenage/economy`
  module that does not exist

Path B — native HUD stage (likely current):
- `libopenage/renderer/stages/hud/` — `render_stage.cpp`, `object.cpp`, `render_entity.cpp`
- `libopenage/input/controller/hud/`

Also present: `libopenage/console/` (2,367 lines) — an in-engine terminal with its own
font renderer, legacy from the discarded prototype.

To resolve which is live, I'd need to trace `libopenage/presenter/presenter.cpp`
initialisation and the QML type registration end to end.

### Key data structures
Qt side: `GuiItemLink` / `QObject` property wrappers bridging engine objects into QML.
HUD stage: `HudObject`, `HudRenderEntity` — same render-entity pattern as world objects.

### Key algorithms
Qt's property binding and signal/slot propagation; QML hot-reloading (edit a `.qml` while
running and it re-applies — a nice development affordance).

### Dependencies
Qt6 Quick, the renderer, the input system.

### Port notes

**Do not port any of this. It is entirely Qt-specific and has no browser analogue.**

You have a better option than openage does: **HTML/CSS over the canvas.** Absolutely
position DOM elements above the PixiJS canvas for the resource bar, selection panel,
command grid, and menus. Reasons this is right:
- CSS layout, flexbox, and text rendering are vastly better than anything you'd build in
  PixiJS.
- Accessibility, text selection, and font rendering come free.
- You can use a component framework if you want one.
- Iteration is far faster.

Keep in PixiJS only what must live in the world: selection rectangles, health bars over
units, the placement ghost, and the minimap (a canvas you redraw at a few Hz from the
tile grid and entity positions).

**Easy:** everything about the HUD chrome. This is ordinary web development.

**The one real gotcha:** input routing. Clicks on HUD elements must not fall through to
the game world. Handle this with `pointer-events` and by checking event targets before
passing to the game input handler. Get it right once, early.

**Worth stealing:** openage's *input* architecture is better than its GUI architecture.
`libopenage/input/input_context.h` implements a **context stack** — the top context gets
first refusal on each event and can consume or pass it. That's exactly how you want to
handle "escape closes the menu, or cancels placement, or deselects," and it's a clean
pattern worth ~100 lines in TypeScript. Bindings load from `cfg/keybinds.oac` via
`input/text_to_event.cpp`.

---

## 11. Save/Load

### What it does
**Does not exist.** No serialization of game state anywhere in the engine. My grep for
`savegame`/`serializ` in `libopenage/` returned only `rng/rng.cpp` (RNG seed state,
unrelated). `README.md:74` mentions a planned one-way converter for the *original* game's
saves — not a native save system.

### Key files
None. `libopenage/rng/rng.h` has seed serialization, which you will need but is not a save
system.

### Key data structures / algorithms
None.

### Port notes

**Nothing to port; design fresh. Easy in a browser — but only if you plan for it.**

The whole point of this system is that **it is easy if your state is plain data and
miserable if it isn't.** Which means it's really a constraint on how you write everything
else:

- Keep simulation state in plain, JSON-serialisable objects. No class instances with
  methods, no circular references, no PixiJS objects mixed into simulation components.
- Reference entities by **numeric ID**, never by object reference. This is the one that
  bites people — a `target: Entity` field serialises to an infinite loop or a duplicate;
  a `targetId: number` serialises to a number.
- Keep display state (`sprite`, PixiJS containers) in components you explicitly exclude
  from serialization, and rebuild them on load.

Then saving is `JSON.stringify(world.entities)` plus player state, RNG seed, and current
time; loading is the reverse plus a rebuild of derived state (spatial index, pathfinding
cost grid, sprites).

**Storage:** `localStorage` caps around 5 MB and is synchronous — fine for settings, too
small and too blocking for saves. Use **IndexedDB** for saves, and offer a
download/upload of a `.json` (or gzipped) file so players can back saves up. Compress with
`CompressionStream('gzip')`, which is available in modern browsers with no library.

**A note on curves:** if you adopt curves broadly (§3), save files contain *history*, not a
snapshot, and grow with match length. Another argument for using curves sparingly.

**Do this early, in skeletal form.** Save/load is the fastest way to find out that you've
accidentally coupled simulation to rendering — if you can't serialise your world, your
architecture has a leak. It's a canary as much as a feature.

---

## 12. Networking / Multiplayer

### What it does
**Does not exist.** No networking code — my grep hit only `libopenage/util/fds.cpp` (file
descriptor helpers).

### Key files
- `doc/code/architecture.md` — the *goal* architecture: a single authoritative server
  running the simulation asynchronously, clients receiving only what they can see,
  network events entering through the event system
- `doc/reverse_engineering/networking/` — analysis of the *original* game's protocol,
  which openage explicitly will not be compatible with (`README.md:71-72`)
- `libopenage/curve/` — the intended enabler

### Key algorithms
Planned, not built. The curve architecture is the strategy: because state is a timeline
rather than a snapshot, a late-arriving packet becomes a keyframe insertion at a past time
rather than a rollback-and-replay. `doc/code/curves.md` argues this is more robust than
lockstep and easier to recover from desync.

### Dependencies
Would touch everything.

### Port notes

**Hardest system in the entire project by a wide margin. Defer explicitly, and say so out
loud in your planning documents so it doesn't get assumed into a schedule.**

RTS multiplayer is hard because the unit counts make state replication impractical, which
historically pushes RTS games toward **lockstep**: send only commands, have every client
run the same simulation, and require bit-identical results. Bit-identical is the brutal
part — in JavaScript it means no `Math.random()` outside a seeded PRNG, no floating-point
in simulation (`Math.sin`, `Math.sqrt` and even basic ops can differ across engines and
platforms), no iteration over unordered collections, no `Date.now()`. Every one of those
is a desync that manifests minutes later as two players seeing different games.

**Concrete advice, in priority order:**
1. **Decide now whether multiplayer is ever a goal.** If yes, adopt fixed-point arithmetic
   and a seeded PRNG **from the first line of simulation code**. Retrofitting determinism
   into a float-based simulation is close to a rewrite. This is why openage uses
   fixed-point everywhere despite the ergonomic cost — they made this decision up front,
   and they were right to.
2. **If multiplayer is a maybe**, isolate all arithmetic and randomness behind small
   modules (`sim/math.ts`, `sim/random.ts`) so a later switch to fixed-point is one file.
   This costs almost nothing now.
3. **If multiplayer is a no**, use floats freely and enjoy it.

**Realistic middle path:** if you want *some* multiplayer without determinism, consider
**server-authoritative with a small player count and interest management** — the server
runs the only simulation and sends clients visible-entity deltas. Far more forgiving than
lockstep (no determinism requirement at all), but needs a server and bandwidth scales with
entity count. For a 1v1 or 2v2 browser game over WebSocket, that's very achievable — and
it's exactly the architecture `doc/code/architecture.md` says openage is aiming for. If
multiplayer matters to you, this is the path I'd recommend over lockstep.

---

## 13. Map Format and Terrain

### What it does
Represents the ground: tile types, chunking, and the terrain's contribution to
pathfinding cost. **There is no map file format and no map generator** — terrain is
constructed in code.

### Key files
- `libopenage/gamestate/terrain.h` / `.cpp` — the terrain container
- `libopenage/gamestate/terrain_chunk.h` — chunking
- `libopenage/gamestate/terrain_tile.h` — per-tile data
- `libopenage/gamestate/terrain_factory.h` — construction from nyan
- `libopenage/gamestate/map.h` — terrain + pathfinder, and nyan-grid → grid-ID mapping
- `libopenage/coord/` — `tile.h`, `chunk.h`, `phys.h`, `scene.h`, `pixel.h`
- `libopenage/renderer/stages/terrain/` — terrain rendering (chunk, mesh, model)
- `doc/code/coordinate-systems.md` — **read this before writing any coordinate code**
- `doc/media/openage/terrain_format_spec.md` — the `.terrain` asset format
- `doc/media/blendomatic.md` — how the original blends terrain edges

### Key data structures
| Structure | Purpose |
| --- | --- |
| `Terrain` | Size in tiles + vector of chunks |
| `TerrainChunk` | Square block of tiles (uniform except last row/column) |
| `TerrainTile` | Terrain type reference + elevation |
| `Map` | Terrain + pathfinder + nyan-grid-name → grid-ID map |
| `coord::phys2/3` | Fixed-point NE/SE/UP simulation coordinates |
| `coord::tile`, `coord::chunk` | Integer grid coordinates |
| `coord::scene2/3` | Renderer coordinates |

### Key algorithms
- **Coordinate conversion** between the five spaces. The renderer transform is
  `Eigen(x, y, z) = (SE, UP / sqrt(8), -NE)`. Types are generated at build time from
  `coord/coord.h.template`.
- **Chunking** for rendering and streaming granularity.
- **Terrain→cost translation:** terrain types map to pathfinding cost values when the grid
  initialises (`Map` constructor).
- **Blend masks** (`doc/media/blendomatic.md`, `blendmask_format_spec.md`): the original
  game blends adjacent terrain types with per-edge alpha masks, which is why AoE2's grass
  meets dirt organically rather than in a hard checkerboard.

### Port notes

**Easy if you make one decision correctly: start flat.**

**Do first:**
- A flat tile grid: `Uint8Array` of terrain type IDs, width × height. That's your map
  format for a long time.
- Isometric coordinate conversion — steal openage's math including the `sqrt(8)`. Write
  the conversions once, in one module, with tests. Coordinate bugs are the most
  time-consuming class of bug in isometric games and they're entirely preventable.
- Terrain rendering as a tilemap. Only draw visible tiles; PixiJS batches them from one
  atlas.

**Do later:**
- **Elevation.** As noted in §1, this is a big step: per-vertex terrain meshes, slope
  transitions, units sorted against terrain, and cliffs affecting pathing. It roughly
  triples terrain complexity. AoE2's elevation is mostly a visual and minor combat-bonus
  feature; you can ship without it.
- **Blend masks.** Nice polish; a fragment shader or pre-generated transition tiles. Not
  needed for v1.
- **Random map generation.** openage has none, so nothing to port. When you get there, the
  standard approach is: place player starts symmetrically → Voronoi or noise for terrain
  regions → scatter resources with per-player fairness constraints → validate connectivity
  with a flood fill. Symmetric fairness is the hard part, and it's a genuinely interesting
  design problem for Qatari geography — coastline, inland desert, oases.

**A map format recommendation:** just use JSON —
`{ width, height, tiles: number[], entities: [{type, x, y, owner}] }` — gzipped if size
matters. You have no reason to invent a binary format, and JSON means you can hand-author
test maps in a text editor, which is worth a great deal during development.

---

## 14. Data Files for Units, Civs, Techs

**Covered in full in `DATA_INVENTORY.md`.** The one-line summary, because it's the finding
most likely to reshape your plan:

**The numbers are not in this repository.** They live in the user's Age of Empires
installation and are transcoded at install time by `openage/convert/` (73,391 lines of
Python) into nyan modpacks. What this repo gives you is the **schema** those numbers must
satisfy — `doc/nyan/api_reference/` (5,188 lines) and
`openage/convert/service/read/nyan_api_loader.py` (4,973 lines, the largest single source
file in the repo).

For *Kingdoms of Qatar* this is arguably good news: you were going to replace all content
anyway, so there is nothing to strip out and no licensing entanglement with original game
data. You are writing new JSON against a well-designed schema.

---

## 15. Audio

### What it does
An Opus-based audio system with streaming and in-memory loading, category-based
organisation, and a resource definition format. **It is dormant** —
`libopenage/audio/audio_manager.h:33` carries `TODO: Finish porting to Qt`, and I found no
references to it from `presenter.cpp` or the engine startup path. It compiles
(`libopenage/CMakeLists.txt:337`) but nothing calls it.

### Key files
- `libopenage/audio/audio_manager.h` / `.cpp` — the (unused) entry point
- `libopenage/audio/sound.h`, `resource.h`, `resource_def.h`
- `libopenage/audio/opus_loading.cpp`, `opus_dynamic_loader.cpp`,
  `opus_in_memory_loader.cpp`
- `libopenage/audio/in_memory_loader.cpp` vs `dynamic_loader.cpp` — the two strategies
- `libopenage/audio/category.h` — sound categories
- `doc/media/sound.md` — the original game's audio formats
- Spec side: `ability.property.type.CommandSound` / `ExecutionSound`, `util.sound.Sound`

### Key data structures
`AudioManager` (device, mixing); `Resource` (a loaded sound); `InMemoryResource` vs
`DynamicResource` (fully decoded vs streamed); `category_t` (sound classification);
`resource_def` (declarative definition).

### Key algorithms
The meaningful design decision is the **loader policy split**: short sounds (unit
acknowledgements, attack impacts) are decoded fully into memory; long ones (music, ambient
loops) are streamed and decoded incrementally. That's the right split and it survives the
port.

### Dependencies
Opus (`libopus`, `opusfile`). Would be called by the presenter and by gameplay events.

### Port notes

**Easy — the browser gives you more than openage has working.**

Use **Howler.js** or the raw **Web Audio API**. Web Audio gives you positional audio,
gain nodes for per-category volume, and format handling for free. Use `.ogg`/Opus with an
`.m4a` fallback; Opus is well supported in modern browsers.

**Steal the two ideas that matter:**
1. **Categories** — separate gain nodes for music / effects / UI / ambient, so volume
   sliders are trivial and mixing is controllable.
2. **The loader split** — preload short effects into `AudioBuffer`s; stream music via
   `<audio>` + `MediaElementSourceNode`. Same reasoning, and it matters more in a browser
   where you're also managing download size.

**The browser-specific gotcha openage doesn't have:** **autoplay policy.** Browsers block
audio until the user interacts with the page. Your `AudioContext` starts suspended and
must be resumed inside a user-gesture handler. Handle it once at the "click to start"
screen, or every sound will silently fail and you'll spend an afternoon confused.

**RTS-specific concerns worth planning for:**
- **Voice spam.** Selecting 40 villagers must not play 40 acknowledgements. Standard fix:
  play one per selection, with a short cooldown per sound type.
- **Sound culling.** Off-screen combat shouldn't play at full volume. Cull by distance
  from the camera and cap concurrent instances per sound.
- **Positional audio** via `PannerNode`, mapped from world position relative to camera
  centre. Cheap and adds a lot.

---

## 16. Localization

### What it does
**No runtime localization exists.** There is no gettext, no `.po` files, no string tables
in the engine, and no language switching. What exists is converter-side infrastructure for
*extracting* strings from the original game, plus a nyan model for representing translated
names.

### Key files
- `openage/convert/value_object/read/media/langcodes.py` — original → modern language codes
- `openage/convert/value_object/read/media/peresource.py` — extracts string tables from
  Windows PE resources in the original executables
- `openage/convert/value_object/conversion/*/internal_nyan_names.py` — per-edition maps
  from numeric IDs to nyan identifiers (**these are internal identifiers, not user-facing
  translations** — an easy thing to misread)
- Spec: `ability.type.Named`, `util.language.*`, `util.language.translated.*`

### Key data structures
Specified: `TranslatedString` — a mapping from language to string; `Language`; `Named` —
the ability that gives an entity a display name and description.

### Key algorithms
Extraction: parse PE resource sections, pull string tables, map language codes, emit
per-language nyan objects.

### Port notes

**Genuinely trivial, and you should do it early — not because it's urgent, but because
retrofitting it is tedious.**

Nothing to port. A JSON-per-language file and a lookup function is the whole system:

```ts
// locales/en.json → { "unit.pearl_diver.name": "Pearl Diver", ... }
// locales/ar.json → { "unit.pearl_diver.name": "غواص اللؤلؤ", ... }
const t = (key: string) => strings[key] ?? key
```

Use a library (`i18next`) only if you need plurals, interpolation, and number/date
formatting. For unit names and UI labels, a plain object is enough.

**Do it from the first UI element.** The cost of writing `t('unit.pearl_diver.name')`
instead of `"Pearl Diver"` is zero at the time and substantial later.

**Arabic support deserves specific attention for this project**, and it's the one part of
this system that isn't trivial:
- **RTL layout.** `dir="rtl"` on the HTML root handles most of it if you use CSS logical
  properties (`margin-inline-start`, not `margin-left`) throughout. Retrofitting logical
  properties across a finished stylesheet is miserable; using them from the start is free.
- **Font.** You need a font with proper Arabic shaping — Noto Sans Arabic is the safe
  default. Latin-only fonts will render Arabic as disconnected letterforms or boxes.
- **Text in PixiJS.** PixiJS's text rendering handles Arabic shaping inconsistently
  depending on the path used. **This is another argument for putting UI text in the DOM**
  (§10) — the browser's text engine handles bidi and shaping correctly and you get it
  free.
- **Numerals.** Decide between Western (0-9) and Eastern Arabic (٠-٩) numerals for
  resource counts. Both are used in Qatar; it's a design choice, not a correctness one.
- **Mixed-direction strings.** "Age of Empires II" inside Arabic text, or a unit count
  next to an Arabic name, invokes the bidi algorithm. Browsers handle this correctly;
  canvas text rendering often doesn't.

Given that *Kingdoms of Qatar* has an obvious Arabic-speaking audience, I'd treat Arabic
as a first-class target from day one rather than a later addition — which mostly means the
DOM-UI decision in §10 and CSS logical properties, both of which are free if chosen early.
