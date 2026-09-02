import { describe, expect, test } from 'bun:test'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../src/core/model/index.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { categoryRowsForSurface, surfaceMapConfig, surfaceObjectRailConfig } from '../src/ui/surface.ts'

describe('scenario surface model', () => {
  test('expands the Oslo scenario surface into safe primitives', () => {
    const parsed = scenarioDefinitionSchema.parse(responseScenario) as ScenarioDefinition
    const mapConfig = surfaceMapConfig(parsed.surface)
    const railConfig = surfaceObjectRailConfig(parsed.surface)

    expect(Number(mapConfig?.center.coordinates[0])).toBe(10.7522)
    expect(Number(mapConfig?.center.coordinates[1])).toBe(59.9139)
    expect(mapConfig?.zoom).toBe(12)
    expect(mapConfig?.layers).toEqual(['objects', 'routes', 'weather', 'highlights'])
    expect(railConfig?.sections.map(section => section.categoryId)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
      'weather',
    ])
  })

  test('rejects map surfaces without an explicit viewport', () => {
    expect(() => scenarioDefinitionSchema.parse({
      ...responseScenario,
      surface: {
        schemaVersion: 1,
        regions: [{
          id: 'main-map',
          primitive: 'map',
          visible: true,
          config: {
            layers: ['objects'],
          },
        }],
      },
    })).toThrow()
  })

  test('orders and filters rail categories from scenario surface config', () => {
    const rows = categoryRowsForSurface([
      { category: ambulancePack.presentation.categories[1]!, objects: [] },
      { category: weatherPack.presentation.categories[0]!, objects: [] },
      { category: ambulancePack.presentation.categories[0]!, objects: [] },
      { category: ambulancePack.presentation.categories[2]!, objects: [] },
    ], surfaceObjectRailConfig(responseScenario.surface))

    expect(rows.map(row => row.category.id)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
      'weather',
    ])
  })

  test('rejects rail sections for inactive pack categories', () => {
    const scenario = scenarioDefinitionSchema.parse({
      ...responseScenario,
      packs: ['ambulance'],
      packConfigs: { ambulance: {} },
      surface: {
        ...responseScenario.surface,
        regions: responseScenario.surface.regions.map(region => (
          region.primitive === 'objectRail'
            ? {
                ...region,
                config: {
                  ...region.config,
                  sections: [
                    ...region.config.sections,
                    {
                      categoryId: 'weather',
                      visible: true,
                      collapsed: false,
                      visibleFields: [],
                    },
                  ],
                },
              }
            : region
        )),
      },
    }) as ScenarioDefinition

    expect(() => createScenarioRuntimeResolver({
      packs: [ambulancePack, weatherPack],
    }).resolve(scenario)).toThrow('surface rail references inactive category: weather')
  })
})
