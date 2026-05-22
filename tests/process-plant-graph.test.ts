import { describe, expect, test } from 'bun:test'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../src/core/model/index.ts'
import {
  compilePlantGraph,
  compileProcessPlantSystem,
  compileProcessPlantSystems,
  component,
  connect,
  plantGraph,
  plantGraphToMermaid,
  pressurizedWaterReactorPlantSpec,
  processPlantPressurizedWaterReactorGraphRef,
  processPlantComponentRegistry,
  processLinkVariableDescriptorSchema,
  variableDescriptorSchema,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'

describe('process plant graph foundation', () => {
  test('compiles the pressurized water reactor graph into indexed components, links, and variables', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)

    expect(String(compiled.specId)).toBe('process-plant.pressurized-water-reactor.v1')
    expect(compiled.components.length).toBeGreaterThanOrEqual(40)
    expect(compiled.components.map(component => String(component.id))).toEqual(expect.arrayContaining([
      'core',
      'vessel',
      'sgA',
      'sgB',
      'sgC',
      'sgD',
      'rcpA',
      'rcpB',
      'rcpC',
      'rcpD',
      'mainSteamHeader',
      'turbine',
      'generator',
      'condenser',
    ]))
    expect(compiled.linksByKind.fluidFlow.length).toBeGreaterThan(40)
    expect(compiled.linksByKind.thermalContact).toEqual([0])
    expect(compiled.linksByKind.electricalPower.length).toBe(1)
    expect(compiled.linksByService.get('primaryCoolant' as never)?.length).toBeGreaterThanOrEqual(13)
    expect(compiled.linksByService.get('mainSteam' as never)?.length).toBeGreaterThanOrEqual(10)
    const coreIndex = compiled.componentIndexById.get('core' as never)
    if (coreIndex === undefined) throw new Error('expected core component')
    expect(compiled.incomingLinksByComponent[coreIndex]?.length).toBeGreaterThanOrEqual(5)
    expect(compiled.outgoingLinksByComponent[coreIndex]?.length).toBeGreaterThanOrEqual(5)
    const publishedVariables = compiled.variables.filter(variable => variable.published).map(variable => String(variable.path))
    expect(publishedVariables).toContain('core.coolantOutletTemperatureC')
    expect(publishedVariables).toContain('sgA.heatTransferMw')
    expect(publishedVariables).toContain('sgD.heatTransferMw')
    expect(publishedVariables).toContain('sgA.steamFlowKgPerS')
    expect(publishedVariables).toContain('condenser.condensateTemperatureC')
    expect(publishedVariables).toContain('rcs-hot-leg-a.temperatureC')
    expect(publishedVariables).toContain('turbine-exhaust-to-condenser.flowKgPerS')
    const steamLink = compiled.links.find(link => link.id === 'sg-a-steam-to-msiv-a')
    if (!steamLink) throw new Error('expected SG A main steam link')
    expect(steamLink.physical).toMatchObject({ lengthM: 38, diameterM: 0.72 })
    expect(compiled.variables.find(variable => variable.path === 'sg-a-steam-to-msiv-a.flowKgPerS')?.owner).toEqual({
      type: 'link',
      linkIndex: steamLink.index,
    })
  })

  test('compiles a process plant system from scenario-owned graph data', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'reactor-tube-leak-training',
      schemaVersion: 1,
      title: 'Reactor Tube Leak Training',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [
        {
          id: 'plant',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          graph: pressurizedWaterReactorPlantSpec,
        },
      ],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const systems = compileProcessPlantSystems(scenario.processSystems)

    expect(systems).toHaveLength(1)
    expect(systems[0]?.id).toBe('plant')
    expect(systems[0]?.graph.components.map(component => String(component.id))).toContain('core')
  })

  test('compiles a process plant system from a pack-owned graphRef', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'multi-unit-site',
      schemaVersion: 1,
      title: 'Multi Unit Site',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [
        {
          id: 'unit-1',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          graphRef: processPlantPressurizedWaterReactorGraphRef,
        },
      ],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const systems = compileProcessPlantSystems(scenario.processSystems)

    expect(systems).toHaveLength(1)
    expect(systems[0]?.id).toBe('unit-1')
    expect(String(systems[0]?.graph.specId)).toBe(processPlantPressurizedWaterReactorGraphRef)
  })

  test('rejects duplicate primary loop pump ownership before runtime', () => {
    const invalid = structuredClone(pressurizedWaterReactorPlantSpec) as PlantGraphSpec
    const rcpB = invalid.components.find(component => component.id === 'rcpB')
    if (!rcpB || !rcpB.parameters || typeof rcpB.parameters !== 'object' || Array.isArray(rcpB.parameters)) {
      throw new Error('expected RCP B parameters')
    }
    rcpB.parameters = {
      ...rcpB.parameters,
      primaryLoopId: 'A',
    }

    expect(() => compileProcessPlantSystem({
      id: 'plant',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: invalid,
    })).toThrow('primary loop A has multiple loop pumps')
  })

  test('rejects incomplete primary loop topology before runtime', () => {
    const invalid = structuredClone(pressurizedWaterReactorPlantSpec) as PlantGraphSpec
    invalid.connections = invalid.connections.filter(connection => connection.id !== 'rcs-hot-leg-a')
    invalid.publishedVariables = invalid.publishedVariables.filter(path => !String(path).startsWith('rcs-hot-leg-a.'))

    expect(() => compileProcessPlantSystem({
      id: 'plant',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: invalid,
    })).toThrow('primary loop A must have exactly one core hotLegA primaryCoolant outlet')
  })

  test('applies per-system component parameter overlays without changing topology', () => {
    const system = compileProcessPlantSystem({
      id: 'unit-parameterized',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graphRef: processPlantPressurizedWaterReactorGraphRef,
      parameters: {
        core: {
          ratedPowerMw: 2_200,
        },
      },
    })

    const core = system.graph.components.find(component => component.id === 'core')
    expect(core?.parameters).toMatchObject({ ratedPowerMw: 2_200 })
    expect(system.graph.components.length).toBe(pressurizedWaterReactorPlantSpec.components.length)
  })

  test('rejects parameter overlays for unknown components', () => {
    expect(() => compileProcessPlantSystem({
      id: 'bad-parameter-overlay',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graphRef: processPlantPressurizedWaterReactorGraphRef,
      parameters: {
        missingComponent: {},
      },
    })).toThrow('process system parameter overlay references unknown component: missingComponent')
  })

  test('rejects invalid per-system initialState paths and values before runtime starts', () => {
    expect(() => compileProcessPlantSystem({
      id: 'bad-initial-state-path',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graphRef: processPlantPressurizedWaterReactorGraphRef,
      initialState: {
        'missing.variable': 1,
      },
    })).toThrow('process plant initialState references unknown variable: missing.variable')

    expect(() => compileProcessPlantSystem({
      id: 'bad-initial-state-value',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graphRef: processPlantPressurizedWaterReactorGraphRef,
      initialState: {
        'core.rodInsertionFraction': 2,
      },
    })).toThrow('process plant initialState for core.rodInsertionFraction fraction value must be between 0 and 1')
  })

  test('rejects duplicate process plant system ids', () => {
    expect(() => compileProcessPlantSystems([
      {
        id: 'unit',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        graphRef: processPlantPressurizedWaterReactorGraphRef,
      },
      {
        id: 'unit',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        graphRef: processPlantPressurizedWaterReactorGraphRef,
      },
    ])).toThrow('duplicate process plant system id: unit')
  })

  test('rejects process systems that mix inline graph and graphRef', () => {
    expect(() => scenarioDefinitionSchema.parse({
      id: 'ambiguous-graph-source',
      schemaVersion: 1,
      title: 'Ambiguous Graph Source',
      packs: ['process-plant'],
      world: { environment: {} },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        graph: pressurizedWaterReactorPlantSpec,
        graphRef: processPlantPressurizedWaterReactorGraphRef,
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    })).toThrow('process system must define exactly one of graph or graphRef')
  })

  test('rejects process systems without a graph source', () => {
    expect(() => scenarioDefinitionSchema.parse({
      id: 'missing-graph-source',
      schemaVersion: 1,
      title: 'Missing Graph Source',
      packs: ['process-plant'],
      world: { environment: {} },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    })).toThrow('process system must define exactly one of graph or graphRef')
  })

  test('rejects unknown process plant graph refs explicitly', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'unknown-graph-ref',
      schemaVersion: 1,
      title: 'Unknown Graph Ref',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [
        {
          id: 'plant',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          graphRef: 'process-plant.unknown.v1',
        },
      ],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('unknown process plant graphRef: process-plant.unknown.v1')
  })

  test('rejects old process pack ids instead of keeping compatibility aliases', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'old-pack-id',
      schemaVersion: 1,
      title: 'Old Pack Id',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [
        {
          id: 'plant',
          pack: 'old-process-pack',
          componentLibrary: 'process-plant',
          graph: pressurizedWaterReactorPlantSpec,
        },
      ],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('process plant compiler received process system for pack old-process-pack')
  })

  test('rejects incompatible typed port connections before runtime', () => {
    const invalid = plantGraph({
      id: 'process-plant.invalid-port.v1',
      title: 'Invalid Process Plant Port Graph',
      fixedStepMs: 100,
      components: [
        component('rcpA', 'centrifugalPump', 'Reactor Coolant Pump A', {
          nominalFlowKgPerS: 4700,
          nominalHeadPa: 650_000,
        }),
        component('turbine', 'turbineLoadSink', 'Turbine Generator', {
          nominalElectricMw: 1100,
          initialLoadFraction: 0.85,
          nominalSteamFlowKgPerS: 1050,
        }),
      ],
      connections: [
        connect('bad-electrical-to-hydraulic', 'turbine.generatorOutput', 'rcpA.inlet', { connectionKind: 'electricalPower' }),
      ],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('incompatible port kinds')
  })

  test('rejects duplicate component ids', () => {
    const invalid = plantGraph({
      id: 'process-plant.duplicate-component.v1',
      title: 'Duplicate Process Plant Component Graph',
      fixedStepMs: 100,
      components: [
        component('core', 'reactorCore', 'Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
          fuelThermalCapacityMjPerC: 45000,
        }),
        component('core', 'reactorCore', 'Second Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
        }),
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('duplicate component id')
  })

  test('rejects explicit link kinds that conflict with typed ports', () => {
    const invalid = plantGraph({
      id: 'process-plant.invalid-link-kind.v1',
      title: 'Invalid Link Kind Graph',
      fixedStepMs: 100,
      components: [
        component('feedwaterA', 'feedwaterSource', 'Feedwater Train A', {
          nominalFlowKgPerS: 760,
          temperatureC: 220,
        }),
        component('sgA', 'steamGenerator', 'Steam Generator A', {
          nominalPressureMPa: 6.9,
          nominalLevelPercent: 0.55,
          heatTransferCoefficientMwPerK: 12,
        }),
      ],
      connections: [
        connect('bad-steam-link', 'feedwaterA.outlet', 'sgA.feedwaterInlet', { connectionKind: 'thermalContact' }),
      ],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('port kinds require fluidFlow')
  })

  test('keeps string port refs out of compiled links', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const firstLink = compiled.links[0]
    if (!firstLink) throw new Error('expected compiled graph to contain at least one link')

    expect(firstLink).toMatchObject({
      fromComponentIndex: 0,
      fromPortName: 'vesselThermal',
      toComponentIndex: 1,
      toPortName: 'coreThermal',
      toPortIndex: 0,
    })
    expect('from' in firstLink).toBe(false)
    expect('to' in firstLink).toBe(false)
  })

  test('rejects published variables that are not declared by component definitions', () => {
    const invalid = plantGraph({
      id: 'process-plant.invalid-variable.v1',
      title: 'Invalid Process Plant Variable Graph',
      fixedStepMs: 100,
      components: [
        component('core', 'reactorCore', 'Reactor Core', {
          ratedPowerMw: 3400,
          initialPowerFraction: 0.85,
          fuelThermalCapacityMjPerC: 45000,
        }),
      ],
      connections: [],
      publishedVariables: ['core.noSuchVariable'],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('published variable does not exist')
  })

  test('rejects duplicate published variables before compilation hides them in a set', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      publishedVariables: [
        ...pressurizedWaterReactorPlantSpec.publishedVariables,
        pressurizedWaterReactorPlantSpec.publishedVariables[0],
      ],
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('duplicate published variable')
  })

  test('rejects unsupported initial state instead of validating it as parameters', () => {
    const invalid = plantGraph({
      id: 'process-plant.unsupported-initial-state.v1',
      title: 'Unsupported Initial State Graph',
      fixedStepMs: 100,
      components: [
        {
          ...component('core', 'reactorCore', 'Reactor Core', {
            ratedPowerMw: 3400,
            initialPowerFraction: 0.85,
            fuelThermalCapacityMjPerC: 45000,
          }),
          initialState: {
            powerMw: 1000,
          },
        },
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('does not define initial state schema')
  })

  test('rejects invalid quantity and unit combinations', () => {
    const result = variableDescriptorSchema.safeParse({
      path: 'core.powerMw',
      label: 'Core power',
      kind: 'state',
      domain: 'nuclear',
      writable: false,
      publish: 'telemetry',
      quantity: 'power',
      unit: 'percent',
    })

    expect(result.success).toBe(false)
  })

  test('rejects duplicate link-local variable paths', () => {
    const duplicateLinkVariable = processLinkVariableDescriptorSchema.parse({
      path: 'flowKgPerS',
      label: 'Main steam flow',
      kind: 'derived',
      domain: 'hydraulic',
      writable: false,
      publish: 'telemetry',
      quantity: 'flowRate',
      unit: 'kg/s',
      initialValue: 0,
    })
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'sg-a-steam-to-msiv-a'
        ? {
            ...connection,
            variables: [duplicateLinkVariable, { ...duplicateLinkVariable, label: 'Duplicate main steam flow' }],
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('duplicate variable path: sg-a-steam-to-msiv-a.flowKgPerS')
  })

  test('rejects duplicate final variable paths across components and links', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: [
        ...pressurizedWaterReactorPlantSpec.connections,
        {
          id: 'core',
          from: 'sgA.steamOutlet',
          to: 'mainSteamIsolationValveA.inlet',
          connectionKind: 'fluidFlow',
          service: 'mainSteam',
          nominalFluid: 'steam',
          designPhase: 'steam',
          solverModel: 'compressibleSteam',
          variables: [
            {
              path: 'powerMw',
              label: 'Duplicate core power',
              kind: 'derived',
              domain: 'thermal',
              writable: false,
              publish: 'telemetry',
              quantity: 'power',
              unit: 'MW',
              initialValue: 0,
            },
          ],
        },
      ],
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('duplicate variable path: core.powerMw')
  })

  test('rejects link actuators on non-writable variables', () => {
    const result = processLinkVariableDescriptorSchema.safeParse({
      path: 'valve.positionFraction',
      label: 'Valve position',
      kind: 'control',
      domain: 'control',
      writable: false,
      publish: 'telemetry',
      quantity: 'ratio',
      unit: 'fraction',
      initialValue: 1,
      actuatorId: 'MSIV-A',
    })

    expect(result.success).toBe(false)
  })

  test('rejects link variables that declare both sensor and actuator ids', () => {
    const result = processLinkVariableDescriptorSchema.safeParse({
      path: 'pressureMPa',
      label: 'Main steam pressure',
      kind: 'control',
      domain: 'control',
      writable: true,
      publish: 'telemetry',
      quantity: 'pressure',
      unit: 'MPa',
      initialValue: 6.9,
      sensorId: 'PT-SG-A-001',
      actuatorId: 'PT-SG-A-SETPOINT',
    })

    expect(result.success).toBe(false)
  })

  test('rejects duplicate process sensor and actuator ids before runtime', () => {
    const invalidSensorId = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'turbine-stop-valve-to-turbine'
        ? {
            ...connection,
            variables: connection.variables.map(variable => variable.path === 'flowKgPerS'
              ? { ...variable, sensorId: 'PT-SG-A-001' }
              : variable),
          }
        : connection),
    }
    const invalidActuatorId = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'sg-a-steam-to-msiv-a' || connection.id === 'sg-b-steam-to-msiv-b'
        ? {
            ...connection,
            variables: connection.variables.map(variable => variable.path === 'leak.areaFraction'
              ? { ...variable, actuatorId: 'DUPLICATE-LEAK-ACTUATOR' }
              : variable),
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalidSensorId, processPlantComponentRegistry)).toThrow('duplicate process sensor id: PT-SG-A-001')
    expect(() => compilePlantGraph(invalidActuatorId, processPlantComponentRegistry)).toThrow('duplicate process actuator id: DUPLICATE-LEAK-ACTUATOR')
  })

  test('rejects link initial values that do not match quantity type', () => {
    const numericResult = processLinkVariableDescriptorSchema.safeParse({
      path: 'flowKgPerS',
      label: 'Main steam flow',
      kind: 'derived',
      domain: 'hydraulic',
      writable: false,
      publish: 'telemetry',
      quantity: 'flowRate',
      unit: 'kg/s',
      initialValue: true,
    })
    const booleanResult = processLinkVariableDescriptorSchema.safeParse({
      path: 'open',
      label: 'Valve open',
      kind: 'discrete',
      domain: 'control',
      writable: true,
      publish: 'telemetry',
      quantity: 'boolean',
      unit: 'boolean',
      initialValue: 1,
    })

    expect(numericResult.success).toBe(false)
    expect(booleanResult.success).toBe(false)
  })

  test('rejects physically invalid link initial values before runtime', () => {
    const invalidFraction = processLinkVariableDescriptorSchema.safeParse({
      path: 'valve.positionFraction',
      label: 'Valve position',
      kind: 'control',
      domain: 'control',
      writable: true,
      publish: 'telemetry',
      quantity: 'ratio',
      unit: 'fraction',
      initialValue: 1.5,
      actuatorId: 'MSIV-A',
    })
    const invalidFlow = processLinkVariableDescriptorSchema.safeParse({
      path: 'flowKgPerS',
      label: 'Main steam flow',
      kind: 'derived',
      domain: 'hydraulic',
      writable: false,
      publish: 'telemetry',
      quantity: 'flowRate',
      unit: 'kg/s',
      initialValue: -10,
    })

    expect(invalidFraction.success).toBe(false)
    expect(invalidFlow.success).toBe(false)
  })

  test('rejects fluid links that omit explicit solver model metadata', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'main-feedwater-pump-a-to-header'
        ? {
            ...connection,
            solverModel: undefined,
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('fluid connection main-feedwater-pump-a-to-header must declare solverModel')
  })

  test('rejects fluid solver models with incompatible design phase', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'main-feedwater-pump-a-to-header'
        ? {
            ...connection,
            designPhase: 'steam',
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('fluid connection main-feedwater-pump-a-to-header solverModel incompressibleLiquid requires designPhase liquid')
  })

  test('rejects primary coolant links without pressure variables', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'rcs-hot-leg-a'
        ? {
            ...connection,
            variables: connection.variables.filter(variable => variable.path !== 'pressureMPa'),
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('fluid connection rcs-hot-leg-a with solverModel incompressibleLiquid must declare variable pressureMPa')
  })

  test('rejects link variables outside the declared solver model contract', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'main-feedwater-pump-a-to-header'
        ? {
            ...connection,
            variables: [
              ...connection.variables,
              {
                path: 'qualityFraction',
                label: 'Invalid liquid quality',
                kind: 'derived',
                domain: 'hydraulic',
                writable: false,
                publish: 'telemetry',
                quantity: 'ratio',
                unit: 'fraction',
                initialValue: 0,
              },
            ],
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('fluid connection main-feedwater-pump-a-to-header with solverModel incompressibleLiquid cannot declare unsupported variable qualityFraction')
  })

  test('generates Mermaid documentation from compiled topology', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const mermaid = plantGraphToMermaid(compiled)

    expect(mermaid).toContain('flowchart TB')
    expect(mermaid).toContain('Reactor Core')
    expect(mermaid).toContain('primaryCoolant')
    expect(mermaid).toContain('mainSteam')
    expect(mermaid).toContain('fluidFlow')
  })
})
