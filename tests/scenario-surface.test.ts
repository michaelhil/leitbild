import { describe, expect, test } from 'bun:test'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../src/core/model/index.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'
import { categoryRowsForSurface, surfaceMapConfig, surfaceObjectRailConfig } from '../src/ui/surface.ts'

describe('scenario surface model', () => {
  test('expands the Oslo scenario surface into safe primitives', () => {
    const parsed = scenarioDefinitionSchema.parse(osloAmbulanceScenario) as ScenarioDefinition
    const mapConfig = surfaceMapConfig(parsed.surface)
    const railConfig = surfaceObjectRailConfig(parsed.surface)

    expect(Number(mapConfig?.center.coordinates[0])).toBe(10.7522)
    expect(Number(mapConfig?.center.coordinates[1])).toBe(59.9139)
    expect(mapConfig?.zoom).toBe(12)
    expect(mapConfig?.layers).toEqual(['objects', 'routes', 'traffic', 'highlights'])
    expect(railConfig?.sections.map(section => section.categoryId)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
      'traffic',
    ])
  })

  test('rejects map surfaces without an explicit viewport', () => {
    expect(() => scenarioDefinitionSchema.parse({
      ...osloAmbulanceScenario,
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
      { category: ambulancePack.categories[1]!, objects: [] },
      { category: trafficPack.categories[0]!, objects: [] },
      { category: ambulancePack.categories[0]!, objects: [] },
      { category: ambulancePack.categories[2]!, objects: [] },
    ], surfaceObjectRailConfig(osloAmbulanceScenario.surface))

    expect(rows.map(row => row.category.id)).toEqual([
      'hospitals',
      'ambulances',
      'incidents',
      'traffic',
    ])
  })

  test('rejects rail sections for inactive pack categories', () => {
    const scenario = scenarioDefinitionSchema.parse({
      ...osloAmbulanceScenario,
      packs: ['ambulance'],
      providerConfigs: { ambulance: {} },
      surface: {
        ...osloAmbulanceScenario.surface,
        regions: osloAmbulanceScenario.surface.regions.map(region => (
          region.primitive === 'objectRail'
            ? {
                ...region,
                config: {
                  ...region.config,
                  sections: [
                    ...region.config.sections,
                    {
                      categoryId: 'traffic',
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

    expect(() => createScenarioCatalog({
      packs: [ambulancePack, trafficPack],
      scenarios: [scenario],
    })).toThrow('surface rail references inactive category: traffic')
  })
})
