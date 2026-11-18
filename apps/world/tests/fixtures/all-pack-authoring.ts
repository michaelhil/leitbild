import offsite from '../../src/scenarios/halden-offsite-power-restoration.scenario.json'
import supply from '../../src/scenarios/supply-run.scenario.json'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { areaDefault } from '../../src/packs/weather/pack.ts'

/** Authored test example, not an alternate production startup or default catalog. */
export const allPackAuthoringExample = () => scenarioDefinitionSchema.parse({
  ...structuredClone(offsite), id: 'all-pack-authoring-example', title: 'All Pack authoring example', timeline: undefined,
  packs: [...structuredClone(offsite.packs), ...structuredClone(supply.packs),
    { id: 'drone', config: { stepIntervalMs: 25, projectionIntervalMs: 750, motionFrameIntervalMs: 100 }, items: [
      { type: 'drone', id: 'example:drone', label: 'Example drone', position: [11.4, 59.1], modelId: 'native-survey-quad', altitudeM: 35, headingDeg: 10 },
    ] },
    { id: 'weather', config: {}, items: [
      { ...structuredClone(areaDefault), type: 'weather_area', id: 'example:weather', label: 'Example weather area', center: [11.4, 59.1], keyframes: [{ atSeconds: 120 }, { atSeconds: 300, atmosphere: { windSpeedMps: 8 } }] },
      { type: 'weather_probe', id: 'example:probe', label: 'Example weather probe', point: [11.4, 59.1] },
    ] },
    { id: 'situation-monitor', config: { sources: [{ id: 'example-disabled', name: 'Explicitly disabled source', adapter: 'rss', url: 'https://example.com/feed', enabled: false, intervalSeconds: 600, retentionHours: 12 }] }, items: [] },
  ],
})
