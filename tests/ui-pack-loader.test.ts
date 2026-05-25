import { describe, expect, test } from 'bun:test'
import { createScenarioControlPack, loadUiPack } from '../src/ui/pack-loader.ts'

describe('UI scenario pack loading', () => {
  test('loads only the packs declared by a scenario', async () => {
    const pack = await createScenarioControlPack(['ambulance'])

    expect(pack.id).toBe('scenario-control:ambulance')
    expect(pack.categories.map(category => category.id)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
    ])
    expect(pack.categories.map(category => category.id)).not.toContain('traffic')
    expect(pack.categories.map(category => category.id)).not.toContain('process-plants')
    expect(pack.createObjectTypes.map(type => type.id).sort()).toEqual([
      'ambulance',
      'hospital',
      'incident',
    ])
  })

  test('combines scenario packs in declared order', async () => {
    const pack = await createScenarioControlPack(['traffic', 'weather'])

    expect(pack.id).toBe('scenario-control:traffic+weather')
    expect(pack.categories.map(category => category.id)).toEqual(['traffic', 'weather'])
    expect(pack.createObjectTypes.map(type => type.id).sort()).toEqual([
      'traffic_area',
      'traffic_road_segment',
    ].sort())
  })

  test('rejects unknown and duplicate scenario pack ids visibly', async () => {
    await expect(loadUiPack('missing')).rejects.toThrow('scenario references unknown UI pack: missing')
    await expect(createScenarioControlPack(['ambulance', 'ambulance']))
      .rejects.toThrow('scenario declares duplicate packs: ambulance')
  })
})
