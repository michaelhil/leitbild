import { describe, expect, test } from 'bun:test'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../src/core/model/index.ts'
import {
  compilePlantGraph,
  compileProcessSurface,
  compileProcessPlantSystem,
  compileProcessPlantSystems,
  component,
  connect,
  defaultProcessPlantDemoTransientInputs,
  plantGraph,
  plantGraphToMermaid,
  pressurizedWaterReactorSixLoopPlantSpec,
  pressurizedWaterReactorPlantSpec,
  processPlantPressurizedWaterReactorSixLoopGraphRef,
  processPlantPressurizedWaterReactorGraphRef,
  processPlantComponentRegistry,
  processPlantDemoTransientCommands,
  processPlantDemoTransients,
  processPlantSixLoopUnitOverviewSurface,
  processPlantUnitOverviewSurface,
  processPlantUnitOverviewSurfaceForGraph,
  processLinkVariableDescriptorSchema,
  collectProcessPlantCatalog,
  listProcessPlantAssemblyRefs,
  listProcessPlantGraphRefs,
  processPlantModularGraphAssemblyRef,
  processPlantPwrReferenceBaseFragmentRefForLoopCount,
  processPlantPwrReferenceAssemblyRef,
  processPlantPwrReferenceGraphIcRef,
  processPlantPwrReferenceIcRefForLoopCount,
  processPlantPwrReferenceLoopInstancePresetRef,
  processPlantPwrReferenceLoopTemplateFragmentRef,
  listProcessPlantGraphFragmentInstancePresetRefs,
  listProcessPlantGraphFragmentRefs,
  resolveProcessPlantIcConfig,
  resolveProcessPlantIcConfigForGraph,
  instantiateGraphFragment,
  assertProcessPlantIcRulesValid,
  tagIdForLookup,
  variableDescriptorSchema,
  type ProcessPlantCatalogContribution,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from '../src/scenarios/index.ts'

const genericLiquidLinkVariables = (labelPrefix: string) => [
  processLinkVariableDescriptorSchema.parse({
    path: 'flowKgPerS',
    label: `${labelPrefix} flow`,
    kind: 'derived',
    discipline: 'hydraulic',
    writable: false,
    publish: 'telemetry',
    quantity: 'flowRate',
    unit: 'kg/s',
    initialValue: 0,
  }),
  processLinkVariableDescriptorSchema.parse({
    path: 'temperatureC',
    label: `${labelPrefix} temperature`,
    kind: 'derived',
    discipline: 'thermal',
    writable: false,
    publish: 'telemetry',
    quantity: 'temperature',
    unit: 'degC',
    initialValue: 20,
  }),
]

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
      'condenser',
    ]))
    expect(compiled.components.every(component => component.variables.length > 0)).toBe(true)
    expect(compiled.linksByKind.fluidFlow.length).toBeGreaterThan(40)
    expect(compiled.linksByKind.thermalContact).toEqual([0])
    expect(compiled.linksByKind.electricalPower.length).toBeGreaterThanOrEqual(20)
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
    const railProfile = compiled.displayProfiles.find(profile => profile.id === 'leitbild-rail')
    expect(railProfile?.groups.flatMap(group => group.fields).map(field => field.path)).toEqual(expect.arrayContaining([
      'core.totalThermalPowerMw',
      'turbine.electricMw',
      'pressurizer.pressureMPa',
    ]))
    expect(publishedVariables).toContain('safetyBusA.energized')
    expect(publishedVariables).toContain('safetyBusB.marginMw')
  })

  test('compiles the six-loop pressurized water reactor graph into six SG and RCP loops', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorSixLoopPlantSpec, processPlantComponentRegistry)

    expect(String(compiled.specId)).toBe(processPlantPressurizedWaterReactorSixLoopGraphRef)
    expect(compiled.components.filter(component => component.kind === 'steamGenerator').map(component => String(component.id))).toEqual([
      'sgA',
      'sgB',
      'sgC',
      'sgD',
      'sgE',
      'sgF',
    ])
    expect(compiled.components.filter(component => component.kind === 'centrifugalPump').map(component => String(component.id))).toEqual(expect.arrayContaining([
      'rcpA',
      'rcpB',
      'rcpC',
      'rcpD',
      'rcpE',
      'rcpF',
    ]))
    expect(compiled.variables.map(variable => String(variable.path))).toEqual(expect.arrayContaining([
      'sgE.levelPercent',
      'sgF.levelPercent',
      'rcs-hot-leg-e.flowKgPerS',
      'rcs-cold-leg-f.flowKgPerS',
      'sg-e-steam-to-msiv-e.flowKgPerS',
      'feedwater-control-valve-f-to-sg-f.flowKgPerS',
    ]))
  })

  test('preserves strict graph metadata on components and connections', () => {
    const graphWithMetadata = structuredClone(pressurizedWaterReactorPlantSpec) as PlantGraphSpec
    graphWithMetadata.components = graphWithMetadata.components.map(componentSpec => componentSpec.id === 'sgA'
      ? {
          ...componentSpec,
          metadata: {
            role: 'heat-sink',
            groupId: 'primary-loop',
            loopId: 'A',
            ordinal: 0,
            equipmentClass: 'steam-generator',
          },
        }
      : componentSpec)
    graphWithMetadata.connections = graphWithMetadata.connections.map(connectionSpec => connectionSpec.id === 'sg-a-steam-to-msiv-a'
      ? {
          ...connectionSpec,
          metadata: {
            role: 'main-steam-path',
            groupId: 'primary-loop',
            loopId: 'A',
            ordinal: 0,
          },
        }
      : connectionSpec)

    const compiled = compilePlantGraph(graphWithMetadata, processPlantComponentRegistry)

    expect(compiled.components.find(componentItem => componentItem.id === 'sgA')?.metadata).toEqual({
      role: 'heat-sink',
      groupId: 'primary-loop',
      loopId: 'A',
      ordinal: 0,
      equipmentClass: 'steam-generator',
    })
    expect(compiled.links.find(link => link.id === 'sg-a-steam-to-msiv-a')?.metadata).toEqual({
      role: 'main-steam-path',
      groupId: 'primary-loop',
      loopId: 'A',
      ordinal: 0,
    })
  })

  test('rejects unknown graph metadata fields', () => {
    const invalid = structuredClone(pressurizedWaterReactorPlantSpec) as unknown as {
      components: Array<Record<string, unknown>>
    }
    invalid.components[0] = {
      ...invalid.components[0],
      metadata: {
        role: 'reactor-core',
        hiddenBehavior: 'not-allowed',
      },
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('Unrecognized key')
  })

  test('requires component-declared dynamic ports before links can use higher loop ids', () => {
    const invalid = structuredClone(pressurizedWaterReactorPlantSpec) as PlantGraphSpec
    invalid.connections = invalid.connections.map(connectionSpec => connectionSpec.id === 'rcs-hot-leg-a'
      ? { ...connectionSpec, from: 'core.hotLegG' as never }
      : connectionSpec)

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('connection rcs-hot-leg-a references unknown port: core.hotLegG')

    const valid = structuredClone(invalid) as PlantGraphSpec
    valid.components = valid.components.map(componentSpec => componentSpec.id === 'core'
      ? {
          ...componentSpec,
          parameters: {
            ...(componentSpec.parameters as Record<string, unknown>),
            primaryLoopIds: ['G'],
          },
        }
      : componentSpec)
    const compiled = compilePlantGraph(valid, processPlantComponentRegistry)

    expect(compiled.components.find(componentItem => componentItem.id === 'core')?.ports.hotLegG).toMatchObject({
      kind: 'hydraulicThermal',
      direction: 'out',
    })
  })

  test('resolves declared header port ids as typed ports', () => {
    const valid = structuredClone(pressurizedWaterReactorPlantSpec) as PlantGraphSpec
    valid.components = valid.components.map(componentSpec => componentSpec.id === 'mainSteamHeader'
      ? {
          ...componentSpec,
          parameters: {
            ...(componentSpec.parameters as Record<string, unknown>),
            portIds: ['G'],
          },
        }
      : componentSpec)
    valid.connections = valid.connections.map(connectionSpec => connectionSpec.id === 'msiv-a-to-main-steam-header'
      ? { ...connectionSpec, to: 'mainSteamHeader.inletG' as never }
      : connectionSpec)

    const compiled = compilePlantGraph(valid, processPlantComponentRegistry)

    expect(compiled.components.find(componentItem => componentItem.id === 'mainSteamHeader')?.ports.inletG).toMatchObject({
      kind: 'steam',
      direction: 'in',
    })
  })

  test('compiles the reference process surface against real graph variables and topology', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const surface = compileProcessSurface({
      definition: processPlantUnitOverviewSurface,
      graph,
    })

    expect(surface.id).toBe('unit-overview')
    expect(surface.widgets.map(widget => widget.id)).toEqual(expect.arrayContaining([
      'reactor-vessel',
      'pressurizer',
      'sg-a',
      'sg-b',
      'alarm-panel',
      'turbine',
      'condenser',
    ]))
    expect(surface.widgets.find(widget => widget.id === 'alarm-panel')?.type).toBe('alarmPanel')
    expect(surface.paths.map(path => path.id)).toEqual(expect.arrayContaining([
      'primary-hot-leg-a',
      'main-steam-to-turbine',
      'turbine-exhaust-to-condenser',
      'feedwater-to-sg-a',
    ]))
    expect(surface.widgets.find(widget => widget.id === 'reactor-vessel')?.source?.componentIds.map(String)).toEqual(['core', 'vessel'])
    expect(String(surface.paths.find(path => path.id === 'primary-hot-leg-a')?.source?.connectionId)).toBe('rcs-hot-leg-a')
    expect(surface.bindingPaths.map(path => String(path))).toEqual(expect.arrayContaining([
      'core.totalThermalPowerMw',
      'pressurizer.pressureMPa',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'turbine.electricMw',
      'main-steam-header-to-turbine-stop-valve.flowKgPerS',
    ]))
    expect(surface.widgets.every(widget => widget.geometry.width > 0 && widget.geometry.height > 0)).toBe(true)
    expect(surface.paths.every(path => path.points.length >= 3)).toBe(true)
  })

  test('compiles the six-loop process surface against the six-loop graph', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorSixLoopPlantSpec, processPlantComponentRegistry)
    const surface = compileProcessSurface({
      definition: processPlantSixLoopUnitOverviewSurface,
      graph,
    })

    expect(surface.designSize.width).toBeGreaterThan(processPlantUnitOverviewSurface.designSize.width)
    expect(surface.widgets.filter(widget => widget.role === 'steam-generator').map(widget => widget.id)).toEqual([
      'sg-a',
      'sg-b',
      'sg-c',
      'sg-d',
      'sg-e',
      'sg-f',
    ])
    expect(surface.widgets.filter(widget => widget.role === 'reactor-coolant-pump').map(widget => widget.id)).toEqual([
      'rcp-a',
      'rcp-b',
      'rcp-c',
      'rcp-d',
      'rcp-e',
      'rcp-f',
    ])
    expect(surface.paths.map(path => path.id)).toEqual(expect.arrayContaining([
      'primary-hot-leg-e',
      'primary-cold-leg-f',
      'steam-e-to-header',
      'feedwater-to-sg-f',
    ]))
  })

  test('reference demo transients target writable graph variables', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const variablesByPath = new Map(graph.variables.map(variable => [String(variable.path), variable]))

    expect(processPlantDemoTransients).toHaveLength(7)
    for (const transient of processPlantDemoTransients) {
      const commands = processPlantDemoTransientCommands(
        transient,
        defaultProcessPlantDemoTransientInputs(transient),
      )
      expect(commands.length).toBeGreaterThan(0)
      for (const command of commands) {
        const variable = variablesByPath.get(String(command.path))
        expect(variable, `${transient.id} references ${command.path}`).toBeDefined()
        if (!variable) continue
        expect(variable.descriptor.writable, `${transient.id} targets non-writable ${command.path}`).toBe(true)
        expect(typeof command.value).toBe(variable.descriptor.quantity === 'boolean' ? 'boolean' : 'number')
        if (typeof command.value === 'number') {
          const range = variable.descriptor.limits?.hardRange
          if (range) {
            expect(command.value).toBeGreaterThanOrEqual(range.min)
            expect(command.value).toBeLessThanOrEqual(range.max)
          }
        }
      }
    }
  })

  test('process surfaces reject stale graph source references', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)

    expect(() => compileProcessSurface({
      definition: {
        ...processPlantUnitOverviewSurface,
        widgets: processPlantUnitOverviewSurface.widgets.map(widget => widget.id === 'reactor-vessel'
          ? { ...widget, source: { componentIds: ['missing-vessel' as never] } }
          : widget),
      },
      graph,
    })).toThrow('unknown component')

    expect(() => compileProcessSurface({
      definition: {
        ...processPlantUnitOverviewSurface,
        paths: processPlantUnitOverviewSurface.paths.map(path => path.id === 'primary-hot-leg-a'
          ? { ...path, source: { connectionId: 'missing-link' as never } }
          : path),
      },
      graph,
    })).toThrow('unknown connection')
  })

  test('reference graph wires safety-train electrical dependencies explicitly', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const electricallyFedComponents = [
      ...new Set(
      compiled.links
        .filter(link => link.kind === 'electricalPower')
        .map(link => String(compiled.components[link.toComponentIndex]?.id)),
      ),
    ]

    expect(electricallyFedComponents).toEqual(expect.arrayContaining([
      'rcpA',
      'rcpB',
      'rcpC',
      'rcpD',
      'mainFeedwaterPumpA',
      'mainFeedwaterPumpB',
      'auxFeedwaterPumpMotor',
      'auxFeedwaterPumpMotorB',
      'auxFeedwaterPumpTurbine',
      'condensatePumpA',
      'condensatePumpB',
      'circulatingWaterPump',
      'chargingPump',
      'chargingPumpB',
      'safetyInjectionPumpA',
      'safetyInjectionPumpB',
      'containmentSprayPumpA',
      'containmentSprayPumpB',
      'rhrPumpA',
      'rhrPumpB',
      'pressurizer',
    ]))
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

  test('built-in PWR demos use assembled graphs while retaining per-unit initial variation', () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-process-plant-demo')
    if (!scenario) throw new Error('expected Halden process-plant demo scenario')
    const osloScenario = scenarios.find(candidate => candidate.id === 'oslo-all-packs-demo')
    if (!osloScenario) throw new Error('expected Oslo all-packs demo scenario')
    const fixedPwrGraphRefs = new Set([
      processPlantPressurizedWaterReactorGraphRef,
      processPlantPressurizedWaterReactorSixLoopGraphRef,
    ])
    const fixedPwrIcRefs = new Set([
      'process-plant.pressurized-water-reactor.ic.v1',
      'process-plant.pressurized-water-reactor-6-loop.ic.v1',
    ])

    const systems = compileProcessPlantSystems(scenario.processSystems)
    const haldenSixLoop = systems.find(system => system.id === 'halden-6-loop')
    const demoRuntimeConfig = (input: ScenarioDefinition): { readonly systems?: Record<string, { readonly icRef?: string }> } => {
      const config = input.runtimeConfigs['process-plant']
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`missing process-plant runtime config for ${input.id}`)
      return config as { readonly systems?: Record<string, { readonly icRef?: string }> }
    }
    const builtInProcessPlantScenarios = scenarios.filter(candidate => candidate.processSystems.length > 0)
    const allBuiltInProcessSystems = builtInProcessPlantScenarios.flatMap(candidate => candidate.processSystems)
    const allBuiltInProcessPlantRuntimeConfigs = builtInProcessPlantScenarios.flatMap(candidate =>
      Object.values(demoRuntimeConfig(candidate).systems ?? {}),
    )
    const powerFractions = scenario.processSystems.map(system => {
      const parameters = system.parameters?.core
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`missing core variation for ${system.id}`)
      const initialPowerFraction = (parameters as Record<string, unknown>).initialPowerFraction
      if (typeof initialPowerFraction !== 'number') throw new Error(`missing numeric core initialPowerFraction for ${system.id}`)
      return initialPowerFraction
    })
    const pzrPressures = systems.map(system => {
      const pressure = system.initialState.find(initial => initial.path === 'pressurizer.pressureMPa')
      if (!pressure || typeof pressure.value !== 'number') throw new Error(`missing pressurizer pressure initialState for ${system.id}`)
      return pressure.value
    })
    const sgAInventories = systems.map(system => {
      const inventory = system.initialState.find(initial => initial.path === 'sgA.secondaryInventoryKg')
      if (!inventory || typeof inventory.value !== 'number') throw new Error(`missing SG A inventory initialState for ${system.id}`)
      return inventory.value
    })

    expect(systems).toHaveLength(7)
    expect(allBuiltInProcessSystems.some(system => system.graphRef !== undefined && fixedPwrGraphRefs.has(system.graphRef))).toBe(false)
    expect(allBuiltInProcessPlantRuntimeConfigs.some(config => config.icRef !== undefined && fixedPwrIcRefs.has(config.icRef))).toBe(false)
    expect(scenario.processSystems.every(system => system.graphRef === undefined)).toBe(true)
    expect(scenario.processSystems.every(system => system.assemblyRef === processPlantPwrReferenceAssemblyRef)).toBe(true)
    expect(scenario.processSystems.filter(system =>
      typeof system.assemblyConfig === 'object'
      && system.assemblyConfig !== null
      && !Array.isArray(system.assemblyConfig)
      && (system.assemblyConfig as Record<string, unknown>).loopCount === 4,
    )).toHaveLength(6)
    expect(scenario.processSystems.find(system => system.id === 'halden-6-loop')?.assemblyConfig).toEqual({ loopCount: 6 })
    expect(String(haldenSixLoop?.graph.specId)).toBe('process-plant.pressurized-water-reactor-6-loop.assembled.v2')
    expect(haldenSixLoop?.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator')).toHaveLength(6)
    expect(Object.values(demoRuntimeConfig(scenario).systems ?? {}).every(config => config.icRef === processPlantPwrReferenceGraphIcRef)).toBe(true)
    expect(osloScenario.processSystems.every(system => system.graphRef === undefined)).toBe(true)
    expect(osloScenario.processSystems.every(system => system.assemblyRef === processPlantPwrReferenceAssemblyRef)).toBe(true)
    expect(osloScenario.processSystems.every(system =>
      typeof system.assemblyConfig === 'object'
      && system.assemblyConfig !== null
      && !Array.isArray(system.assemblyConfig)
      && (system.assemblyConfig as Record<string, unknown>).loopCount === 4,
    )).toBe(true)
    expect(Object.values(demoRuntimeConfig(osloScenario).systems ?? {}).every(config => config.icRef === processPlantPwrReferenceGraphIcRef)).toBe(true)
    expect(new Set(powerFractions).size).toBeGreaterThan(3)
    expect(new Set(pzrPressures).size).toBeGreaterThan(3)
    expect(new Set(sgAInventories).size).toBeGreaterThan(3)
  })

  test('process plant catalog contributions expose graph assembly fragment and preset refs', () => {
    expect(listProcessPlantGraphRefs()).toEqual(expect.arrayContaining([
      processPlantPressurizedWaterReactorGraphRef,
      processPlantPressurizedWaterReactorSixLoopGraphRef,
    ]))
    expect(listProcessPlantAssemblyRefs()).toEqual(expect.arrayContaining([
      processPlantModularGraphAssemblyRef,
      processPlantPwrReferenceAssemblyRef,
    ]))
    expect(listProcessPlantGraphFragmentRefs()).toEqual(expect.arrayContaining([
      processPlantPwrReferenceBaseFragmentRefForLoopCount(2),
      processPlantPwrReferenceLoopTemplateFragmentRef,
    ]))
    expect(listProcessPlantGraphFragmentInstancePresetRefs()).toEqual(expect.arrayContaining([
      processPlantPwrReferenceLoopInstancePresetRef,
    ]))
  })

  test('process plant catalog contributions reject duplicate refs across contributors', () => {
    const graphRef = 'process-plant.duplicate.graph.v1'
    const assemblyRef = 'process-plant.duplicate.assembly.v1'
    const fragmentRef = 'process-plant.duplicate.fragment.v1'
    const presetRef = 'process-plant.duplicate.preset.v1'
    const first: ProcessPlantCatalogContribution = {
      id: 'first',
      graphSpecs: [{ ref: graphRef, graph: () => pressurizedWaterReactorPlantSpec }],
      assemblies: [{ ref: assemblyRef, assemble: () => pressurizedWaterReactorPlantSpec }],
      graphFragments: [{ ref: fragmentRef, fragment: () => ({ components: [], connections: [] }) }],
      graphFragmentInstancePresets: [{ ref: presetRef, instance: () => ({}) }],
    }

    expect(() => collectProcessPlantCatalog([
      first,
      { id: 'duplicate-graph', graphSpecs: [{ ref: graphRef, graph: () => pressurizedWaterReactorSixLoopPlantSpec }] },
    ])).toThrow(`process plant catalog duplicate graphRef "${graphRef}"`)
    expect(() => collectProcessPlantCatalog([
      first,
      { id: 'duplicate-assembly', assemblies: [{ ref: assemblyRef, assemble: () => pressurizedWaterReactorSixLoopPlantSpec }] },
    ])).toThrow(`process plant catalog duplicate assemblyRef "${assemblyRef}"`)
    expect(() => collectProcessPlantCatalog([
      first,
      { id: 'duplicate-fragment', graphFragments: [{ ref: fragmentRef, fragment: () => ({ components: [], connections: [] }) }] },
    ])).toThrow(`process plant catalog duplicate graph fragmentRef "${fragmentRef}"`)
    expect(() => collectProcessPlantCatalog([
      first,
      { id: 'duplicate-preset', graphFragmentInstancePresets: [{ ref: presetRef, instance: () => ({}) }] },
    ])).toThrow(`process plant catalog duplicate graph fragment instance presetRef "${presetRef}"`)
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
    })).toThrow('process system must define exactly one of graph, graphRef, or assemblyRef')
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
    })).toThrow('process system must define exactly one of graph, graphRef, or assemblyRef')
  })

  test('rejects process system assemblyConfig without assemblyRef', () => {
    expect(() => scenarioDefinitionSchema.parse({
      id: 'assembly-config-without-ref',
      schemaVersion: 1,
      title: 'Assembly Config Without Ref',
      packs: ['process-plant'],
      world: { environment: {} },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        graphRef: processPlantPressurizedWaterReactorGraphRef,
        assemblyConfig: { loopCount: 5 },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    })).toThrow('process system assemblyConfig requires assemblyRef')
  })

  test('instantiates generic process plant graph fragments with substitutions and structural overlays', () => {
    const fragment = instantiateGraphFragment({
      components: [
        {
          id: 'sourceA' as never,
          kind: 'demoSource' as never,
          label: 'Source A',
          parameters: { slot: 'A' },
          variables: [],
        },
        {
          id: 'sinkA' as never,
          kind: 'demoSink' as never,
          label: 'Sink A',
          parameters: { slot: 'A' },
          variables: [],
        },
      ],
      connections: [{
        id: 'signal-a' as never,
        from: 'sourceA.out' as never,
        to: 'sinkA.in' as never,
        connectionKind: 'controlSignal',
        variables: [],
      }],
      publishedVariables: ['sourceA.output' as never],
      displayProfiles: [{
        id: 'demo-profile' as never,
        label: 'Demo profile',
        groups: [{
          id: 'signals' as never,
          label: 'Signals',
          fields: [{
            key: 'source' as never,
            label: 'Source',
            path: 'sourceA.output' as never,
          }],
        }],
      }],
    }, {
      substitutions: [
        { from: 'sourceA', to: 'sourceC' },
        { from: 'sinkA', to: 'sinkC' },
        { from: 'signal-a', to: 'signal-c' },
        { from: ' A', to: ' C' },
      ],
      componentMetadata: { groupId: 'train-c' },
      connectionMetadata: { groupId: 'train-c' },
      componentOverlays: [{
        id: 'sourceC',
        parameters: { slot: 'C', gain: 2 },
        metadata: { role: 'source' },
      }],
      connectionOverlays: [{
        id: 'signal-c',
        nextId: 'signal-final-c',
        from: 'sourceC.altOut',
        metadata: { role: 'command-path' },
      }],
    })

    expect(fragment.components.find(componentItem => componentItem.id === 'sourceC')).toMatchObject({
      label: 'Source C',
      parameters: { slot: 'C', gain: 2 },
      metadata: { groupId: 'train-c', role: 'source' },
    })
    expect(fragment.components.find(componentItem => componentItem.id === 'sinkC')).toMatchObject({
      metadata: { groupId: 'train-c' },
    })
    expect(fragment.connections[0]).toMatchObject({
      id: 'signal-final-c',
      from: 'sourceC.altOut',
      to: 'sinkC.in',
      metadata: { groupId: 'train-c', role: 'command-path' },
    })
    expect(fragment.publishedVariables.map(String)).toEqual(['sourceC.output'])
    expect(String(fragment.displayProfiles[0]?.groups[0]?.fields[0]?.path)).toBe('sourceC.output')
  })

  test('rejects generic graph fragment overlays that miss their instantiated target', () => {
    expect(() => instantiateGraphFragment({
      components: [{
        id: 'sourceA' as never,
        kind: 'demoSource' as never,
        label: 'Source A',
        parameters: { slot: 'A' },
        variables: [],
      }],
      connections: [],
    }, {
      substitutions: [{ from: 'sourceA', to: 'sourceB' }],
      componentOverlays: [{
        id: 'sourceA',
        parameters: { slot: 'wrong' },
      }],
    })).toThrow('graph fragment component overlay references unknown id: sourceA')
  })

  test('assembles a non-PWR modular process plant from reusable fragments', () => {
    const productConnection = (id: string, from: string, to: string, label: string) => ({
      id,
      from,
      to,
      connectionKind: 'fluidFlow',
      service: 'product',
      nominalFluid: 'generic',
      designPhase: 'liquid',
      solverModel: 'sourceSink',
      variables: genericLiquidLinkVariables(label),
    })
    const tankParameters = {
      nominalInventoryKg: 10_000,
      initialInventoryFraction: 0.7,
      initialTemperatureC: 6,
      makeupFlowKgPerS: 0,
      maxOutletFlowKgPerS: 30,
    }
    const baseGraph = plantGraph({
      id: 'process-plant.generic-dairy-base.v1',
      title: 'Generic Dairy Base',
      fixedStepMs: 250,
      components: [
        component('sourceTank', 'processTank', 'Raw Product Tank', tankParameters),
      ],
      connections: [],
      publishedVariables: ['sourceTank.levelPercent'],
    })

    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-dairy-process',
      schemaVersion: 1,
      title: 'Modular Dairy Process',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.generic-dairy-two-line.v1',
          title: 'Generic Dairy Two-Line Process',
          baseGraph,
          baseOverlays: {
            componentOverlays: [{
              id: 'sourceTank',
              parameters: {
                nominalInventoryKg: 20_000,
                maxOutletFlowKgPerS: 60,
              },
              metadata: {
                role: 'raw-product-source',
                groupId: 'common-feed',
              },
            }],
          },
          fragments: [{
            id: 'fermentation-line',
            fragment: {
              components: [
                component('feedPumpA', 'centrifugalPump', 'Feed Pump A', {
                  nominalFlowKgPerS: 12,
                  nominalHeadPa: 160_000,
                  initialRunning: true,
                }),
                component('feedValveA', 'processValve', 'Feed Valve A', {
                  initialPositionFraction: 1,
                  valveMode: 'control',
                  cvKgPerSPerSqrtMPa: 4,
                }),
                component('fermenterA', 'processTank', 'Fermenter A', {
                  nominalInventoryKg: 8_000,
                  initialInventoryFraction: 0.3,
                  initialTemperatureC: 38,
                  makeupFlowKgPerS: 0,
                  maxOutletFlowKgPerS: 12,
                }),
              ],
              connections: [
                productConnection('source-to-feed-pump-a', 'sourceTank.outlet', 'feedPumpA.inlet', 'Source to feed pump A'),
                productConnection('feed-pump-a-to-feed-valve-a', 'feedPumpA.outlet', 'feedValveA.inlet', 'Feed pump A to valve A'),
                productConnection('feed-valve-a-to-fermenter-a', 'feedValveA.outlet', 'fermenterA.inlet', 'Feed valve A to fermenter A'),
              ],
              publishedVariables: [
                'feedPumpA.flowKgPerS',
                'fermenterA.levelPercent',
                'feed-valve-a-to-fermenter-a.flowKgPerS',
              ],
            },
          }],
          instances: [
            {
              fragmentRef: 'fermentation-line',
              componentMetadata: {
                groupId: 'fermentation-line',
                trainId: 'A',
                ordinal: 0,
              },
              componentOverlays: [{
                id: 'fermenterA',
                parameters: {
                  initialTemperatureC: 42,
                },
                metadata: {
                  role: 'fermenter',
                },
              }],
            },
            {
              fragmentRef: 'fermentation-line',
              substitutions: [
                { from: 'feedPumpA', to: 'feedPumpB' },
                { from: 'feedValveA', to: 'feedValveB' },
                { from: 'fermenterA', to: 'fermenterB' },
                { from: ' A', to: ' B' },
                { from: '-a', to: '-b' },
              ],
              componentMetadata: {
                groupId: 'fermentation-line',
                trainId: 'B',
                ordinal: 1,
              },
              componentOverlays: [{
                id: 'feedPumpB',
                parameters: {
                  nominalFlowKgPerS: 15,
                },
              }, {
                id: 'fermenterB',
                parameters: {
                  nominalInventoryKg: 12_000,
                  initialTemperatureC: 39,
                },
                metadata: {
                  role: 'fermenter',
                },
              }],
            },
          ],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    expect(String(system.graph.specId)).toBe('process-plant.generic-dairy-two-line.v1')
    expect(system.graph.components.map(componentItem => String(componentItem.id))).toEqual(expect.arrayContaining([
      'sourceTank',
      'feedPumpA',
      'feedPumpB',
      'feedValveA',
      'feedValveB',
      'fermenterA',
      'fermenterB',
    ]))
    expect(system.graph.components.find(componentItem => componentItem.id === 'sourceTank')?.parameters).toMatchObject({
      nominalInventoryKg: 20_000,
      maxOutletFlowKgPerS: 60,
    })
    expect(system.graph.components.find(componentItem => componentItem.id === 'fermenterA')?.parameters).toMatchObject({
      initialTemperatureC: 42,
    })
    expect(system.graph.components.find(componentItem => componentItem.id === 'feedPumpB')?.parameters).toMatchObject({
      nominalFlowKgPerS: 15,
    })
    expect(system.graph.components.find(componentItem => componentItem.id === 'fermenterB')?.metadata).toMatchObject({
      groupId: 'fermentation-line',
      trainId: 'B',
      ordinal: 1,
      role: 'fermenter',
    })
    expect(system.graph.links.map(link => String(link.id))).toEqual(expect.arrayContaining([
      'source-to-feed-pump-a',
      'source-to-feed-pump-b',
      'feed-valve-b-to-fermenter-b',
    ]))
    expect(system.graph.variables.map(variable => String(variable.path))).toEqual(expect.arrayContaining([
      'sourceTank.levelPercent',
      'feedPumpA.flowKgPerS',
      'feedPumpB.flowKgPerS',
      'fermenterA.levelPercent',
      'fermenterB.levelPercent',
      'feed-valve-b-to-fermenter-b.flowKgPerS',
    ]))
    expect(system.graph.components.some(componentItem => componentItem.kind === 'reactorCore')).toBe(false)
    expect(system.graph.components.some(componentItem => componentItem.kind === 'steamGenerator')).toBe(false)
  })

  test('rejects modular graph assemblies that reference missing fragments', () => {
    const baseGraph = plantGraph({
      id: 'process-plant.generic-empty-base.v1',
      title: 'Generic Empty Base',
      fixedStepMs: 250,
      components: [
        component('sourceTank', 'processTank', 'Raw Product Tank', {
          nominalInventoryKg: 10_000,
          initialInventoryFraction: 0.7,
          initialTemperatureC: 6,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 30,
        }),
      ],
      connections: [],
    })
    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-missing-fragment',
      schemaVersion: 1,
      title: 'Modular Missing Fragment',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.invalid-modular.v1',
          title: 'Invalid Modular Plant',
          baseGraph,
          instances: [{ fragmentRef: 'missing-fragment' }],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('modular graph instance references unknown fragment: missing-fragment')
  })

  test('rejects modular graph assemblies that import unknown fragment refs', () => {
    const baseGraph = plantGraph({
      id: 'process-plant.generic-import-base.v1',
      title: 'Generic Import Base',
      fixedStepMs: 250,
      components: [
        component('sourceTank', 'processTank', 'Raw Product Tank', {
          nominalInventoryKg: 10_000,
          initialInventoryFraction: 0.7,
          initialTemperatureC: 6,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 30,
        }),
      ],
      connections: [],
    })
    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-unknown-imported-fragment',
      schemaVersion: 1,
      title: 'Modular Unknown Imported Fragment',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.invalid-imported-fragment.v1',
          title: 'Invalid Imported Fragment Plant',
          baseGraph,
          fragments: [{
            id: 'imported',
            fragmentRef: 'process-plant.no-such-fragment.v1',
          }],
          instances: [{ fragmentRef: 'imported' }],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('unknown process plant graph fragmentRef: process-plant.no-such-fragment.v1')
  })

  test('rejects modular graph assemblies that import unknown instance preset refs', () => {
    const baseGraph = plantGraph({
      id: 'process-plant.generic-preset-base.v1',
      title: 'Generic Preset Base',
      fixedStepMs: 250,
      components: [
        component('sourceTank', 'processTank', 'Raw Product Tank', {
          nominalInventoryKg: 10_000,
          initialInventoryFraction: 0.7,
          initialTemperatureC: 6,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 30,
        }),
      ],
      connections: [],
    })
    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-unknown-instance-preset',
      schemaVersion: 1,
      title: 'Modular Unknown Instance Preset',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.invalid-instance-preset.v1',
          title: 'Invalid Instance Preset Plant',
          baseGraph,
          fragments: [{
            id: 'line',
            fragment: {
              components: [],
              connections: [],
            },
          }],
          instances: [{
            fragmentRef: 'line',
            presetRef: 'process-plant.no-such-instance-preset.v1',
          }],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('unknown process plant graph fragment instance presetRef: process-plant.no-such-instance-preset.v1')
  })

  test('imports and customizes an existing process plant graph through generic modular assembly', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-pwr-reference-import',
      schemaVersion: 1,
      title: 'Modular PWR Reference Import',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.reference-pwr-overlaid.v1',
          title: 'Reference PWR Overlaid Through Modular Assembly',
          baseGraphRef: processPlantPressurizedWaterReactorGraphRef,
          baseOverlays: {
            componentOverlays: [{
              id: 'core',
              parameters: {
                ratedPowerMw: 2_450,
              },
              metadata: {
                role: 'heat-source',
                groupId: 'reactor-island',
              },
            }],
          },
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    expect(String(system.graph.specId)).toBe('process-plant.reference-pwr-overlaid.v1')
    expect(system.sourceGraph.components).toHaveLength(pressurizedWaterReactorPlantSpec.components.length)
    expect(system.sourceGraph.connections).toHaveLength(pressurizedWaterReactorPlantSpec.connections.length)
    expect(system.sourceGraph.components.find(componentItem => componentItem.id === 'core')).toMatchObject({
      parameters: { ratedPowerMw: 2_450 },
      metadata: {
        role: 'heat-source',
        groupId: 'reactor-island',
      },
    })
    expect(system.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator')).toHaveLength(4)
    expect(system.graph.components.find(componentItem => componentItem.id === 'mainSteamHeader')?.ports.inletD).toMatchObject({
      kind: 'steam',
      direction: 'in',
    })
  })

  test('assembles imported process plant fragments through the generic modular path', () => {
    expect(listProcessPlantGraphFragmentRefs()).toEqual(expect.arrayContaining([
      processPlantPwrReferenceBaseFragmentRefForLoopCount(2),
      processPlantPwrReferenceLoopTemplateFragmentRef,
    ]))
    expect(listProcessPlantGraphFragmentInstancePresetRefs()).toEqual(expect.arrayContaining([
      processPlantPwrReferenceLoopInstancePresetRef,
    ]))

    const scenario = scenarioDefinitionSchema.parse({
      id: 'modular-pwr-imported-fragments',
      schemaVersion: 1,
      title: 'Modular PWR Imported Fragments',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantModularGraphAssemblyRef,
        assemblyConfig: {
          id: 'process-plant.reference-pwr-two-loop.imported-fragments.v1',
          title: 'Reference PWR Two-Loop From Imported Fragments',
          fixedStepMs: 250,
          baseFragmentRef: processPlantPwrReferenceBaseFragmentRefForLoopCount(2),
          fragments: [{
            id: 'pwr-reference-loop',
            fragmentRef: processPlantPwrReferenceLoopTemplateFragmentRef,
          }],
          instances: [{
            fragmentRef: 'pwr-reference-loop',
            presetRef: processPlantPwrReferenceLoopInstancePresetRef,
            presetConfig: {
              loopId: 'A',
              loopCount: 2,
            },
          }, {
            fragmentRef: 'pwr-reference-loop',
            presetRef: processPlantPwrReferenceLoopInstancePresetRef,
            presetConfig: {
              loopId: 'B',
              loopCount: 2,
            },
          }],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    expect(String(system.graph.specId)).toBe('process-plant.reference-pwr-two-loop.imported-fragments.v1')
    expect(system.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator').map(componentItem => String(componentItem.id))).toEqual([
      'sgA',
      'sgB',
    ])
    expect(system.graph.components.filter(componentItem =>
      componentItem.kind === 'centrifugalPump'
      && !!componentItem.parameters
      && typeof componentItem.parameters === 'object'
      && !Array.isArray(componentItem.parameters)
      && typeof (componentItem.parameters as Record<string, unknown>).primaryLoopId === 'string',
    ).map(componentItem => String(componentItem.id))).toEqual([
      'rcpA',
      'rcpB',
    ])
    expect(system.graph.components.find(componentItem => componentItem.id === 'core')?.ports.hotLegB).toMatchObject({
      kind: 'hydraulicThermal',
      direction: 'out',
    })
    expect(system.graph.components.find(componentItem => componentItem.id === 'sgB')?.metadata).toMatchObject({
      groupId: 'primary-loop',
      loopId: 'B',
      ordinal: 1,
    })
    expect(String(system.graph.components[system.graph.links.find(link => link.id === 'safety-bus-b-to-rcpB')?.fromComponentIndex ?? -1]?.id)).toBe('safetyBusB')
  })

  test('assembles reference PWR variants through process system assembly refs', () => {
    for (const loopCount of [2, 5, 9]) {
      const scenario = scenarioDefinitionSchema.parse({
        id: `assembled-pwr-${loopCount}`,
        schemaVersion: 1,
        title: `Assembled PWR ${loopCount}`,
        packs: ['process-plant'],
        world: {
          startsAt: '2026-01-01T09:00:00.000Z',
          environment: {},
        },
        initialObjects: [],
        processSystems: [{
          id: 'plant',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          assemblyRef: processPlantPwrReferenceAssemblyRef,
          assemblyConfig: { loopCount },
        }],
        surface: {
          schemaVersion: 1,
          regions: [],
        },
      }) as ScenarioDefinition

      const system = compileProcessPlantSystem(scenario.processSystems[0]!)
      const loopIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, loopCount).split('')
      const primaryLoopPumps = system.graph.components.filter(componentItem =>
        componentItem.kind === 'centrifugalPump'
        && !!componentItem.parameters
        && typeof componentItem.parameters === 'object'
        && !Array.isArray(componentItem.parameters)
        && typeof (componentItem.parameters as Record<string, unknown>).primaryLoopId === 'string',
      )

      expect(system.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator')).toHaveLength(loopCount)
      expect(primaryLoopPumps).toHaveLength(loopCount)
      expect(system.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator').map(componentItem => String(componentItem.id))).toEqual(loopIds.map(loopId => `sg${loopId}`))
      expect(primaryLoopPumps.map(componentItem => String(componentItem.id))).toEqual(loopIds.map(loopId => `rcp${loopId}`))
      expect(system.graph.components.find(componentItem => componentItem.id === 'core')?.ports[`hotLeg${loopIds.at(-1)}`]).toMatchObject({
        kind: 'hydraulicThermal',
        direction: 'out',
      })
      expect(system.graph.components.find(componentItem => componentItem.id === 'mainSteamHeader')?.ports[`inlet${loopIds.at(-1)}`]).toMatchObject({
        kind: 'steam',
        direction: 'in',
      })
      const surface = compileProcessSurface({
        definition: processPlantUnitOverviewSurfaceForGraph(system.graph),
        graph: system.graph,
      })
      expect(surface.widgets.map(widget => widget.id)).toContain(`sg-${loopIds.at(-1)?.toLowerCase()}`)
    }
  })

  test('uses the generic fragment assembly path for reference PWR variants with custom loop ids', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'assembled-pwr-custom-loop-config',
      schemaVersion: 1,
      title: 'Assembled PWR Custom Loop Config',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantPwrReferenceAssemblyRef,
        assemblyConfig: {
          loopCount: 3,
          loopIds: ['A', 'D', 'H'],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    expect(system.graph.components.filter(componentItem => componentItem.kind === 'steamGenerator').map(componentItem => String(componentItem.id))).toEqual([
      'sgA',
      'sgD',
      'sgH',
    ])
    expect(system.graph.components.map(componentItem => String(componentItem.id))).not.toContain('sgB')
    expect(system.graph.components.find(componentItem => componentItem.id === 'core')?.ports.hotLegH).toMatchObject({
      kind: 'hydraulicThermal',
      direction: 'out',
    })
    expect(system.graph.components.find(componentItem => componentItem.id === 'mainSteamHeader')?.ports.inletH).toMatchObject({
      kind: 'steam',
      direction: 'in',
    })

    const safetyLinkFor = (id: string) => {
      const link = system.graph.links.find(linkItem => linkItem.id === id)
      if (!link) throw new Error(`expected safety train link: ${id}`)
      return link
    }
    expect(String(system.graph.components[safetyLinkFor('safety-bus-b-to-rcpD').fromComponentIndex]?.id)).toBe('safetyBusB')
    expect(String(system.graph.components[safetyLinkFor('safety-bus-a-to-rcpH').fromComponentIndex]?.id)).toBe('safetyBusA')

    const displayPaths = system.sourceGraph.displayProfiles.flatMap(profile =>
      profile.groups.flatMap(group => group.fields.map(field => String(field.path))),
    )
    expect(displayPaths).toContain('sgA.levelPercent')
    expect(displayPaths).toContain('sgD.levelPercent')
    expect(displayPaths).not.toContain('sgH.levelPercent')
  })

  test('rejects inconsistent reference PWR assembly config explicitly', () => {
    const scenarioFor = (assemblyConfig: Record<string, unknown>): ScenarioDefinition => scenarioDefinitionSchema.parse({
      id: 'assembled-pwr-invalid-config',
      schemaVersion: 1,
      title: 'Assembled PWR Invalid Config',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantPwrReferenceAssemblyRef,
        assemblyConfig,
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenarioFor({
      loopCount: 3,
      loopIds: ['A', 'B'],
    }).processSystems[0]!)).toThrow('loopIds length must match loopCount')

    expect(() => compileProcessPlantSystem(scenarioFor({
      loopCount: 3,
      loopIds: ['A', 'B', 'A'],
    }).processSystems[0]!)).toThrow('loopIds must be unique')
  })

  test('generates loop-aware reference I&C for assembled PWR variants', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'assembled-pwr-ic-9',
      schemaVersion: 1,
      title: 'Assembled PWR I&C 9',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantPwrReferenceAssemblyRef,
        assemblyConfig: { loopCount: 9 },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition
    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    const ic = resolveProcessPlantIcConfig(processPlantPwrReferenceIcRefForLoopCount(9))
    const lowRcpFlowRule = ic.rules.find(ruleItem => ruleItem.id === 'reactor-low-rcp-flow-trip')
    if (!lowRcpFlowRule) throw new Error('expected low RCP flow rule')

    expect(lowRcpFlowRule.condition).toMatchObject({ type: 'vote', required: 7 })
    expect(JSON.stringify(lowRcpFlowRule.condition)).toContain('rcpI.loopFlowKgPerS')
    expect(JSON.stringify(lowRcpFlowRule.condition)).not.toContain('rcpJ.loopFlowKgPerS')
    expect(() => assertProcessPlantIcRulesValid(system, ic.rules)).not.toThrow()
  })

  test('derives reference PWR I&C loop ids from the compiled graph', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'assembled-pwr-graph-derived-ic',
      schemaVersion: 1,
      title: 'Assembled PWR Graph Derived I&C',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: processPlantPwrReferenceAssemblyRef,
        assemblyConfig: {
          loopCount: 3,
          loopIds: ['A', 'D', 'H'],
        },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition
    const system = compileProcessPlantSystem(scenario.processSystems[0]!)
    const ic = resolveProcessPlantIcConfigForGraph(processPlantPwrReferenceGraphIcRef, system.graph)
    const lowRcpFlowRule = ic.rules.find(ruleItem => ruleItem.id === 'reactor-low-rcp-flow-trip')
    if (!lowRcpFlowRule) throw new Error('expected low RCP flow rule')

    expect(lowRcpFlowRule.condition).toMatchObject({ type: 'vote', required: 3 })
    expect(JSON.stringify(lowRcpFlowRule.condition)).toContain('rcpA.loopFlowKgPerS')
    expect(JSON.stringify(lowRcpFlowRule.condition)).toContain('rcpD.loopFlowKgPerS')
    expect(JSON.stringify(lowRcpFlowRule.condition)).toContain('rcpH.loopFlowKgPerS')
    expect(JSON.stringify(lowRcpFlowRule.condition)).not.toContain('rcpB.loopFlowKgPerS')
    expect(() => assertProcessPlantIcRulesValid(system, ic.rules)).not.toThrow()
  })

  test('rejects unknown process plant assembly refs explicitly', () => {
    const scenario = scenarioDefinitionSchema.parse({
      id: 'unknown-assembly-ref',
      schemaVersion: 1,
      title: 'Unknown Assembly Ref',
      packs: ['process-plant'],
      world: {
        startsAt: '2026-01-01T09:00:00.000Z',
        environment: {},
      },
      initialObjects: [],
      processSystems: [{
        id: 'plant',
        pack: 'process-plant',
        componentLibrary: 'process-plant',
        assemblyRef: 'process-plant.unknown-assembly.v1',
        assemblyConfig: { loopCount: 5 },
      }],
      surface: {
        schemaVersion: 1,
        regions: [],
      },
    }) as ScenarioDefinition

    expect(() => compileProcessPlantSystem(scenario.processSystems[0]!)).toThrow('unknown process plant assemblyRef: process-plant.unknown-assembly.v1')
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
        component('feedwaterA', 'processTank', 'Feedwater Tank A', {
          nominalInventoryKg: 100_000,
          initialInventoryFraction: 0.8,
          initialTemperatureC: 220,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 760,
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

  test('rejects display profile fields that reference unknown variables', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      displayProfiles: [
        {
          id: 'bad-profile',
          label: 'Bad Profile',
          groups: [{
            id: 'overview',
            label: 'Overview',
            fields: [{
              key: 'missing-field',
              label: 'Missing Field',
              path: 'missing.variable',
            }],
          }],
        },
      ],
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('display profile bad-profile/overview references unknown variable: missing.variable')
  })

  test('rejects component-level initial state in favor of system-level initialState', () => {
    const invalid = {
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
    }

    expect(() => plantGraph(invalid)).toThrow('Unrecognized key')
  })

  test('rejects valve controllers that reference unknown measured paths before runtime', () => {
    const invalid = plantGraph({
      id: 'process-plant.invalid-valve-controller.v1',
      title: 'Invalid Valve Controller Graph',
      fixedStepMs: 100,
      components: [
        component('valve', 'processValve', 'Feedwater Control Valve', {
          initialPositionFraction: 0.5,
          controller: {
            kind: 'proportionalPosition',
            measuredPath: 'sgA.levelPercent',
            setpoint: 70,
            biasPositionFraction: 0.5,
            gainPerUnit: 0.01,
          },
        }),
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('references unknown measuredPath')
  })

  test('rejects valve controllers that measure boolean variables', () => {
    const invalid = plantGraph({
      id: 'process-plant.boolean-valve-controller.v1',
      title: 'Boolean Valve Controller Graph',
      fixedStepMs: 100,
      components: [
        component('valve', 'processValve', 'Feedwater Control Valve', {
          initialPositionFraction: 0.5,
          controller: {
            kind: 'proportionalPosition',
            measuredPath: 'valve.autoOpenActive',
            setpoint: 1,
            biasPositionFraction: 0.5,
            gainPerUnit: 0.01,
          },
        }),
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('must reference a numeric variable')
  })

  test('rejects invalid quantity and unit combinations', () => {
    const result = variableDescriptorSchema.safeParse({
      path: 'core.powerMw',
      label: 'Core power',
      kind: 'state',
      discipline: 'nuclear',
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
      discipline: 'hydraulic',
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
              discipline: 'thermal',
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

  test('rejects stronger component contracts that are structurally incomplete', () => {
    const disconnectedHeatExchanger = plantGraph({
      id: 'process-plant.invalid-heat-exchanger.v1',
      title: 'Invalid Heat Exchanger Graph',
      fixedStepMs: 100,
      components: [
        component('hx', 'heatExchanger', 'Residual Heat Exchanger', {
          uaMwPerC: 3,
          hotSideDesignFlowKgPerS: 100,
          coldSideDesignFlowKgPerS: 100,
        }),
      ],
      connections: [],
    })
    const invalidAccumulator = plantGraph({
      id: 'process-plant.invalid-accumulator.v1',
      title: 'Invalid Accumulator Graph',
      fixedStepMs: 100,
      components: [
        component('acc', 'accumulator', 'Safety Injection Accumulator', {
          totalVolumeM3: 1,
          initialLiquidInventoryKg: 1_100,
          initialGasPressureMPa: 4,
          injectionSetpointMPa: 3,
          outletCvKgPerSPerSqrtMPa: 10,
        }),
      ],
      connections: [],
    })
    const invalidReliefValve = plantGraph({
      id: 'process-plant.invalid-relief-valve.v1',
      title: 'Invalid Relief Valve Graph',
      fixedStepMs: 100,
      components: [
        component('relief', 'steamValve', 'Relief Valve', {
          valveMode: 'relief',
          initialPositionFraction: 0,
        }),
      ],
      connections: [],
    })

    expect(() => compilePlantGraph(disconnectedHeatExchanger, processPlantComponentRegistry)).toThrow('requires incoming connection on port hotIn')
    expect(() => compilePlantGraph(invalidAccumulator, processPlantComponentRegistry)).toThrow('must leave gas volume')
    expect(() => compilePlantGraph(invalidReliefValve, processPlantComponentRegistry)).toThrow('requires setpointMPa')
  })

  test('compiles graph-owned signal bindings for component and link variables', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const pressure = graph.signalBindingByTagId.get(tagIdForLookup('PT-455'))
    const flow = graph.signalBindingByTagId.get(tagIdForLookup('FT-SG-A-001'))
    const heater = graph.signalBindingByTagId.get(tagIdForLookup('PZR-HTR'))
    expect(String(pressure?.path)).toBe('pressurizer.pressureMPa')
    expect(String(flow?.path)).toBe('sg-a-steam-to-msiv-a.flowKgPerS')
    expect(pressure?.capabilities?.aiVisible).toBe(true)
    expect(pressure?.capabilities?.procedureRelevant).toBe(true)
    expect(pressure?.capabilities?.writable).toBe(false)
    expect(heater?.capabilities?.writable).toBe(true)
    expect(heater?.limits?.hardRange).toEqual({ min: 0, max: 30 })
  })

  test('keeps reference graph procedure tags mapped to stable process variables', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const expectedProcedureTags = [
      ['TRIP-BKR-A', 'reactorTripBreakerA.closed'],
      ['TRIP-BKR-B', 'reactorTripBreakerB.closed'],
      ['ROD-POS-AVG', 'core.rodInsertionFraction'],
      ['PT-455', 'pressurizer.pressureMPa'],
      ['CTMT-PR', 'containment.pressureMPa'],
      ['PZR-LVL', 'pressurizer.levelPercent'],
      ['PZR-HTR', 'pressurizer.heaterPowerMw'],
      ['PZR-SPRAY', 'pressurizer.sprayFlowKgPerS'],
      ['PORV-456A', 'pressurizer.reliefValvePositionFraction'],
      ['NIS-SR', 'core.sourceRangeCountRateCps'],
      ['NIS-IR', 'core.intermediateRangeCurrentAmps'],
      ['CET-AVG', 'core.coolantOutletTemperatureC'],
      ['RVLS-DYN', 'vessel.collapsedLiquidLevelPercent'],
      ['SUB-MARGIN', 'vessel.subcoolingMarginC'],
      ['MS-HEADER-PR', 'mainSteamHeader.mixedPressureMPa'],
      ['CONDENSER-VAC', 'condenser.backPressurePa'],
      ['SG-A-LVL-NR', 'sgA.levelPercent'],
      ['SG-A-PRESS', 'sgA.pressureMPa'],
      ['SG-A-N16', 'sgA.secondaryRadiationMSvPerH'],
      ['SG-A-TUBE-LEAK', 'sgA.tubeLeakFraction'],
      ['RCP-A-RUN', 'rcpA.running'],
      ['RCP-A-SPD', 'rcpA.speedFraction'],
      ['RCP-A-FLOW', 'rcpA.loopFlowKgPerS'],
      ['MFW-PUMP-A-RUN', 'mainFeedwaterPumpA.running'],
      ['MFW-PUMP-B-RUN', 'mainFeedwaterPumpB.running'],
      ['AFW-PUMP-A', 'auxFeedwaterPumpMotor.running'],
      ['AFW-PUMP-B', 'auxFeedwaterPumpMotorB.running'],
      ['AFW-PUMP-T', 'auxFeedwaterPumpTurbine.running'],
      ['TDAFW-SPEED', 'auxFeedwaterPumpTurbine.speedRpm'],
      ['CHG-PUMP-A', 'chargingPump.running'],
      ['CHG-PUMP-B', 'chargingPumpB.running'],
      ['BAT-LVL', 'boricAcidTank.levelPercent'],
      ['BORATE-FLOW', 'boric-acid-injection-to-charging-pump.flowKgPerS'],
      ['RWST-LVL', 'rwst.levelPercent'],
      ['SI-PUMP-A', 'safetyInjectionPumpA.running'],
      ['SI-PUMP-B', 'safetyInjectionPumpB.running'],
      ['CSPRAY-A', 'containmentSprayPumpA.running'],
      ['CSPRAY-B', 'containmentSprayPumpB.running'],
      ['SPRAY-FLOW', 'containment.sprayFlowKgPerS'],
      ['RHR-PUMP-A', 'rhrPumpA.running'],
      ['RHR-PUMP-B', 'rhrPumpB.running'],
      ['LO-HEAD-FLOW', 'rhrHeader.outletFlowKgPerS'],
      ['RHR-ISOL', 'rhrIsolationValve.positionFraction'],
      ['CTMT-SUMP-LVL', 'containment.sumpLevelPercent'],
      ['LET-ISOL', 'letdownValve.positionFraction'],
      ['NAOH-LVL', 'containmentSprayAdditiveTank.levelPercent'],
      ['ACCUM-1', 'safetyAccumulatorA.dischargeIsolationOpen'],
      ['ACCUM-2', 'safetyAccumulatorB.dischargeIsolationOpen'],
      ['ACCUM-3', 'safetyAccumulatorC.dischargeIsolationOpen'],
      ['ACCUM-4', 'safetyAccumulatorD.dischargeIsolationOpen'],
      ['FT-SG-A-001', 'sg-a-steam-to-msiv-a.flowKgPerS'],
    ] as const

    for (const [tagId, expectedPath] of expectedProcedureTags) {
      const binding = graph.signalBindingByTagId.get(tagIdForLookup(tagId))
      expect(String(binding?.path)).toBe(expectedPath)
      expect(binding?.capabilities?.procedureRelevant).toBe(true)
      expect(binding?.capabilities?.aiVisible).toBe(true)
    }
  })

  test('indexes procedure source aliases as graph-owned external references', () => {
    const graph = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const expectedAliases = [
      ['NIS-PR-AVG', 'core.powerMw'],
      ['nis.power_range.avg', 'core.powerMw'],
      ['rcs.rod.position.avg', 'core.rodInsertionFraction'],
      ['nis.source_range.count_rate', 'core.sourceRangeCountRateCps'],
      ['nis.intermediate_range.avg', 'core.intermediateRangeCurrentAmps'],
      ['rcs.core_exit.thermocouple.avg', 'core.coolantOutletTemperatureC'],
      ['rcs.rvls.dynamic.level', 'vessel.collapsedLiquidLevelPercent'],
      ['rcs.subcooling_margin', 'vessel.subcoolingMarginC'],
      ['secondary.sg.a.level_nr', 'sgA.levelPercent'],
      ['secondary.sg.b.level_nr', 'sgB.levelPercent'],
      ['secondary.sg.c.level_nr', 'sgC.levelPercent'],
      ['secondary.sg.d.level_nr', 'sgD.levelPercent'],
      ['SG-D-PR', 'sgD.pressureMPa'],
      ['RCP-1', 'rcpA.running'],
      ['rcs.loop1.t_hot', 'rcs-hot-leg-a.temperatureC'],
      ['rcs.loop1.t_cold', 'rcs-cold-leg-a.temperatureC'],
      ['rcs.loop4.t_hot', 'rcs-hot-leg-d.temperatureC'],
      ['rcs.loop4.t_cold', 'rcs-cold-leg-d.temperatureC'],
      ['secondary.msiv.a.position', 'mainSteamIsolationValveA.positionFraction'],
      ['afw.a.cv_position', 'auxFeedwaterValveA.positionFraction'],
      ['afw.header.flow', 'auxFeedwaterHeader.outletFlowKgPerS'],
      ['afw.pump.b.status', 'auxFeedwaterPumpMotorB.running'],
      ['cvcs.charging.flow', 'vessel.chargingFlowKgPerS'],
      ['cvcs.charging_pump.b.status', 'chargingPumpB.running'],
      ['cvcs.letdown.isolation', 'letdownValve.positionFraction'],
      ['rcs.boron.concentration', 'vessel.boronConcentrationPpm'],
      ['secondary.ms_header.pressure', 'mainSteamHeader.mixedPressureMPa'],
      ['secondary.condenser.vacuum', 'condenser.backPressurePa'],
      ['containment.temperature.avg', 'containment.temperatureC'],
      ['rad.containment.high_range', 'containment.radiationSourceTermMSvPerH'],
      ['containment.sump.level', 'containment.sumpLevelPercent'],
      ['rwst.level', 'rwst.levelPercent'],
      ['ess.si_pump.a.status', 'safetyInjectionPumpA.running'],
      ['ess.si_pump.b.status', 'safetyInjectionPumpB.running'],
      ['ess.cspray_pump.a.status', 'containmentSprayPumpA.running'],
      ['ess.cspray_pump.b.status', 'containmentSprayPumpB.running'],
      ['ess.cspray.header_flow', 'containment.sprayFlowKgPerS'],
      ['ess.rhr_pump.a.status', 'rhrPumpA.running'],
      ['ess.rhr_pump.b.status', 'rhrPumpB.running'],
      ['ess.lo_head.header_flow', 'rhrHeader.outletFlowKgPerS'],
      ['ess.rhr.isolation_valve', 'rhrIsolationValve.positionFraction'],
      ['ess.accumulator.1.discharge_valve', 'safetyAccumulatorA.dischargeIsolationOpen'],
      ['ess.accumulator.2.discharge_valve', 'safetyAccumulatorB.dischargeIsolationOpen'],
      ['ess.accumulator.3.discharge_valve', 'safetyAccumulatorC.dischargeIsolationOpen'],
      ['ess.accumulator.4.discharge_valve', 'safetyAccumulatorD.dischargeIsolationOpen'],
      ['BUS-A-EMERG', 'safetyBusA.energized'],
      ['BUS-B-EMERG', 'safetyBusB.energized'],
      ['DG-A', 'dieselGeneratorA.running'],
      ['DG-B', 'dieselGeneratorB.running'],
      ['afw.pump.a.status', 'auxFeedwaterPumpMotor.running'],
      ['afw.pump.tdafw.status', 'auxFeedwaterPumpTurbine.running'],
      ['afw.tdafw.turbine_speed', 'auxFeedwaterPumpTurbine.speedRpm'],
      ['electrical.dc_bus.voltage', 'vitalBatteryA.voltageVdc'],
      ['cvcs.bat.level', 'boricAcidTank.levelPercent'],
      ['cvcs.borate.flow', 'boric-acid-injection-to-charging-pump.flowKgPerS'],
    ] as const

    for (const [externalRef, expectedPath] of expectedAliases) {
      const binding = graph.signalBindingByExternalRef.get(externalRef)
      expect(String(binding?.path)).toBe(expectedPath)
      expect(binding?.capabilities?.procedureRelevant).toBe(true)
    }
  })

  test('rejects duplicate process signal tag ids before runtime', () => {
    const invalidComponentTagId = {
      ...pressurizedWaterReactorPlantSpec,
      components: pressurizedWaterReactorPlantSpec.components.map(component => component.id === 'sgB'
        ? {
            ...component,
            variables: component.variables.map(variable => variable.path === 'levelPercent'
              ? {
                  ...variable,
                  tagId: 'PT-455',
                  equipmentId: 'sgB',
                  description: 'Duplicate tag for test',
                }
              : variable),
          }
        : component),
    }
    const invalidLinkTagId = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'turbine-stop-valve-to-turbine'
        ? {
            ...connection,
            variables: connection.variables.map(variable => variable.path === 'flowKgPerS'
              ? { ...variable, tagId: 'PT-455' }
              : variable),
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalidComponentTagId, processPlantComponentRegistry)).toThrow('duplicate process signal tag id: PT-455')
    expect(() => compilePlantGraph(invalidLinkTagId, processPlantComponentRegistry)).toThrow('duplicate process signal tag id: PT-455')
  })

  test('rejects component signal metadata for unknown local variable paths', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      components: pressurizedWaterReactorPlantSpec.components.map(component => component.id === 'pressurizer'
        ? {
            ...component,
            variables: [
              ...component.variables,
              {
                path: 'notARealVariable',
                tagId: 'BAD-TAG',
              },
            ],
          }
        : component),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('component pressurizer variable metadata references unknown local variable')
  })

  test('rejects process signal tags that are not visible to operators, AI, or procedures', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      components: pressurizedWaterReactorPlantSpec.components.map(component => component.id === 'pressurizer'
        ? {
            ...component,
            variables: component.variables.map(variable => variable.path === 'pressureMPa'
              ? {
                  ...variable,
                  tagId: 'HIDDEN-TAG',
                  capabilities: {
                    aiVisible: false,
                    procedureRelevant: false,
                    operatorFacing: false,
                  },
                }
              : variable),
          }
        : component),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('is not visible to AI, procedures, or operators')
  })

  test('rejects link initial values that do not match quantity type', () => {
    const numericResult = processLinkVariableDescriptorSchema.safeParse({
      path: 'flowKgPerS',
      label: 'Main steam flow',
      kind: 'derived',
      discipline: 'hydraulic',
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
      discipline: 'control',
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
      path: 'leak.areaFraction',
      label: 'Leak area',
      kind: 'control',
      discipline: 'control',
      writable: true,
      publish: 'telemetry',
      quantity: 'ratio',
      unit: 'fraction',
      initialValue: 1.5,
      tagId: 'LEAK-A',
    })
    const invalidFlow = processLinkVariableDescriptorSchema.safeParse({
      path: 'flowKgPerS',
      label: 'Main steam flow',
      kind: 'derived',
      discipline: 'hydraulic',
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
                discipline: 'hydraulic',
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

  test('rejects inline link valve position variables in favor of valve components', () => {
    const invalid = {
      ...pressurizedWaterReactorPlantSpec,
      connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === 'sg-a-steam-to-msiv-a'
        ? {
            ...connection,
            variables: [
              ...connection.variables,
              {
                path: 'valve.positionFraction',
                label: 'Inline valve position',
                kind: 'control',
                discipline: 'control',
                writable: true,
                publish: 'telemetry',
                quantity: 'ratio',
                unit: 'fraction',
                initialValue: 1,
              },
            ],
          }
        : connection),
    }

    expect(() => compilePlantGraph(invalid, processPlantComponentRegistry)).toThrow('fluid connection sg-a-steam-to-msiv-a with solverModel compressibleSteam cannot declare unsupported variable valve.positionFraction')
  })

  test('generates Mermaid documentation from compiled topology', () => {
    const compiled = compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)
    const mermaid = plantGraphToMermaid(compiled, { highlightedComponentIds: ['core', 'sgA'] as never })

    expect(mermaid).toContain('flowchart TB')
    expect(mermaid).toContain('Reactor Core')
    expect(mermaid).toContain('primaryCoolant')
    expect(mermaid).toContain('mainSteam')
    expect(mermaid).toContain('fluidFlow')
    expect(mermaid).toContain('classDef overview')
    expect(mermaid).toContain('class c0,c5 overview')
  })
})
