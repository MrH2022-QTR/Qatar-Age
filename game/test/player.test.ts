import { describe, expect, it } from 'vitest'
import { Player, PlayerDataView } from '../src/sim/player'
import { BASE_DATA } from '../src/data'

/**
 * These tests pin down the mechanism docs/SYSTEMS.md §8 calls the best idea in
 * openage: a per-player layered view over the static tables, where researching a
 * tech patches the view rather than mutating entities.
 *
 * The properties that make it worth copying are exactly what is asserted here —
 * per-player isolation, no entity touched on upgrade, and civs being nothing
 * more than a named patch list.
 */
describe('PlayerDataView', () => {
  it('returns base stats when nothing is patched', () => {
    const v = new PlayerDataView()
    expect(v.unit('spearman').attack?.melee).toBe(BASE_DATA.units.spearman!.attack!.melee)
  })

  it('applies an additive patch', () => {
    const v = new PlayerDataView()
    const before = v.unit('spearman').attack!.melee!
    v.applyPatches([{ target: 'spearman', field: 'attack.melee', op: 'add', value: 3 }])
    expect(v.unit('spearman').attack!.melee).toBe(before + 3)
  })

  it('applies a multiplicative patch', () => {
    const v = new PlayerDataView()
    const before = v.unit('camel_rider').speed
    v.applyPatches([{ target: 'camel_rider', field: 'speed', op: 'mul', value: 1.1 }])
    expect(v.unit('camel_rider').speed).toBeCloseTo(before * 1.1, 10)
  })

  it('stacks patches in application order', () => {
    const v = new PlayerDataView()
    const base = v.unit('spearman').attack!.melee!
    v.applyPatches([
      { target: 'spearman', field: 'attack.melee', op: 'add', value: 2 },
      { target: 'spearman', field: 'attack.melee', op: 'mul', value: 2 },
    ])
    // (base + 2) * 2, not base + 2*2 — order is significant and deliberate.
    expect(v.unit('spearman').attack!.melee).toBe((base + 2) * 2)
  })

  it('creates missing intermediate objects when patching a nested field', () => {
    const v = new PlayerDataView()
    // pearl_diver has no `attack` at all in the base data.
    expect(BASE_DATA.units.pearl_diver!.attack).toBeUndefined()
    v.applyPatches([{ target: 'pearl_diver', field: 'attack.melee', op: 'add', value: 4 }])
    expect(v.unit('pearl_diver').attack!.melee).toBe(4)
  })

  it('never mutates the shared base data', () => {
    const baseAttack = BASE_DATA.units.spearman!.attack!.melee
    const v = new PlayerDataView()
    v.applyPatches([{ target: 'spearman', field: 'attack.melee', op: 'add', value: 100 }])
    v.unit('spearman')
    expect(BASE_DATA.units.spearman!.attack!.melee).toBe(baseAttack)
  })

  it('keeps two players fully independent', () => {
    const a = new PlayerDataView()
    const b = new PlayerDataView()
    a.applyPatches([{ target: 'archer', field: 'range', op: 'add', value: 2 }])
    expect(a.unit('archer').range).toBe(BASE_DATA.units.archer!.range! + 2)
    expect(b.unit('archer').range).toBe(BASE_DATA.units.archer!.range)
  })

  it('invalidates its cache when a later patch arrives', () => {
    const v = new PlayerDataView()
    const first = v.unit('archer').range!
    v.applyPatches([{ target: 'archer', field: 'range', op: 'add', value: 1 }])
    expect(v.unit('archer').range).toBe(first + 1)
  })
})

describe('civilisations are patch lists', () => {
  it('applies civ bonuses at construction', () => {
    const p = new Player(0, 'al_bidda', 0x3366cc)
    const base = BASE_DATA.units.pearl_diver!.gatherRate!.pearls!
    // Al Bidda: pearl gather rate x1.2
    expect(p.data.unit('pearl_diver').gatherRate!.pearls).toBeCloseTo(base * 1.2, 10)
  })

  it('gives different civs different stats for the same unit', () => {
    const bidda = new Player(0, 'al_bidda', 0)
    const zubarah = new Player(1, 'al_zubarah', 0)
    expect(bidda.data.unit('pearl_diver').gatherRate!.pearls).not.toBeCloseTo(
      zubarah.data.unit('pearl_diver').gatherRate!.pearls!,
      10,
    )
  })

  it('applies civ bonuses to buildings too', () => {
    const p = new Player(0, 'al_zubarah', 0)
    const base = BASE_DATA.buildings.barzan_tower!.hp
    expect(p.data.building('barzan_tower').hp).toBeCloseTo(base * 1.25, 10)
  })
})

describe('research', () => {
  it('gates a tech on its prerequisites', () => {
    const p = new Player(0, 'al_bidda', 0)
    expect(p.canResearch('deep_water_diving')).toBe(false)
    p.completeResearch('age_pearling')
    expect(p.canResearch('deep_water_diving')).toBe(true)
  })

  it('will not research the same tech twice', () => {
    const p = new Player(0, 'al_bidda', 0)
    p.completeResearch('forged_spears')
    expect(p.canResearch('forged_spears')).toBe(false)
  })

  it('changes unit stats through the view, touching no entity', () => {
    const p = new Player(0, 'al_khor', 0)
    const before = p.data.unit('spearman').attack!.melee!
    p.completeResearch('forged_spears')
    expect(p.data.unit('spearman').attack!.melee).toBe(before + 3)
  })

  it('stacks a civ bonus and a tech on the same field', () => {
    const p = new Player(0, 'al_bidda', 0)
    const base = BASE_DATA.units.pearl_diver!.gatherRate!.pearls!
    p.completeResearch('age_pearling')
    p.completeResearch('deep_water_diving')
    // civ x1.2 then tech x1.3
    expect(p.data.unit('pearl_diver').gatherRate!.pearls).toBeCloseTo(base * 1.2 * 1.3, 10)
  })
})

describe('resources', () => {
  it('checks affordability against the stockpile', () => {
    const p = new Player(0, 'al_bidda', 0)
    p.resources = { food: 100, wood: 50, stone: 0, pearls: 0 }
    expect(p.canAfford({ food: 50 })).toBe(true)
    expect(p.canAfford({ food: 150 })).toBe(false)
    expect(p.canAfford({ food: 50, wood: 60 })).toBe(false)
  })

  it('deducts only when the whole cost is affordable', () => {
    const p = new Player(0, 'al_bidda', 0)
    p.resources = { food: 100, wood: 10, stone: 0, pearls: 0 }
    expect(p.spend({ food: 50, wood: 60 })).toBe(false)
    expect(p.resources.food).toBe(100) // untouched
    expect(p.spend({ food: 50, wood: 10 })).toBe(true)
    expect(p.resources.food).toBe(50)
    expect(p.resources.wood).toBe(0)
  })
})
