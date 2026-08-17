# ARCHITECTURE — Reconnaissance Map of the Source Codebase

**Status:** Read-only reconnaissance. No source files were modified.
**Date:** 2026-08-17
**Scope:** Top-down architectural map of the RTS engine in this repository, written as
preparation for the *Kingdoms of Qatar* port to TypeScript + PixiJS v8 + miniplex.

---

## 0. What this codebase actually is

This repository is **openage** — a from-scratch free-software reimplementation of the
*Genie Engine* that powered *Age of Empires*, *Age of Empires II (HD/DE)* and
*Star Wars: Galactic Battlegrounds*. It is licensed **GPLv3 or later**
(`copying.md`, `legal/GPLv3`).

Two facts dominate everything else in this document, and you should internalise both
before reading further:

**Fact 1 — This is an *engine*, not a *game*.** The repository ships **no game content
whatsoever**. There are no unit stats, no civilizations, no tech trees, no maps, no
campaigns, and no localized strings anywhere in the tree. The only `.nyan` data file in
the entire repo is `assets/test/nyan/pong.nyan`, a test fixture for a Pong demo. All
real game content is *generated at install time* by a converter (`openage/convert/`,
73,391 lines of Python) that reads the user's own legally-owned copy of Age of Empires
and transcodes it into openage's native formats. This has enormous consequences for your
project and is detailed in `DATA_INVENTORY.md`.

**Fact 2 — Gameplay is largely unimplemented.** The project's own `README.md` (lines
80–86) states plainly: *"At the moment, 'gameplay' is basically non-functional."* The
team discarded a previously-working prototype simulation to rebuild it on a new
architecture, and that rebuild is roughly one-eighth complete. Concretely: I searched
the entire C++ simulation tree and found **no combat resolution, no AI opponent, no tech
tree runtime, no resource gathering, no building placement/construction, no save/load,
and no networking**. What exists is a very well-engineered *skeleton* — time, events,
curves, pathfinding, rendering, entity/component plumbing — plus exactly four gameplay
behaviours (idle, turn, move, select).

This is not a criticism of openage; it is a rebuild in progress. But it means the
codebase's value to you is **architectural, not transplantable**. You are inheriting a
set of very good design decisions and a complete data *specification*, not a working
game you can reskin.

---

## 1. Language, build system, entry points

### Languages

| Language | Extension | Lines | Role |
| --- | --- | --- | --- |
| C++20 | `.cpp` `.h` | ~80,500 | Engine core: simulation, renderer, pathfinding, audio, input |
| Python 3 | `.py` | ~78,400 | Asset conversion, CLI, codegen, scripting (**94% is the converter**) |
| Cython | `.pyx` `.pxd` | ~9,100 | Python↔C++ glue, plus hot image-decoding loops |
| GLSL | `.glsl` | ~1,200 | Shaders (67 files) |
| QML | `.qml` | ~1,600 | Qt Quick user interface |

**Total: roughly 171,000 lines**, of which the actual engine is ~80k C++ and the
converter is ~73k Python. This split is the single most important number in the repo.

The language policy is documented in `doc/project_structure.md`: *"Python — everything
that does not crunch data; Cython — fast Python code, glue between C/C++ and Python;
C++ — data crunching code: simulation, graphics, sound."*

### Build system

**CMake** (top-level `CMakeLists.txt`, 8 KB) driven by a hand-written `./configure`
shell wrapper and a convenience `Makefile`. The build machinery in `buildsystem/`
is unusually heavy — it includes a code-compliance checker (`buildsystem/codecompliance`),
a Cython `.pxd` generator (`buildsystem/pxdgen.py`), and a codegen step
(`buildsystem/codegen.cmake`). There is also Nix packaging (`flake.nix`, `nix/`) and
Docker packaging (`packaging/docker/`).

Standard build: `./configure --download-nyan && make`, then `cd bin && ./run main`.

External dependencies of note: **Qt6** (windowing + GUI), **OpenGL**, **Opus** (audio
codec), **Eigen** (renderer math), and **nyan** — a separate SFTtech project that is the
data description language and is fetched at configure time, *not vendored here*.

### Entry points

There are two, and the Python one is primary:

1. **`openage/__main__.py`** — the real entry point. Pure `argparse`; each subcommand is
   registered by its own module. Subcommands include `main` (run the game),
   `convert` (asset conversion), and various test/demo commands.
2. **`libopenage/main.cpp`** / `libopenage/main.h` — the C++ side, invoked *from* Python
   through the Cython bridge in `libopenage/pyinterface/`. Python owns `main()`; C++ is
   called into.

The user-facing launcher is generated from `run.py.in`.

### Documentation

The repo is unusually well documented — `doc/` contains ~176 Markdown files including
genuine architecture prose with UML/SVG diagrams. The most valuable for you:

- `doc/code/architecture.md` — subsystem overview and information flow
- `doc/code/game_simulation/` — README, `game_entity.md`, `components.md`,
  `systems.md`, `activity.md` (the best material in the repo)
- `doc/code/curves.md` — the time-value keyframe model
- `doc/code/time.md` — simulation time
- `doc/code/event_system.md` — the event loop
- `doc/code/pathfinding/` — README + `field_types.md` (flow fields)
- `doc/code/coordinate-systems.md` — all coordinate spaces
- `doc/nyan/api_reference/` — **5,188 lines specifying the complete game data model**
- `doc/media/openage/` — specs for every native asset format
- `doc/reverse_engineering/` — notes on the original Genie Engine's mechanics

Caveat the project states itself (`README.md:209`): *"This folder tends to get outdated
when code changes."* I found this to be true in places — `doc/code/gui.md` is explicitly
marked outdated, and it describes classes (`libopenage/economy`) that do not exist.

---

## 2. Top-level folder map

| Folder | Purpose |
| --- | --- |
| `libopenage/` | **The engine.** All C++20. Each subsystem in its own subfolder. |
| `openage/` | Python side. Overwhelmingly the asset converter; also CLI, codegen, nyan tooling. |
| `assets/` | Runtime assets that ship: shaders, QML UI, logo, test fixtures. **No game content.** |
| `doc/` | Conceptual documentation, format specs, reverse-engineering notes. |
| `buildsystem/` | CMake modules, code generation, compliance checking. |
| `cfg/` | Shipped config: `keybinds.oac` (keybindings) and converter game-detection TOMLs. |
| `etc/` | Dev tooling configs (pylint, valgrind, gdb pretty-printers). |
| `legal/` | GPLv3, LGPLv2, BSD-3-clause license texts. |
| `dist/` | Desktop-entry / distribution files. |
| `packaging/` | CPack + Docker packaging. |
| `nix/` | Nix derivations. |
| `.github/` | CI workflows, PR templates. |

### `libopenage/` by size

| Lines | Subsystem | Notes |
| --- | --- | --- |
| 26,164 | `renderer/` | Largest by far. OpenGL, Vulkan stub, stages, resources, Qt GUI. |
| 10,333 | `util/` | Fixed-point math, filesystem abstraction, paths, compression. |
| 8,305 | `gamestate/` | The simulation. Entities, components, systems, activities, terrain. |
| 7,695 | `pathfinding/` | Flow-field pathfinder + legacy A*. |
| 3,753 | `curve/` | Time-value keyframe containers. |
| 3,524 | `event/` | The event loop and scheduler. |
| 2,571 | `input/` | Input contexts and controllers. |
| 2,367 | `console/` | In-game terminal (largely legacy). |
| 2,272 | `pyinterface/` | Cython bridge to Python. |
| 2,130 | `audio/` | Opus-based audio. **Dormant — see §4.15.** |
| 1,522 | `main/` | Demos and tests. |
| 1,496 | `datastructure/` | Concurrent queue, pairing heap. |
| 1,092 | `error/` | Exception + backtrace machinery. |
| 1,091 | `job/` | Thread-pool job dispatch. |
| 1,044 | `coord/` | Coordinate system types. |
| 970 | `log/` | Logging. |
| 751 | `rng/` | Random number generator. |
| 566 | `assets/` | Modpack/mod manager. |
| 559 | `presenter/` | Ties renderer + input + simulation together. |
| 450 | `time/` | Clock and time loop. |
| 223 | `engine/` | Top-level orchestrator. |
| 202 | `testing/` | Test harness. |
| 161 | `cvar/` | Console variables / config. |

### `openage/` by size

| Lines | Module | Notes |
| --- | --- | --- |
| 73,391 | `convert/` | **The converter.** 94% of all Python here. |
| 4,738 | `util/` | Filesystem-like abstractions mirroring the C++ side. |
| 1,902 | `nyan/` | nyan file/tooling helpers. |
| 1,051 | `cabextract/` | MS-CAB decompression (for installer extraction). |
| 765 | `cppinterface/` | Python half of the Cython bridge. |
| 646 | `codegen/` | Build-time code generation. |
| 614 | `testing/` | Test runner. |
| <300 each | `log/`, `main/`, `game/`, `cvar/`, `renderer/`, `gamestate/`, `pathfinding/`, `event/`, `versions/` | Thin Cython shims exposing C++ to Python. |

Note how thin `openage/gamestate/` (55 lines) and `openage/pathfinding/` (54 lines) are —
these are *not* Python implementations, they are three-line Cython re-exports. Do not be
misled by the directory names mirroring `libopenage/`.

---

## 3. Runtime topology — the thing that will most surprise you

### Three threads, no ticks

`libopenage/engine/engine.cpp` sets up the whole run. It creates:

- a **`TimeLoop`** thread (`libopenage/time/time_loop.cpp`) that does nothing but
  advance a clock;
- a **`Presenter`** thread (`libopenage/presenter/presenter.cpp`) that owns the window,
  renderer, and input — only spawned in `mode::FULL`, skipped in `mode::HEADLESS`;
- the **simulation**, which runs on the *main* thread via `Engine::loop()` →
  `GameSimulation::run()`.

Now read the simulation loop itself (`libopenage/gamestate/simulation.cpp:45-52`) in full:

```cpp
void GameSimulation::run() {
    this->start();
    while (this->running) {
        time::time_t current_time = this->time_loop->get_clock()->get_time();
        this->event_loop->reach_time(current_time, this->game->get_state());
    }
}
```

That is the entire game loop. **There is no tick rate. There is no fixed timestep. There
is no update order.** The loop asks "what time is it?" and then tells the event loop
"catch up to that time." `doc/code/architecture.md` states it explicitly:

> openage does not have simulation steps or *ticks* since everything in the simulation is
> event-based and scheduled by time.

This is the single most architecturally significant fact in the codebase, and §3.1–3.2
below explain how it can possibly work.

### 3.1 Simulation time

`time::time_t` (`libopenage/time/time.h`) is a **64-bit signed fixed-point value with a
16-bit fractional part, measured in seconds**. `1.25` means 1.25 seconds. It is
deliberately *not* an integer tick counter and deliberately *not* a float.

`Clock` (`libopenage/time/clock.h`) multiplies real elapsed time by a **simulation speed**
(which `doc/code/time.md` notes *can be negative* — the architecture contemplates running
the simulation backwards) and accumulates. It clamps the per-update delta to a maximum of
50 ms so that a debugger breakpoint doesn't fast-forward the game, and a minimum of 1 ms
so the thread doesn't spin.

Fixed-point is chosen over floating-point for determinism — a prerequisite for the
lockstep-free multiplayer they eventually want.

### 3.2 Curves — how state exists without ticks

If nothing updates every frame, how does a unit move? The answer is `libopenage/curve/`,
and it is the cleverest idea in the codebase.

A **curve** is a container of `(time, value)` keyframes that can be *interpolated* to
yield the value at any time — past, present, or future. `doc/code/curves.md` credits the
idea to Planetary Annihilation's "chrono cam." Types available:

- `Discrete<T>` — value steps at keyframes (`libopenage/curve/discrete.h`)
- `Continuous<T>` — linear interpolation between keyframes (`continuous.h`)
- `Segmented<T>` — piecewise, allows discontinuities (`segmented.h`)
- `Queue<T>`, `UnorderedMap<K,V>`, `Array<T,N>` — container curves
  (`libopenage/curve/container/`)

All backed by `KeyframeContainer` (`libopenage/curve/keyframe_container.h`).

So a unit's position is not a `vec2` that gets nudged each frame. It is a
`Continuous<coord::phys3>` — a *timeline*. When a move command is issued, the engine
computes the **entire journey up front** and writes all its keyframes at once. Reading the
unit's position at render time is an interpolation query, not a simulation step.

I confirmed this by reading `libopenage/gamestate/system/move.cpp:95-187`. The
`move_default` function calls the pathfinder once, then walks the returned waypoints in a
loop, accumulating `total_time` and calling
`pos_component->set_position(start_time + total_time, waypoint)` for each. It even models
turning: if `turn_speed` is finite it inserts an *extra* keyframe holding the unit still
for `angle_diff / turn_speed` seconds before the next leg. By the time the function
returns, the unit's entire multi-second path already exists on the curve. Nothing will
touch it again unless a new command arrives.

The stated payoff (`doc/code/curves.md`) is network and thread synchronisation: keyframes
can be inserted for any point in time without invalidating state, so a late-arriving
network packet is a keyframe insert rather than a desync. The stated costs are memory
overhead, interpolation cost, and complexity.

### 3.3 The event loop

`libopenage/event/event_loop.cpp` is the scheduler. `EventLoop::reach_time(t, state)`
pops every event scheduled at or before `t` and invokes it, repeatedly, until no more
events fire — with a settling limit of 10 iterations before it throws
(`event_loop.cpp:80`, with a candid comment: *"TODO detect infinite loops (is this a
halting problem?)"*).

Events have trigger types (`libopenage/event/eventhandler.h`): `ONCE`, `DEPENDENCY`,
`DEPENDENCY_IMMEDIATELY`, `TRIGGER`, `REPEAT`. The interesting one is `DEPENDENCY`: when a
dependency changes, `update_changes()` asks the handler to `predict_invoke_time()` again
and *reschedules* the event. This is how the engine avoids polling — an event that was
going to fire at t=30 gets moved to t=12 because something it depended on changed.

Events are declared in `libopenage/gamestate/event/`: `spawn_entity`, `send_command`,
`process_command`, `drag_select`, `wait`.

---

## 4. The systems you asked about

Each subsection answers: **what it does / what it depends on / what data it owns**, and
states honestly whether it exists.

### 4.1 Rendering / graphics — `libopenage/renderer/` (26,164 lines)

The largest subsystem by a wide margin, and the most mature. It is a **two-level
abstraction**: `doc/code/renderer/level1.md` describes a thin, backend-agnostic GPU
resource layer (`Renderer`, `ShaderProgram`, `Texture2d`, `RenderPass`, `RenderTarget`,
`UniformBuffer`, `Geometry`) with a working OpenGL implementation
(`libopenage/renderer/opengl/`, 4,295 lines) and a **stub Vulkan implementation**
(`libopenage/renderer/vulkan/`, 1,239 lines — present but not a functioning backend).
`doc/code/renderer/level2.md` describes the high-level layer: **render stages**.

Render stages (`libopenage/renderer/stages/`) each own a pass and draw one category of
thing: `terrain/`, `world/` (units and buildings), `hud/`, `skybox/`, `screen/` (final
composite + screenshots), `camera/`. Camera lives in `libopenage/renderer/camera/`.

The critical decoupling mechanism is the **render entity** pattern
(`libopenage/renderer/stages/render_entity.h`, plus per-stage subclasses like
`stages/world/render_entity.h`). The simulation never talks to the renderer directly. A
`GameEntity` holds an optional `std::shared_ptr<renderer::world::RenderEntity>` and calls
`render_update(time, animation_path)` on it (`gamestate/game_entity.cpp`). The render
entity buffers that as a dirty-flagged update; the render thread picks it up on its own
schedule. This is what lets the simulation and presenter threads run at completely
independent rates.

**Depends on:** Qt6 (window/context), Eigen (math), `coord/` (scene coordinate
conversion), `util/`. **Owns:** GPU resources, meshes, textures, shader programs, camera
matrices, the animation-timing state (`resources/frame_timing.h`), and the render-entity
mirror of simulation state.

Shaders live in `assets/shaders/` (67 GLSL files) and are templated at load time via
`renderer/resources/shader_template.h`.

### 4.2 Game simulation loop — `libopenage/gamestate/simulation.cpp`, `libopenage/time/`

Covered in §3. To restate the answer to your specific question: **tick rate — none;
update order — none.** Ordering is entirely emergent from event timestamps in a priority
queue. `GameSimulation` (`gamestate/simulation.h`) owns the event loop, the entity
factory, the terrain factory, the mod manager, and the spawner/commander event helpers.
`Game` (`gamestate/game.h`) is one session; `GameState` (`gamestate/game_state.h`) holds
the entity map, player map, map reference, and the nyan database view.

There is a vestigial `Universe`/`World` pair (`gamestate/universe.h`, `world.h`) whose own
header comment says `TODO: Remove Universe and other subclasses.` Treat as dead weight.

### 4.3 Entity model — `libopenage/gamestate/game_entity.h` + `component/`

Everything physical in the world is a **`GameEntity`**: units, buildings, trees,
resource piles, projectiles, ambient decoration. There is no separate Unit or Building
class. `GameEntity` (`game_entity.h`) is deliberately thin — an `entity_id_t`, an
`unordered_map<component_t, shared_ptr<Component>>`, an optional render entity, and a
manager.

`doc/code/game_simulation/game_entity.md` contains an important disclaimer:

> while the terminology we use here is very similar to names in the *Entity-Component-System*
> (ECS) architecture, you shouldn't think of the openage game simulation as a traditional
> ECS-driven architecture. We merely use this terminology because we can't think of
> anything better.

That disclaimer is accurate and matters for your port. This is **not** a data-oriented
ECS. There are no archetypes, no packed component arrays, no cache-friendly iteration.
Each entity owns a hash map of heap-allocated, polymorphic components. Systems do not
iterate over component arrays; they are invoked *per entity* by that entity's activity
graph. Structurally it is much closer to Unity's `GetComponent<T>()` than to miniplex,
Flecs, or EnTT.

Components split two ways (`gamestate/component/types.h`):

- **API components** (`component/api/`) — mirror a nyan ability type and hold a reference
  into the nyan database: `Idle`, `Live`, `Move`, `Selectable`, `Turn`.
- **Internal components** (`component/internal/`) — engine bookkeeping with no nyan
  counterpart: `Position`, `CommandQueue`, `Ownership`, `Activity`.

**Nine component types total.** Persistent data (unit stats) lives in nyan and is only
*referenced*; mutable runtime data lives on curves owned by the component. E.g. `Position`
owns a `Continuous<coord::phys3>` of positions and a `Segmented<coord::phys_angle_t>` of
facing angles.

Control flow is *not* in the components. It is in three other places:

- **Systems** (`gamestate/system/`) — stateless static functions. The complete list from
  `system/types.h` is `IDLE`, `MOVE_COMMAND`, `MOVE_DEFAULT`, `ACTIVITY_ADVANCE`. **Four.**
- **Activities** (`gamestate/activity/`) — per-entity behaviour *node graphs* with
  `StartNode`, `EndNode`, `TaskNode`, `TaskSystemNode`, `XorGate` (immediate branch),
  `XorEventGate` (branch that waits on an event). This is the RTS behaviour model:
  idle → wait for command → move → wait for arrival → idle.
- **`GameEntityManager`** (`gamestate/manager.h`) — receives events targeting the entity
  and drives its activity graph forward.

Note `entity_factory.cpp:47-105`: the one activity graph that exists is **hardcoded in
C++** in a function called `create_test_activity()` with the comment
`TODO: Replace with config`. Loading activity graphs from nyan is specified
(`util.activity.*` in the nyan API) but not wired up.

### 4.4 Pathfinding and movement — `libopenage/pathfinding/` (7,695 lines)

The most technically impressive subsystem after the renderer, and it is **complete and
working**. It implements **hierarchical flow-field pathfinding** following Elijah
Emerson's *Crowd Pathfinding and Steering Using Flow Field Tiles* (GameAIPro ch. 23),
cited directly in `doc/code/pathfinding/README.md`.

Structure: a `Grid` (`grid.h`) — one per movement type — is divided into square `Sector`s
(`sector.h`). Each sector owns a `CostField` (`cost_field.h`) of `uint8_t` per cell where
1 = cheapest, 254 = most expensive, 255 = impassable (`definitions.h`). Sectors connect
through `Portal`s (`portal.h`) — contiguous runs of mutually-passable cells along a shared
edge — and portals know which other portals they reach, forming a **portal graph**.

A search is two-phase (`pathfinder.cpp`):
1. **High level** — A* over the portal graph to pick the sequence of sectors to cross.
2. **Low level** — for each chosen sector, `Integrator` (`integrator.h`) builds an
   `IntegrationField` (`integration_field.h`) by wavefront propagation from the target
   (`uint16_t` accumulated cost, 65535 = unreachable), then derives a `FlowField`
   (`flow_field.h`) where each cell packs a direction (8 compass values) plus target /
   line-of-sight / pathable flags into a single `uint8_t`. Waypoints come from following
   the vectors.

Results are memoised in `FieldCache` (`field_cache.h`) keyed by `(portal_id, sector_id)` —
this is what makes repeated group pathing cheap.

A **legacy A*** implementation survives in `pathfinding/legacy/` (`a_star.cpp`,
`heuristics.cpp`) from the old prototype. It is not on the live path.

**Movement** is *not* in this folder — it is `gamestate/system/move.cpp`, described in
§3.2. The division: pathfinding returns tile waypoints; the move system converts them into
position-curve keyframes. There is **no steering, no local collision avoidance, and no
unit-unit collision** in the live code, despite flow fields being chosen partly to enable
it. Units currently pass through each other.

**Owns:** grids, cost/integration/flow fields, portal graph, field cache.
**Depends on:** `coord/` only. Deliberately decoupled from terrain — the README notes
terrain *may* influence cost but the pathfinder can initialise without it.

### 4.5 Resource system — **specified in nyan, not implemented in C++**

There is no resource module in `libopenage/`. No stockpile, no gathering, no drop-off, no
costs are executed anywhere. `Player` (`gamestate/player.h`) has exactly two members: an
ID and a nyan database view. It holds no resources.

What *does* exist is a complete **specification** in the nyan API
(`doc/nyan/api_reference/`): `ability.type.Gather`, `Harvestable`, `DropResources`,
`DropSite`, `ResourceStorage`, `ExchangeResources`, `Restock`, `RegenerateResourceSpot`,
`Trade`, `TradePost`, plus `util.cost.ResourceCost`, `util.resource.*`,
`util.exchange_rate.*`. The converter emits all of it. Nothing reads it back.

### 4.6 Building placement and construction — **specified in nyan, not implemented**

Same story. `ability.type.Foundation`, `Constructable`, `Create`, `ProductionQueue`,
`RallyPoint`, `TerrainRequirement` are all fully specified in
`doc/nyan/api_reference/reference_ability.md` and emitted by the converter
(`openage/convert/processor/conversion/aoc/ability_subprocessor.py`). There is no C++
placement validation, no foundation entity, no construction progress, no production queue.
Buildings and units are not distinguished at runtime — both are just `GameEntity` with
different component sets.

### 4.7 Combat resolution — **specified in nyan, not implemented**

I grepped the entire `libopenage/gamestate/` tree for `attack`, `combat`, `damage`,
`effect`, and `resistance`. The only hit is an unrelated identifier in
`gamestate/event/spawn_entity.h`. **There is no combat code.**

The specification, by contrast, is elaborate and is genuinely the most valuable artifact
in this repository for your project. `doc/nyan/api_reference/reference_effect.md` (403
lines) and `reference_resistance.md` (340 lines) define a symmetric effect/resistance
model: an attacker applies `effect.type.*` (discrete `FlatAttributeChange`,
`MakeHarvestable`, `SendToContainer`, `Convert`, or continuous `TimeRelativeAttackChange`,
etc.), and the target's `resistance.type.*` objects decide what actually lands. Around it:
`util.attribute.*` (HP and other attributes), `util.accuracy.Accuracy`,
`util.dropoff_type.*` (damage falloff by distance — linear, inverse-linear, none),
`util.calculation_type.*` (linear, hyperbolic, no-stack), `util.effect_batch.*` (ordered,
unordered, chained batches with `Chance` and `Priority` properties). Delivery is via
`ability.type.ApplyDiscreteEffect` / `ApplyContinuousEffect` / `ShootProjectile` /
`Projectile`, with `ability.property.type.Ranged` supplying range.

That is an AoE2-faithful combat model, fully documented, with zero implementation.

### 4.8 Tech tree and age progression — **specified in nyan, not implemented**

No C++ tech code. `ability.type.Research` exists in the spec; the converter has a full
`tech_subprocessor.py` (603 lines) and `upgrade_*_subprocessor.py` family (~7,500 lines
combined) that translate Genie tech effects into nyan **patches** — nyan's native
mechanism for one object modifying another. Age advancement in AoE2 is just a tech, so it
falls out of the same machinery.

The relevant insight: **nyan patches are the tech tree.** A tech is a patch set that
rewrites unit stats in the player's database *view*. Each `Player` has its own
`nyan::View` (`gamestate/player.h:85`), so per-player tech state is a database view
overlay rather than a per-unit stat recalculation. This is an elegant design and you
should steal it.

### 4.9 AI opponent — **does not exist**

No AI module anywhere in `libopenage/`. My grep for AI/opponent found only
`libopenage/main/demo/pong/pong.cpp` (a Pong paddle AI in a demo) and an unrelated
identifier in `input/controller/game/controller.h`. The `README.md` (line 61) aspires to
Python-scripted AI with scikit-learn, and `doc/ideas/ai.md` sketches it. Nothing is built.

### 4.10 UI / HUD — `assets/qml/` + `libopenage/renderer/gui/` (3,754 lines)

Qt Quick / QML. Declarative UI files in `assets/qml/` (19 files: `main.qml`,
`IngameHud.qml`, `ActionsGrid.qml`, various styled controls). The C++ side
(`renderer/gui/`) bridges QML to the engine via `guisys/` and `integration/`, exposing
engine objects as `QObject` property wrappers.

`doc/code/gui.md` is **explicitly marked outdated** and references a `libopenage/economy`
module that does not exist. The QML asset set looks like it belongs to the discarded
prototype. There is a separate `hud` render stage
(`renderer/stages/hud/`) and a HUD input controller (`input/controller/hud/`), which
appear to be the newer path. I would need to trace `presenter.cpp` and the QML engine
initialisation carefully to say which of the two is actually live. **This module is the
one I understand least.**

Separately, `libopenage/console/` (2,367 lines) is an in-engine terminal with a font
renderer — legacy from the prototype.

### 4.11 Save/load — **does not exist**

No serialization of game state anywhere. My grep for `savegame`/`serializ` in
`libopenage/` returned only `rng/rng.cpp`, which serialises RNG seed state — unrelated.
`README.md:74` mentions a *planned* one-way script to convert original maps/savegames.

Worth noting: the curve architecture makes save/load *conceptually* easy (serialise the
keyframe containers) but *voluminous* (you are saving history, not a snapshot).

### 4.12 Networking / multiplayer — **does not exist**

No networking code. My grep hit only `libopenage/util/fds.cpp` (file descriptor
utilities). `doc/code/architecture.md` describes the *goal* architecture — a single
authoritative server running the simulation asynchronously, with clients receiving only
what they can see, and network events entering through the event system. There is also
`doc/reverse_engineering/networking/` documenting the *original* game's protocol, which
openage explicitly will not be compatible with (`README.md:71-72`).

The curve design is the intended enabler: because state is a timeline, a late packet is a
keyframe insert rather than a rollback.

### 4.13 Map format and terrain — `libopenage/gamestate/terrain*.{h,cpp}`

Terrain is chunked. `Terrain` (`terrain.h`) owns a size in tiles and a vector of
`TerrainChunk` (`terrain_chunk.h`), each holding `TerrainTile`s (`terrain_tile.h`). Chunks
must be square and uniform except at the last row/column. `TerrainFactory`
(`terrain_factory.h`) builds terrain from nyan definitions.

`Map` (`gamestate/map.h`) wraps terrain + pathfinder together and maps nyan path-grid
object names to pathfinder grid IDs — the seam between terrain and pathfinding.

**There is no map file format and no map generator.** No `.map` files, no random map
scripts, no scenario format. Terrain is currently constructed procedurally in code for
testing. `doc/ideas/editor/` sketches a future editor.

Coordinate systems are formally specified in `doc/code/coordinate-systems.md` and typed in
`libopenage/coord/`. The world is **isometric with axes NE/SE/UP** — not X/Y/Z.
`phys2`/`phys3` are fixed-point simulation coordinates (origin at the west corner of tile
(0,0)); `tile`/`chunk` are integer grid coordinates; `scene2`/`scene3` are the renderer's
view of the same points; `pixel`/`camhud`/`viewport` are screen space. The renderer
transform is `Eigen(x, y, z) = (SE, UP / sqrt(8), -NE)`. Types are generated from
`coord/coord.h.template` at build time.

### 4.14 Data files for units, civs, techs — **none ship; see `DATA_INVENTORY.md`**

This is the finding that most affects your plan, so it gets its own document. Summary: the
numbers do not live in this repository. They live in the user's Age of Empires
installation, and `openage/convert/` transcodes them into nyan modpacks under
`assets/converted/` at install time. The *schema* those numbers must conform to is
specified in `doc/nyan/api_reference/` (5,188 lines) and constructed in
`openage/convert/service/read/nyan_api_loader.py` (**4,973 lines** — the single largest
source file in the repository, and effectively the machine-readable game data model).

### 4.15 Audio — `libopenage/audio/` (2,130 lines) — **dormant**

An Opus-based audio system: `AudioManager`, `Sound`, `Resource` with in-memory and dynamic
(streaming) loaders, category-based organisation (`category.h`), and a resource
definition format (`resource_def.h`). Format handling in `opus_loading.cpp`.

However: `audio_manager.h:33` carries `TODO: Finish porting to Qt`, and I found **no
references to the audio system from `presenter.cpp` or the engine startup path**. It
compiles (`libopenage/CMakeLists.txt:337` adds the subdirectory) but nothing calls it. It
is orphaned prototype code. The nyan side specifies sound thoroughly
(`ability.property.type.CommandSound` / `ExecutionSound`, `util.sound.Sound`) and the
converter exports Opus files, but nothing plays them.

### 4.16 Localization — **infrastructure only, no strings**

There is no gettext, no `.po` files, no translation catalogues, no runtime string table in
the engine. What exists:

- `openage/convert/value_object/read/media/langcodes.py` — maps the original game's
  language codes to modern ones;
- `openage/convert/value_object/read/media/peresource.py` — extracts string tables from
  Windows PE resource sections of the original executables;
- `ability.type.Named` and `util.language.*` in the nyan spec — the model for
  translatable names/descriptions, with per-language string mappings;
- `internal_nyan_names.py` per game edition (`openage/convert/value_object/conversion/*/`)
  — these map original numeric IDs to human-readable nyan identifiers. Note these are
  *internal identifiers*, not user-facing translations.

So: the engine knows how to *represent* localized names. It ships none, and has no runtime
language switching.

---

## 5. Implementation status — the honest table

This is the summary you should plan against.

| System | Specified in nyan | Implemented in C++ | Verdict |
| --- | --- | --- | --- |
| Rendering | n/a | ✅ Mature | Reference-quality |
| Time / clock | n/a | ✅ Complete | Small, elegant |
| Event loop | n/a | ✅ Complete | Core of everything |
| Curves | n/a | ✅ Complete | The key idea |
| Pathfinding | partial | ✅ Complete | Impressive |
| Entity/component plumbing | ✅ | ✅ 9 components | Skeleton works |
| Movement | ✅ | ✅ | The one real behaviour |
| Idle / Turn / Select | ✅ | ✅ | Trivial behaviours |
| Terrain | ✅ | 🟡 Chunks exist, no map format | Partial |
| Input | n/a | ✅ | Works |
| Coordinate systems | n/a | ✅ | Well specified |
| UI / HUD | n/a | 🟡 QML + HUD stage, unclear which is live | Murky |
| Audio | ✅ | 🟡 Written but not wired up | Dormant |
| Resources | ✅ Full spec | ❌ | Not started |
| Building/construction | ✅ Full spec | ❌ | Not started |
| Combat | ✅ Full spec | ❌ | Not started |
| Tech tree / ages | ✅ Full spec | ❌ | Not started |
| AI | ❌ | ❌ | Nothing |
| Save/load | ❌ | ❌ | Nothing |
| Networking | ❌ (goal doc only) | ❌ | Nothing |
| Map format / generator | ❌ | ❌ | Nothing |
| Localization | ✅ Spec | ❌ | Converter-side only |

Roughly: **8 of 21 systems substantially exist.** Of the twelve gameplay systems that make
an RTS an RTS, **one** (movement) is implemented.

---

## 6. What I could not determine

Stated plainly, per your ground rules:

1. **Which UI path is live.** There are two overlapping UI mechanisms — the QML/Qt Quick
   stack (`assets/qml/` + `renderer/gui/`) and the newer HUD render stage
   (`renderer/stages/hud/` + `input/controller/hud/`). `doc/code/gui.md` is marked
   outdated and references a nonexistent module. I would need to trace
   `presenter/presenter.cpp` initialisation and the QML engine registration end-to-end to
   say which actually draws the in-game interface.

2. **How much of the nyan API the engine can actually parse.** `gamestate/api/` has
   readers for abilities, properties, animations, sounds, terrain, patches, and activities.
   Whether these cover the full 65-ability surface or only the five implemented components,
   I did not verify exhaustively — I would need to read all of `gamestate/api/ability.cpp`
   against the ability enum in `api/types.h`.

3. **Converter fidelity per game edition.** There are eight edition-specific processors
   (`aoc`, `de1`, `de2`, `hd`, `ror`, `swgbcc`, `aoc_demo`, plus HD expansions). I sampled
   `aoc` (the most complete) and skimmed the others. Coverage differences between editions
   are not something I can state without running conversions.

4. **Whether the game is currently runnable at all.** I did not build it. Given the
   README's own assessment, I would expect it to launch, render terrain and a few test
   entities, and let you drag-select and move them.

5. **`libopenage/job/` and `libopenage/datastructure/` usage.** These look like
   prototype-era infrastructure (thread pool, concurrent queue, pairing heap). I did not
   trace who still calls them. The pairing heap is likely the event queue's backing store.

---

## 7. Reading order for a newcomer

If someone joins the project and needs to understand this codebase, send them through in
this order:

1. `doc/code/architecture.md` — the 10,000-foot view
2. `doc/code/time.md` then `doc/code/curves.md` — **do not skip; nothing else makes sense
   without these**
3. `doc/code/event_system.md`
4. `libopenage/gamestate/simulation.cpp` — read the 6-line loop and let it sink in
5. `doc/code/game_simulation/game_entity.md` + `components.md` + `activity.md`
6. `libopenage/gamestate/system/move.cpp` — the one complete behaviour, end to end
7. `doc/code/pathfinding/README.md` + `field_types.md`
8. `doc/nyan/api_reference/reference_ability.md` — the game model as designed
9. `doc/code/renderer/level1.md` + `level2.md`

---

## 8. Document set

| Document | Contents |
| --- | --- |
| `ARCHITECTURE.md` | This file — top-down map of the codebase |
| `SYSTEMS.md` | Per-system detail and TypeScript/PixiJS/miniplex port notes |
| `DATA_INVENTORY.md` | Where game content lives (spoiler: not here) and what must be authored |
| `PATHFINDING_NOTES.md` | External: lessons from the *shipping* AoE2 codebase on the hardest system |
| `PORT_PLAN.md` | Proposed phase ordering with justification and a risk register |

---

*Source provenance: analysed against the working tree (master, shortly after tag `v0.6.0`).
The separately supplied `openage_v0.6.0_release_source_code.zip` (commit `8488314`) was
diffed against it and is substantively identical for architectural purposes — same 5 API
components, same 4 systems, same flow-field pathfinder. See `SYSTEMS.md` §0 for the exact
differences.*
