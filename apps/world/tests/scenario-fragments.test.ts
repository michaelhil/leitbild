import { describe, expect, test } from 'bun:test'
import {
  createScenarioFragmentCatalog,
  scenarioConfigSchema,
} from '../src/core/scenarios/config.ts'

const rootConfig = () => scenarioConfigSchema.parse({
  id: 'fragment-test',
  schemaVersion: 1,
  title: 'Fragment test',
  fragments: ['response'],
  packs: ['ambulance'],
  runtimeOverrides: {},
  world: { startsAt: '2026-01-01T00:00:00.000Z', environment: {} },
  objects: [],
  runtimeConfigs: {},
  surface: { schemaVersion: 1, regions: [] },
})

const fragment = (config: {
  readonly id: string
  readonly includes?: ReadonlyArray<string>
  readonly cueId?: string
  readonly runtimeConfigs?: Readonly<Record<string, unknown>>
}) => ({
  id: config.id,
  title: config.id,
  includes: config.includes ?? [],
  contribution: {
    packs: [],
    runtimeOverrides: {},
    objects: [],
    initialContexts: [],
    processSystems: [],
    runtimeConfigs: config.runtimeConfigs ?? {},
    surfaceRegions: [],
    timelineCues: config.cueId === undefined ? [] : [{
      id: config.cueId,
      at: { kind: 'after_scenario_start', seconds: 1 },
      actions: [{ type: 'clear_highlights' }],
    }],
  },
})

describe('Scenario Fragment composition', () => {
  test('resolves nested includes once and preserves deterministic cue order', () => {
    const catalog = createScenarioFragmentCatalog([
      fragment({ id: 'base', cueId: 'base-cue' }),
      fragment({ id: 'response', includes: ['base'], cueId: 'response-cue' }),
    ])

    const composed = catalog.compose(rootConfig())
    expect(composed.fragments).toEqual([])
    expect(composed.timeline?.cues.map(cue => cue.id)).toEqual(['base-cue', 'response-cue'])
  })

  test('rejects cycles and implicit record overrides', () => {
    const cyclic = createScenarioFragmentCatalog([
      fragment({ id: 'response', includes: ['base'] }),
      fragment({ id: 'base', includes: ['response'] }),
    ])
    expect(() => cyclic.compose(rootConfig())).toThrow('scenario Fragment cycle')

    const conflicting = createScenarioFragmentCatalog([
      fragment({ id: 'response', runtimeConfigs: { ambulance: {} } }),
    ])
    expect(() => conflicting.compose(scenarioConfigSchema.parse({
      ...rootConfig(),
      runtimeConfigs: { ambulance: {} },
    }))).toThrow('duplicates runtimeConfigs key')
  })
})
