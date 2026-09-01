import { describe, expect, test } from 'bun:test'
import { loadActivePackViews, loadUiPack } from '../src/ui/pack-loader.ts'

describe('UI scenario pack loading', () => {
  test('loads only the packs declared by a scenario', async () => {
    const pack = await loadActivePackViews(['ambulance'])

    expect(pack.packIds).toEqual(['ambulance'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
    ])
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('traffic')
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('process-plants')
    expect(pack.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'ambulance',
      'hospital',
      'incident',
    ])
  })

  test('combines scenario packs in declared order', async () => {
    const pack = await loadActivePackViews(['traffic', 'weather'])

    expect(pack.packIds).toEqual(['traffic', 'weather'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual(['traffic', 'weather'])
    expect(pack.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'traffic_area',
      'traffic_road_segment',
      'weather_area',
      'weather_probe',
    ].sort())
  })

  test('rejects unknown and duplicate scenario pack ids visibly', async () => {
    await expect(loadUiPack('missing')).rejects.toThrow('scenario references unknown UI pack: missing')
    await expect(loadActivePackViews(['ambulance', 'ambulance']))
      .rejects.toThrow('scenario declares duplicate packs: ambulance')
  })
})
