import { describe, expect, test } from 'bun:test'
import { worldPacks } from '../src/app-assembly.ts'
import { knownUiPackIds, loadActivePackViews, loadUiPack } from '../src/ui/pack-loader.ts'

describe('UI scenario pack loading', () => {
  test('loads only the packs declared by a scenario', async () => {
    const pack = await loadActivePackViews(['ambulance'])

    expect(pack.packIds).toEqual(['ambulance'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual([
      'ambulances',
      'incidents',
      'patients',
      'care-sites',
    ])
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('weather')
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('process-plants')
    expect(pack.creation?.createObjectTypes ?? []).toEqual([])
    expect(pack.surfacePanels).toEqual([])
    expect(pack.packs[0]?.mapAssignment).toBeDefined()
  })

  test('combines scenario packs in declared order', async () => {
    const pack = await loadActivePackViews(['ambulance', 'weather'])

    expect(pack.packIds).toEqual(['ambulance', 'weather'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual(['ambulances', 'incidents', 'patients', 'care-sites', 'weather'])
    expect(pack.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'weather_area',
      'weather_probe',
    ].sort())
  })

  test('rejects unknown and duplicate scenario pack ids visibly', async () => {
    await expect(loadUiPack('missing')).rejects.toThrow('scenario references unknown UI pack: missing')
    await expect(loadActivePackViews(['ambulance', 'ambulance']))
      .rejects.toThrow('scenario declares duplicate packs: ambulance')
  })

  test('has one reviewed lazy loader for every assembled World Pack', () => {
    expect(knownUiPackIds).toEqual(worldPacks.map(pack => pack.descriptor.id).sort())
  })

  test('publishes the same Pack identity through server and browser assemblies', async () => {
    for (const pack of worldPacks) {
      expect((await loadUiPack(pack.descriptor.id)).descriptor).toEqual(pack.descriptor)
    }
  })

  test('heavy browser views do not masquerade as complete server Packs', async () => {
    for (const packId of ['ambulance', 'drone', 'process-plant', 'electric-grid']) {
      const view = await loadUiPack(packId)
      expect(Object.hasOwn(view, 'scenarioConfigSchema')).toBe(false)
      expect(Object.hasOwn(view, 'scenario')).toBe(false)
    }
  })
})
