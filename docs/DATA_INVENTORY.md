# DATA INVENTORY — Where Game Content Lives

**Purpose:** map every data file, config, and asset directory that defines game content, so
we know exactly what must be authored or replaced for *Kingdoms of Qatar*.

---

## 0. The headline finding

**This repository contains no game content.**

Not "little" — none. There are no unit stats, no buildings, no civilizations, no
technologies, no maps, no campaigns, and no localized strings anywhere in the tree.

I verified this several ways:
- `find . -name "*.nyan"` returns **exactly one file**: `assets/test/nyan/pong.nyan`, a
  fixture for a Pong demo.
- `assets/` contains only shaders, QML, logo art, and test textures.
- The `.gitignore` in `assets/` excludes `assets/converted/` — the directory where content
  would live at runtime.
- `libopenage/gamestate/simulation.cpp:33` points the mod manager at
  `root_dir / "assets" / "converted"`, a path that does not exist in a fresh checkout.

Instead, content is **generated at install time**. The user runs the converter
(`openage/convert/`, 73,391 lines of Python) against their own legally-owned copy of Age
of Empires; it reads the original binary data files and emits openage-native **modpacks**
into `assets/converted/`.

### What this means for Kingdoms of Qatar

This is, on balance, **good news**:

1. **Nothing to strip.** You were replacing all content anyway. There is no original
   Microsoft/Ensemble game data in this repo to disentangle, and no risk of accidentally
   shipping it.
2. **You inherit a schema, not a dataset.** The repository's contribution is a rigorous,
   documented **specification** of what an AoE-like game's data must contain — 5,188 lines
   of API reference plus a 4,973-line loader that constructs it programmatically. That
   schema is the genuinely valuable artifact, and it's exactly what you need when
   authoring original Qatari content from scratch.
3. **The converter is dead weight for you.** 73,391 lines — 43% of the entire repository —
   exists to read 1999-era binary formats (DRS archives, SLP/SMP/SMX/SLD sprites,
   `empires2.dat`, PE resource string tables, MS-CAB installers). You will port **none** of
   it. Do not let its size mislead you about the project's scope.

So: the "map we'll use later to swap in Qatari content" is not a list of files to edit.
It is a **schema to author against**. Sections 3–5 below are that schema.

---

## 1. Content that ships in this repository

Complete list. Everything here is engine scaffolding, not game content.

| Path | Format | Defines |
| --- | --- | --- |
| `assets/shaders/*.glsl` | GLSL | 67 shader files: terrain, world sprites, team colours, skybox, screen blit, fonts |
| `assets/qml/*.qml` | QML | 19 UI files: `main.qml`, `IngameHud.qml`, `ActionsGrid.qml`, styled controls |
| `assets/logo/` | SVG/PNG/ICO | Project branding |
| `assets/doc/` | SVG | Badges for the README |
| `assets/test/nyan/pong.nyan` | nyan | **The only nyan data file.** Pong demo fixture |
| `assets/test/textures/*.texture` | custom text | Test texture definitions |
| `assets/test/textures/*.sprite` | custom text | Test animation definitions |
| `assets/test/textures/*.terrain` | custom text | Test terrain definitions |
| `assets/test/shaders/`, `assets/test/qml/` | GLSL/QML | Renderer demo fixtures |
| `cfg/keybinds.oac` | custom text | **Default keybindings** — the only shipped gameplay-adjacent config |
| `cfg/converter/games/game_editions.toml` | TOML | Which AoE editions the converter recognises |
| `cfg/converter/games/game_expansions.toml` | TOML | Expansion definitions |
| `cfg/converter/games/*/version_hashes.toml` | TOML | 13 files: checksums identifying installed game versions |
| `openage_version` | text | `0.6.0` |

That is the entire content inventory of the repository.

---

## 2. Content that is generated at install time

The converter emits **modpacks** into `assets/converted/`. Structure per
`doc/media/openage/modpacks.md` and `modpack_definition_file.md`:

```
assets/converted/
  <modpack_name>/
    modpack.toml              ← the only mandatory file
    data/                     ← nyan game data
      game_entity/
        generic/<unit>/<unit>.nyan
        ...
      tech/…  civ/…  terrain/…  util/…
    graphics/                 ← .texture + .sprite + .png
    sounds/                   ← .opus
```

| Artifact | Format | Defines |
| --- | --- | --- |
| `modpack.toml` | TOML | Package name, version, aliases, asset include/exclude globs, dependencies, conflicts, load order |
| `data/**/*.nyan` | **nyan** | **All game data**: units, buildings, techs, civs, terrain, abilities, effects, resources |
| `graphics/*.texture` | custom text | Spritesheet: image file + size + subtexture rects |
| `graphics/*.sprite` | custom text | Animation: layers, angles, frame sequences, scale factor |
| `graphics/*.terrain` | custom text | Terrain tile animation/frames |
| `graphics/*.blmask` / `*.bltable` | custom text | Terrain edge blend masks and lookup table |
| `graphics/*.pal` | custom text | Palette definitions |
| `graphics/*.png` | PNG | The actual pixels |
| `sounds/*.opus` | Opus | Audio |
| `manifest` hashes | text | Integrity checking (`generate_manifest_hashes.py`) |

Format specifications, all in `doc/media/openage/`:
`modpack_definition_file.md`, `sprite_format_spec.md`, `texture_format_spec.md`,
`terrain_format_spec.md`, `blendmask_format_spec.md`, `blendtable_format_spec.md`,
`palette_format_spec.md`, `file_referencing.md`.

### The custom text formats

These are simple, line-oriented, and easy to read or generate. Real example
(`assets/test/textures/test_tank.sprite`):

```
version 2
texture 0 "test_tank.texture"
scalefactor 2.0
layer 0 mode=off
angle 0
angle 45
...
frame 0 0 0 0 0        # layer, angle, index, ?, subtexture-id
frame 0 45 0 0 1
```

And `test_tank.texture`:

```
version 1
imagefile "test_tank.png"
size 153 178
subtex 0 0 76 89 38 44   # x, y, w, h, anchor-x, anchor-y
```

**Port note:** these map almost directly onto a PixiJS spritesheet JSON. The `.texture`
file is an atlas descriptor (rects + anchors); the `.sprite` file is an animation
descriptor (angle → frame sequence). Rather than adopting these formats, emit standard
PixiJS spritesheet JSON plus a small custom animation JSON that keeps the **angle
dimension** — that's the one thing standard spritesheet formats don't model and that an
isometric RTS absolutely needs.

---

## 3. The schema — where the game model is actually defined

This is the part worth your attention. Two sources define the complete data model.

### 3.1 `doc/nyan/api_reference/` — the human-readable specification

| File | Lines | Defines |
| --- | --- | --- |
| `reference_ability.md` | 1,137 | **65+ ability types** — everything an entity can do |
| `reference_util.md` | 2,744 | Supporting types: attributes, costs, resources, formations, activities, patches, languages |
| `reference_modifier.md` | 552 | Conditional stat modifiers (bonuses by terrain, elevation, etc.) |
| `reference_effect.md` | 403 | What an action *does* to a target |
| `reference_resistance.md` | 340 | What a target resists |
| `reference_root.md` | 12 | Root object |

**Total: 5,188 lines of specification.** Read `reference_ability.md` and
`reference_effect.md` before designing your own data model — they encode 25 years of
accumulated AoE design in a coherent structure, and they will save you from mistakes
you'd otherwise make and discover in month four.

The 65 ability types, grouped by the system they serve:

| System | Ability types |
| --- | --- |
| **Movement** | `Move`, `Turn`, `Fly`, `Pathable`, `Formation`, `Stop` |
| **Combat** | `ApplyDiscreteEffect`, `ApplyContinuousEffect`, `ShootProjectile`, `Projectile`, `Resistance`, `GameEntityStance`, `AttributeChangeTracker`, `RegenerateAttribute` |
| **Economy** | `Gather`, `Harvestable`, `DropResources`, `DropSite`, `ResourceStorage`, `Restock`, `RegenerateResourceSpot`, `ExchangeResources`, `Trade`, `TradePost` |
| **Construction/Production** | `Constructable`, `Foundation`, `Create`, `ProductionQueue`, `RallyPoint`, `TerrainRequirement`, `OverlayTerrain` |
| **Tech** | `Research` |
| **Containers** | `Storage`, `EnterContainer`, `ExitContainer`, `CollectStorage`, `RemoveStorage`, `TransferStorage`, `SendBackToTask` |
| **Vision/Stealth** | `LineOfSight`, `Visibility`, `Cloak`, `DetectCloak` |
| **Lifecycle** | `Live`, `Despawn`, `ActiveTransformTo`, `PassiveTransformTo`, `Idle` |
| **Herding** | `Herd`, `Herdable` |
| **Misc** | `Named`, `Selectable`, `Collision`, `Lock`, `Activity`, `ProvideContingent`, `UseContingent` |

Ability *properties* (orthogonal modifiers): `Animated`, `AnimationOverride`,
`CommandSound`, `ExecutionSound`, `Diplomatic`, `Lock`, `Ranged`.

### 3.2 `openage/convert/service/read/nyan_api_loader.py` — the machine-readable schema

**4,973 lines — the largest single source file in the repository.** It programmatically
constructs the entire nyan API: every ability type, effect type, resistance type, resource
type, and their members, with types and defaults.

This is arguably **the most useful single file in the repo for your project**. It is the
specification in executable form. If you want a starting point for your TypeScript type
definitions, transcribing this file's structure is a defensible way to begin — it gives
you a complete, internally consistent RTS data model for free.

### 3.3 Changelogs

`doc/changelogs/nyan_api/` tracks schema evolution across versions — useful for
understanding *why* the model is shaped as it is.

---

## 4. Where content comes from — converter input

For completeness, and to make clear how much you're skipping. **None of this is ported.**

### Original game files read by the converter

| Input | Format | Contains | Reader |
| --- | --- | --- | --- |
| `empires2_x1_p1.dat` (and per-edition variants) | Genie binary (compressed) | **All unit/building/tech/civ stats** | `openage/convert/value_object/read/media/datfile/` |
| `*.drs` | DRS archive | Bundled graphics, sounds, palettes | `media/drs.py` |
| `*.slp` | Genie sprite | Original sprite frames (palette-indexed) | `media/slp.pyx` |
| `*.smp` / `*.smx` | Genie sprite (DE) | Definitive Edition sprites | `media/smp.pyx`, `smx.pyx` |
| `*.sld` | Genie sprite (DE2) | Newest DE sprite format | `media/sld.pyx` |
| `*.pal` / `*.bina` | Palette | Colour tables, incl. player colours | `media/colortable.py` |
| `blendomatic.dat` | Genie binary | Terrain blend masks | `media/blendomatic.py` |
| `*.wav` / `*.mp3` | Audio | Sounds and music | (transcoded to Opus) |
| `language*.dll` | Windows PE | **Localized string tables** | `media/peresource.py`, `pefile.py` |
| Installer `.cab` | MS-CAB | Compressed install payload | `openage/cabextract/` |

`doc/media/` documents each of these formats in detail — `slp-files.md`, `smx-files.md`,
`sld-files.md`, `drs-files.md`, `blendomatic.md`, `sound.md`, plus ImHex hex patterns in
`doc/media/patterns/`. This is impressive reverse-engineering work and completely
irrelevant to you.

### Converter processing pipeline

`openage/convert/processor/conversion/` has one processor per supported edition —
`aoc/` (Age of Conquerors, the most complete), `de1/`, `de2/`, `hd/`, `ror/` (Rise of
Rome), `swgbcc/` (Star Wars), `aoc_demo/`. Each contains:

| File | Lines (aoc) | Role |
| --- | --- | --- |
| `ability_subprocessor.py` | 7,582 | Genie unit flags → nyan abilities. **Largest file in the converter.** |
| `upgrade_attribute_subprocessor.py` | 2,774 | Tech attribute effects → patches |
| `pregen_processor.py` | 2,329 | Pre-generated shared objects |
| `upgrade_ability_subprocessor.py` | 2,135 | Tech ability effects → patches |
| `upgrade_resource_subprocessor.py` | 1,540 | Tech resource effects → patches |
| `processor.py` | 1,409 | Orchestration |
| `nyan_subprocessor.py` | 1,299 | Entry points: `unit_line_to_game_entity`, `building_line_to_game_entity`, `tech_group_to_tech`, `civ_group_to_civ`, `terrain_group_to_terrain` |
| `effect_subprocessor.py` | 981 | Armour classes → effects/resistances |
| `auxiliary_subprocessor.py` | 772 | Creatables, production |
| `civ_subprocessor.py` | 645 | Civilization bonuses |
| `tech_subprocessor.py` | 603 | Tech definitions |
| `modifier_subprocessor.py` | — | Conditional modifiers |
| `media_subprocessor.py` | — | Graphics/sound references |
| `modpack_subprocessor.py` | — | Modpack assembly and file layout |

`nyan_subprocessor.py` is worth skimming even though you won't port it: its five top-level
functions are precisely the five content categories you need to author, and reading how it
builds each one tells you what fields a complete definition requires.

### Converter internal name maps

`openage/convert/value_object/conversion/*/internal_nyan_names.py` (one per edition,
~590 lines for SWGB) map original numeric IDs to readable identifiers.

**Read the caveat:** these are *internal identifiers* (`"ARCHER"`, `"TOWN_CENTER"`), not
user-facing translations. It's easy to mistake them for a string table. Actual display
strings come from the PE resource extraction and land in nyan `Named`/`TranslatedString`
objects.

---

## 5. The authoring checklist for Kingdoms of Qatar

Since there is nothing to swap, here is what must be **created**. This is the real
deliverable of this document.

### 5.1 Static data (JSON — recommended over inventing a nyan equivalent)

| File | Defines | Rough scale (AoE2 reference) |
| --- | --- | --- |
| `data/units.json` | Unit types: stats, costs, abilities, sprite refs, sounds | ~100 base + upgrades |
| `data/buildings.json` | Building types: footprint, HP, cost, build time, what it produces | ~40 |
| `data/techs.json` | Techs: cost, research time, prerequisites, **patches applied** | ~150 |
| `data/civs.json` | Civilizations: bonus patches, unique units/techs, tech-tree exclusions | 5–10 to start |
| `data/resources.json` | Resource types and properties | 4–6 |
| `data/terrain.json` | Terrain types: passability, movement cost, tile graphics | ~20 |
| `data/effects.json` | Damage/effect types and armour classes | ~10 |
| `data/ages.json` | Age definitions and advancement requirements | 4 |
| `data/sounds.json` | Sound definitions by category | ~200 |

### 5.2 Assets

| Path | Format | Notes |
| --- | --- | --- |
| `assets/atlases/*.json` + `*.png` | PixiJS spritesheet | **One atlas per logical group.** Atlas discipline is the main determinant of frame rate. |
| `assets/animations/*.json` | Custom | Angle → frame sequence mapping (the dimension standard spritesheets lack) |
| `assets/terrain/*.png` | PNG | Terrain tiles |
| `assets/audio/*.ogg` | Opus/Vorbis | With `.m4a` fallback |
| `assets/ui/` | PNG/SVG/CSS | HUD chrome — DOM-rendered per `SYSTEMS.md` §10 |

### 5.3 Localization

| Path | Format | Notes |
| --- | --- | --- |
| `locales/en.json` | JSON | Flat key → string |
| `locales/ar.json` | JSON | **Plan for RTL from day one** — see `SYSTEMS.md` §16 |

### 5.4 Maps

| Path | Format | Notes |
| --- | --- | --- |
| `maps/*.json` | JSON | `{width, height, tiles: number[], entities: [...]}`. Gzip if needed. |

### 5.5 Historical research needed (not a code task, but on the critical path)

For original Qatari civilizations, content design needs source material on:
- Settlements and their periods — Al Zubarah (UNESCO-listed), Al Bidda, Al Khor, Al Wakrah, Doha, Murwab
- The pearling economy — dhow types, diving seasons, `nahham`, the merchant/captain/diver hierarchy
- Trade networks — Gulf routes, Indian Ocean links, date and pearl exports
- Fortifications — Al Zubarah Fort, Barzan Towers, Al Koot
- Tribal/political structures — Al Thani, Al Bin Ali, and others
- Material culture for visual reference — architecture (coral stone, gypsum, wind towers), dress, vessels

**A candid note:** this is the part of the project most likely to be underestimated. The
code schema will accept whatever numbers you give it; making a Qatari civ set that is both
*historically defensible* and *fun to play* is a genuine design and research problem, and
it is worth starting in parallel with engineering rather than after it. It's also where
the project's distinctiveness lives — the engine is a means to it.

---

## 6. Summary table — content authority

| Content type | In this repo? | Where it really lives | What you do |
| --- | --- | --- | --- |
| Unit stats | ❌ | User's `empires2.dat` → converted nyan | Author `units.json` |
| Building stats | ❌ | Same | Author `buildings.json` |
| Techs | ❌ | Same | Author `techs.json` |
| Civilizations | ❌ | Same | Author `civs.json` |
| Terrain types | ❌ | Same | Author `terrain.json` |
| Maps | ❌ | **Nowhere — no map format exists** | Design format + author maps |
| Campaigns | ❌ | **Nowhere — no campaign system exists** | Design from scratch |
| Sprites | ❌ | User's `.drs`/`.slp` → converted | Create original art |
| Sounds | ❌ | User's `.drs` → Opus | Create original audio |
| Strings | ❌ | User's `language.dll` → nyan | Author `locales/*.json` |
| Keybindings | ✅ | `cfg/keybinds.oac` | Reference only |
| **Data schema** | ✅ | `doc/nyan/api_reference/` + `nyan_api_loader.py` | **Adopt this** |
| Asset format specs | ✅ | `doc/media/openage/` | Reference; use PixiJS formats |
| Shaders | ✅ | `assets/shaders/` | Reference (esp. `teamcolors.frag.glsl`) |
