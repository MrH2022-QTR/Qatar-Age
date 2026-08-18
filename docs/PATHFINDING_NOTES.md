# PATHFINDING NOTES — Lessons from the Shipping Age of Empires Codebase

**External source, not from this repository.**

> **"Age of Empires: 25+ years of pathfinding problems with C++"**
> Raymi ("Ry") Klingers — Engineering Director, **Forgotten Empires**
> Meeting C++ 2025 · <https://www.youtube.com/watch?v=lEBQveBCtKY>

Forgotten Empires is the studio that develops the official *Age of Empires* Definitive
Editions. This talk is therefore about the **real, shipping, commercial AoE2 codebase** —
not openage. It is a first-hand account from the engineer who fixed a 25-year-old
pathfinding bug, and it is the single best external source I found for this project.

Analysis below is mine, drawn from the talk's auto-generated transcript (8,628 words;
raw transcript retained in the session scratchpad, not committed). Where I quote, I quote
the transcript; auto-captions may garble occasional words, and I've marked reconstructions.

**Why this belongs in the port docs:** `SYSTEMS.md` §4 identifies pathfinding as the
hardest system to port. This talk is direct evidence on that question from someone who has
shipped it commercially seven times, and it **changes my recommendation** — see §7.

---

## 1. Two codebases, one problem

Worth being precise about what we now have, because they are different artifacts:

| | **openage** (this repo) | **Age of Empires DE** (the talk) |
| --- | --- | --- |
| Origin | Clean-room reimplementation | The actual 1999 codebase, maintained |
| Age | ~2013– | 25+ years |
| Style | Modern C++20, data-oriented leanings | **"100% object-oriented"**, C-with-classes |
| Short-range pathing | Flow fields (Emerson) | Convex/concave hulls + ray casting |
| Long-range pathing | Portal graph + A* | **Mipmapped A\*** (quadtree-like) |
| Determinism | Fixed-point, by design | Deterministic sim; replays as bug repros |
| Status | Pathfinder complete, gameplay absent | Shipping, played by millions |

They converge on the same **two-tier structure** — a cheap coarse search over a simplified
map, then an expensive fine search only between the waypoints it returns. openage does
portal-graph A* → flow fields; AoE2 does mipmapped A* → hull-walking. That two independent
teams arrived at the same shape is a strong signal, and it's the one structural idea I'd
carry into our port regardless of which algorithms fill each tier.

---

## 2. Why AoE2 pathfinding is genuinely hard

Ry frames it as: AoE2 **deliberately did not take the easy path**. The constraints:

- **Units bump, stop, repath, and go around.** Repeated until they reach the goal.
- **No pushing.** Units never shove each other aside.
- **No overlap** — except within formations, which allow friendly overlap. So there are
  *two* movement systems that must interact.
- **Fully random, fully dynamic maps.** Every tile can change at runtime.
- **Mixed granularity:** obstructions (buildings, water) snap to the grid, but **units move
  freely off-grid.** This is the detail that defeats most simplifications, and it came up
  again in Q&A — an audience member suggested snapping everything to a fixed-point grid,
  and Ry's answer was that buildings already are, but *units aren't, and the algorithm
  includes units*.

### The StarCraft 2 contrast

Ry holds up SC2 as the standard players actually want, and is explicit about why it's
easier: SC2 **simplified the problem up front** — fixed (non-random) maps, steering
behaviours, small overlaps permitted, units slide past each other.

Asked in Q&A what he'd do starting from scratch, his answer was unambiguous:

> "I would definitely keep to squares, but I would go with the StarCraft approach by just
> simplifying the problem at the very beginning. **Players just like that better.**"

**This is the most important sentence in the talk for our purposes.** The engineering
director of the studio that maintains AoE2 pathfinding, asked what he'd do with a green
field, says: don't do what AoE2 did.

We have a green field.

### The counter-argument he also makes

Fairly, he notes the community *loves* the emergent play the strict model enables — his
example is a player walling off knights with houses and then blocking the last gap with a
**fishing ship**, executed on a controller emulating a mouse. Strict collision is what
makes body-blocking and walling real tactics.

So it's a genuine trade, not a free win: strict no-overlap gives you emergent blocking
tactics and a permanently unhappy community; permissive steering gives you smooth movement
and loses some tactical depth. **Worth an explicit design decision for Kingdoms of Qatar
rather than an accident.** My recommendation is in §7.

---

## 3. How AoE2's short-range pathfinder actually works

Ry notes this is **~10% of the overall pathfinding problem** and was entirely
undocumented — no articles, no comments explaining it. He reconstructed it by reading code.

The original algorithm:

1. **Gather obstructions** in a square search area between start and goal. All AoE2
   obstructions are **axis-aligned rectangles** — a helpful simplification.
2. **Minkowski reduction:** shrink the moving unit to a point, and expand every obstruction
   by what you removed. Now you path a *point* around fattened rectangles instead of a
   rectangle around rectangles.
3. **Build convex hulls** around obstruction clusters, using the **gift wrapping**
   algorithm.
4. **Escape the starting hull:** shoot rays in the four cardinal directions; on hitting an
   obstruction, shoot sideways; keep bouncing until outside.
5. **Walk the hull edges.** At every vertex, shoot a ray toward the goal. If it hits, repeat
   the process from there.
6. **Smooth the path** by brute-force removing points and testing whether the shortened
   path still clears all obstructions.

Edge cases: if the goal is inside a hull, run the same process backwards from the goal and
join the two (roughly bidirectional). If a hull escapes the search area, expand and retry.
If completely enclosed, bounce randomly for **up to 64 iterations** and then give up.

Ry's reaction on discovering this is worth recording:

> "How did this ship performantly in 1999?"

The answer: the code itself is well written, and the **mipmapped A\* long-range** pass did
the heavy lifting, leaving short-range paths short.

---

## 4. The 25-year bug: floating-point precision

This is the core of the talk and the most transferable engineering lesson in it.

### The failure

Gift wrapping's inner test is: given three points, is this a **left turn or a right turn**?
Left → discard the middle point; right → keep it. The algorithm requires that answer to be
**exactly right, every time**.

When points are nearly **collinear** or very close together, floating-point precision isn't
sufficient to decide. One wrong answer and the convex hull **cuts through an obstruction**
instead of enclosing it. Walk that hull to build a path, and the path runs straight through
a building.

**That is why AoE units walk through walls.** The same bug affected Age of Empires 2, Age
of Empires 3, and Age of Mythology.

### Two failed fixes

- **The original 1999 developers** clearly hit it — Ry found code that removes
  near-coincident points. It reduced the frequency; it didn't fix it.
- **Age of Empires 3 DE** promoted `float` → `double`. Also didn't fix it, just made it
  rarer. Ry is fair about this: rarer *is* an improvement, because players suffer less.

Neither addressed the root cause, because neither knew what it was.

### The root cause — and "the perfect crime"

The actual culprit is **x87 80-bit extended precision**.

Old x86 hardware computed floating-point in 80-bit registers, keeping extra precision in
*intermediate* results. In 1999 the pathfinder was, unknowingly, relying on it. Then SSE/SIMD
arrived and traded that extended precision away for speed.

The sequence, as Ry reconstructs it:

1. A previous company **enabled the SIMD compiler flag** — a performance win, and nobody
   noticed it had silently degraded pathfinding precision.
2. Forgotten Empires later **disabled the SIMD flag** — but in the same work **ported the
   game to 64-bit**, and *x64 uses SSE2 for floating point unconditionally*. Turning the
   flag off changed nothing.
3. So the cause was masked. And the **source history had been lost** in the code drop, so
   there was no way to bisect to it.

> "That was the perfect crime."

He found it by accident: while chasing the bug in Age of Mythology: Extended Edition, he
manually disabled what he believed were optimisation flags — and inadvertently switched off
SIMD, falling back to IA-32/x87 instructions. The bug vanished.

He asked the room for a show of hands: who knew that enabling SIMD costs you floating-point
precision? Almost nobody. He didn't either.

**The community had been right for years** that pathfinding was worse than the 1999 release,
while every team insisted they hadn't touched it. They hadn't — not directly.

---

## 5. The fix (shipped ~2024)

Rather than patch the precision problem, Ry replaced the geometry.

### 5.1 Concave hulls by edge walking

Instead of gift-wrapping convex hulls:

1. **Pre-compute rectangle intersection points.** For axis-aligned rectangles this is a few
   min/max operations — and, importantly, it stays valid under **radius expansion**, since
   every unit has a different radius (you only need to know which way each intersection
   point slides as the radius changes).
2. **Pick any point on an edge and walk**, with three rules:
   - reach the **end of an edge** → turn **right**
   - reach an **intersection** → turn **left**
   - **perfectly aligned overlapping** rectangles → go **straight** (added after testing
     revealed the edge case: turning either way walks off or into the shape)
3. Continue until the walk **loops**. That loop is the concave hull.

The result is a simple polygon, convertible to a convex hull in linear time if wanted — Ry
never needed to.

### 5.2 The self-verifiable property

This is the idea I'd most like to steal, and it generalises far beyond pathfinding.

The algorithm has a checkable invariant:

> If you start from a point on an edge that is **not overlapped by any other rectangle**,
> the edge walk always produces a shape that **does not overlap any rectangle**.

So the code can validate its own output at runtime: is the hull unclosed? did it loop
forever? does it overlap an obstruction? Any of these → dump the full path request and all
inputs needed to reproduce it.

Ry calls this a **"self-verifiable algorithm"** — one that carries a cheap check of its own
correctness.

### 5.3 Fuzzing via the game itself

The validation harness was: **run the game with 8 AI players in a team game at maximum
speed**, generating millions of paths. Whenever the self-check flagged a failure — or he
spotted a visually wrong path or a stuck unit — dump it, load it into a small standalone
debugging app, and fix it.

Over a few months this accumulated **~100 regression test cases**:

> "100 bugs that I did not think about when I was implementing the algorithm, and the
> algorithm would just tell me, 'you're doing it wrong', for 100 times."

And, tellingly:

> "I would not have known where to even start if I did not have this system."

### 5.4 Fixed-point math

Even the new algorithm hit precision failures, because it relies on addition and
subtraction being exact — and floating-point addition/subtraction rounds when crossing
exponent ranges, so `(180 + 1) - 1` is not reliably `180`.

**The fix was fixed-point arithmetic**, where precision is lost only on multiply/divide.
That closed the last hole.

Note that openage independently made the same choice — `time::time_t` and `coord::phys`
are fixed-point throughout. Two teams, same conclusion.

### 5.5 The new pathing flow

1. Reduce unit to a point; expand obstructions by its radius.
2. **Shoot a ray at the goal.** Nothing hit → done, walk straight there.
3. Something hit → that's the starting edge point. **Walk the edge.**
4. At each vertex, re-shoot a ray at the goal. Repeat until reached.
5. Brute-force smoothing, as before.

Two refinements worth noting:

- **Bounding the walk.** A hull touching the map edge would otherwise walk the entire map
  perimeter. Fix: insert **four rectangles around the search area** so the walk is confined.
  (They do 300–400 paths per frame; walking the map once per path is not survivable.)
- **Left/right turn counting for early-out.** While walking, count turns. Four more rights
  than lefts → you're on the *outside*. Four more lefts than rights → you're *inside a
  hole*. If you're inside a hole and the goal isn't in it, **the goal is unreachable** —
  bail immediately and path to the closest reachable point. The old algorithm had no such
  test; it bounced randomly 64 times and gave up.

### 5.6 Results

| Metric | Outcome |
| --- | --- |
| Average speed | **~2× faster** (with, he notes, no real optimisation work) |
| Old worst case | **14× faster** |
| New worst case | Still ~10% faster than the old algorithm's |
| Guarantees | **If a path exists, it is found** — no 64-iteration give-up |
| Robustness | Self-verification + ~100-case regression suite |
| Frame budget | Pathfinding went from **~70%** of frame time (at the start of the 64-bit port) to **~20%** |

And, finally, positive community poll results — after about 12 years of the problem being
known and 11 years of Ry working at the studio.

---

## 6. Performance and process notes worth keeping

Scattered through the talk and Q&A:

- **Path budgeting.** AoE2 caps paths at ~**15 per player per frame**, deferring the rest.
  But they **disabled the cap for human players** because responsiveness matters more than
  smooth frame times. Deferring paths across frames was tried in Age of Empires 1 and made
  units feel bad — and can enter a death spiral.
- **Determinism pays off in support.** Because the simulation is deterministic, players
  submit **replays**, and a replay plus a timestamp is a *perfect* reproduction case. This
  is a real, concrete argument for determinism beyond multiplayer.
- **The long-range A\* priority queue was a linked list** — "the fastest linked list I've
  ever run into in my life," and still a major performance problem. Data structure choice
  outranks micro-optimisation.
- **Codebase realities:** 100% object-oriented; **move semantics don't work**, so putting
  an object into a `std::vector` can introduce a bug; Perforce, not git; source history
  lost; largest sprite is **almost a gigabyte**.
- **"Ritual programming":** to add a feature you must remember to call certain functions or
  unrelated systems break. Undocumented, no compile error, no runtime error. Just tribal
  knowledge — and the original developers are all gone.
- **Modernisation is iterative, never a rewrite**, and is protected by a test harness of
  100+ tests.
- **Motivation:** asked how he sustained a multi-year bug hunt — he's played these games
  since he was four.

---

## 7. What this changes for Kingdoms of Qatar

`SYSTEMS.md` §4 already recommended starting with grid A* and deferring flow fields. This
talk **strengthens that**, and adds four specific commitments.

### 7.1 Simplify the movement model deliberately — and up front

Ry, given a green field, would take the StarCraft approach. Take him at his word.

**Recommendation: allow soft collision.** Units repel each other with a steering force
rather than hard-blocking, and may briefly overlap while resolving. Concretely:

- Path on a grid, ignoring other units.
- Apply local separation steering (a simple boids-style repulsion) among nearby units.
- Treat only **buildings and terrain** as hard obstructions.

This eliminates, by construction, the entire class of problem the talk is about: no
hull geometry, no near-collinear degeneracy, no unit-shaped dynamic obstacles invalidating
paths, no 64-iteration bounce. It is also what players report preferring.

**The cost, stated honestly:** we lose body-blocking and gap-plugging as tactics — the
fishing-ship play. For a browser RTS aimed at a broad audience, smooth movement is the
better trade. But it should be a decision we make on purpose, and revisit if playtesting
says otherwise. (One reasonable middle path: hard collision for buildings and *walls*
specifically, soft among mobile units — walls remain a real tactical structure without
resurrecting unit-vs-unit geometry.)

### 7.2 Adopt the two-tier structure from the start

Both codebases independently arrived at coarse-then-fine. Build it in early, because
retrofitting a hierarchy is invasive:

- **Coarse:** A* over a downsampled grid (e.g. 8×8 tile blocks) → waypoints.
- **Fine:** A* or direct steering between consecutive waypoints.

This alone is most of what makes long paths affordable, and it's far less work than flow
fields.

### 7.3 Build the self-verification harness early

This is the most transferable idea in the talk, and it costs little:

1. Give the pathfinder a **debug validation mode**: does the returned path pass through any
   impassable tile? does it start at the start and end at (or nearest-reachable-to) the
   goal? are consecutive waypoints adjacent/visible? is the iteration count sane?
2. On failure, **serialise the entire request** — grid state, start, goal, unit radius — to
   JSON.
3. Build a **standalone replay page** that loads such a JSON and renders it. Ry's separate
   debugging app was central to his workflow.
4. **Fuzz it**: run headless matches with AI players at maximum speed and collect failures.
   Our simulation is headless-capable by design (`SYSTEMS.md` §1), so this is nearly free.
5. Keep every failure as a **regression test**.

Because our simulation is plain-data and headless, we can do this *better* than a native
codebase — the fuzz harness is just a Node script.

### 7.4 Decide the numeric model now, not later

Both codebases converged on **fixed-point**, for the same reason: geometric and simulation
predicates need exact addition and subtraction.

`SYSTEMS.md` §2 recommended floats for a single-player browser game, isolating arithmetic
behind a small module. **That recommendation stands, with a sharpened caveat:** floats are
fine *because* §7.1 removes the exact-predicate requirement. If we ever reintroduce hard
collision with polygon geometry — or pursue lockstep multiplayer — we inherit this bug
class, and at that point fixed-point stops being optional.

So the isolation discipline matters more than it seemed: keep all simulation arithmetic
behind `sim/math.ts` and all randomness behind `sim/random.ts`, so the switch is one file.
That's a near-zero cost now against a very expensive retrofit later. This talk is 25 years
of evidence for exactly how expensive.

### 7.5 Two smaller items worth copying directly

- **Path budgeting per frame**, with human-issued commands exempt. Cheap insurance against
  frame spikes when an AI sends 200 units somewhere, and it preserves the responsiveness
  players notice.
- **Unreachability detection.** Whatever algorithm we use, detect "no path exists" *early*
  and cheaply, and fall back to "move to nearest reachable point." AoE2's 64-iteration
  flail is the canonical example of getting this wrong, and enclosed-target cases are
  common in real matches (walled bases, islands).

---

## 8. One-paragraph summary

The official Age of Empires codebase spent 25 years with units walking through walls
because its convex-hull pathfinder needed exact floating-point left/right-turn decisions,
silently lost the x87 80-bit intermediate precision it had unknowingly depended on when a
compiler SIMD flag was enabled, and then had the cause masked by a 64-bit port that made
SSE mandatory — with the source history lost, so it couldn't be bisected. The fix was a new
edge-walking concave-hull algorithm built on fixed-point arithmetic, carrying a cheap
self-verification invariant, validated by fuzzing the game with eight AI players at maximum
speed to harvest ~100 regression cases; it runs about twice as fast, 14× faster in the old
worst case, and always finds a path if one exists. For *Kingdoms of Qatar* the operative
lessons are: **simplify the movement model up front** (the author's own answer to "what
would you do from scratch"), **build coarse-then-fine pathing**, **make the pathfinder
check its own output and fuzz it from day one**, and **isolate simulation arithmetic**
so the fixed-point decision stays reversible.
