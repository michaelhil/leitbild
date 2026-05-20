import { describe, expect, test } from 'bun:test'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../src/core/model/index.ts'
import { compilePlantGraph, compilePwrProcessSystems, component, connect, plantGraph, plantGraphToMermaid, pwrComponentRegistry, pwrLitePlantSpec } from '../src/packs/pwr/index.ts'

describe('PWR plant graph foundation', () => {
  test('compiles the PWR lite plant graph into indexed components, edges, and variables', () => {
    const compiled = compilePlantGraph(pwrLitePlantSpec, pwrComponentRegistry)

    expect(String(compiled.specId)).toBe('pwr.westinghouse-lite.v1')
    expect(compiled.components.map(component => String(component.id))).toEqual(['core', 'sgA', 'rcpA', 'feedwaterA', 'turbine'])
    expect(compiled.edgesByKind.hydraulicFlow).toEqual([0, 1, 2, 3])
    expect(compiled.edgesByKind.steamFlow).toEqual([4])
    expect(compiled.variables.filter(variable => variable.published).map(variable => String(variable.path))).toEqual([
      'core.powerMw',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'rcpA.running',
      'feedwaterA.flowKgPerS',
      'turbine.electricMw',
    ])
  })

  test('compiles a PWR process system from scenario-owned graph data', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'pwr-sgtr-training',
      schemaVersion: 1,
      title: 'PWR SGTR Training',
      packs: ['pwr'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [
        {
          id: 'plant',
          pack: 'pwr',
          componentLibrary: 'pwr-lite',
          graph: pwrLitePlantSpec,
        },
      ],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const systems = compilePwrProcessSystems(scenario.processSystems)

    expect(systems).toHaveLength(1)
    expect(systems[0]?.id).toBe('plant')
    expect(systems[0]?.graph.components.map(component => String(component.id))).toContain('core')
  })

  test('rejects incompatible typed port connections before runtime', () => {
    const invalid = plantGraph({
      id: 'pwr.invalid-port.v1',
      title: 'Invalid PWR Port Graph',
      fixedStepMs: 100,
      components: [
        component('rcpA', 'centrifugalPump', 'Reactor Coolant Pump A', {
          nominalFlowKgPerS: 4700,
          nominalHeadPa: 650_000,
        }),
        component('turbine', 'turbineLoadSinkLite', 'Turbine Generator', {
          nominalElectricMw: 1100,
          initialLoadFraction: 0.85,
        }),
      ],
      connections: [
        connect('bad-electrical-to-hydraulic', 'turbine.generatorOutput', 'rcpA.inlet'),
      ],
    })

    expect(() => compilePlantGraph(invalid, pwrComponentRegistry)).toThrow('incompatible port kinds')
  })

  test('rejects duplicate component ids', () => {
    const invalid = plantGraph({
      id: 'pwr.duplicate-component.v1',
      title: 'Duplicate PWR Component Graph',
      fixedStepMs: 100,
      components: [
        component('core', 'reactorCoreLite', 'Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
        }),
        component('core', 'reactorCoreLite', 'Second Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
        }),
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(invalid, pwrComponentRegistry)).toThrow('duplicate component id')
  })

  test('rejects explicit edge kinds that conflict with typed ports', () => {
    const invalid = plantGraph({
      id: 'pwr.invalid-edge-kind.v1',
      title: 'Invalid Edge Kind Graph',
      fixedStepMs: 100,
      components: [
        component('feedwaterA', 'feedwaterSourceLite', 'Feedwater Train A', {
          nominalFlowKgPerS: 760,
          temperatureC: 220,
        }),
        component('sgA', 'steamGeneratorLite', 'Steam Generator A', {
          nominalPressureMPa: 6.9,
          nominalLevelPercent: 0.55,
          heatTransferCoefficientMwPerK: 12,
        }),
      ],
      connections: [
        connect('bad-steam-edge', 'feedwaterA.outlet', 'sgA.feedwaterInlet', { edgeKind: 'steamFlow' }),
      ],
    })

    expect(() => compilePlantGraph(invalid, pwrComponentRegistry)).toThrow('port kinds require hydraulicFlow')
  })

  test('keeps string port refs out of compiled edges', () => {
    const compiled = compilePlantGraph(pwrLitePlantSpec, pwrComponentRegistry)
    const firstEdge = compiled.edges[0]
    if (!firstEdge) throw new Error('expected compiled graph to contain at least one edge')

    expect(firstEdge).toMatchObject({
      fromComponentIndex: 0,
      fromPortIndex: 0,
      toComponentIndex: 1,
      toPortIndex: 0,
    })
    expect('from' in firstEdge).toBe(false)
    expect('to' in firstEdge).toBe(false)
  })

  test('rejects published variables that are not declared by component definitions', () => {
    const invalid = plantGraph({
      id: 'pwr.invalid-variable.v1',
      title: 'Invalid PWR Variable Graph',
      fixedStepMs: 100,
      components: [
        component('core', 'reactorCoreLite', 'Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
        }),
      ],
      connections: [],
      publishedVariables: ['core.noSuchVariable'],
    })

    expect(() => compilePlantGraph(invalid, pwrComponentRegistry)).toThrow('published variable does not exist')
  })

  test('generates Mermaid documentation from compiled topology', () => {
    const compiled = compilePlantGraph(pwrLitePlantSpec, pwrComponentRegistry)
    const mermaid = plantGraphToMermaid(compiled)

    expect(mermaid).toContain('flowchart LR')
    expect(mermaid).toContain('Reactor Core')
    expect(mermaid).toContain('hydraulicFlow')
    expect(mermaid).toContain('steamFlow')
  })
})
