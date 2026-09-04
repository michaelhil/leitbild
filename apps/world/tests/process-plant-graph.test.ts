import { describe, expect, test } from 'bun:test'
import type { PackId } from '../src/core/model/index.ts'
import type { PackRuntimeQuery } from '../src/simulation/protocol.ts'
import {
  answerProcessPlantQuery,
  assemblePwrReferencePlantGraph,
  assertPrimaryLoopTopologyValid,
  collectProcessPlantCatalog,
  compileProcessPlant,
  compileProcessPlants,
  compileResolvedProcessPlant,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantCatalog,
  processPlantDefinitionCatalog,
  processPlantPwrReferenceAutomationRef,
  processPlantPwrReferenceModelRef,
  processPlantUnitPackDataSchema,
  variablePathSchema,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'


describe('process plant model composition', () => {
  test('builds and validates every supported PWR loop count from one model source', () => {
    for (let loopCount = 2; loopCount <= 6; loopCount += 1) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({
        id: `plant:${loopCount}`,
        loopCount,
      }))
      expect(system.modelRef).toBe(processPlantPwrReferenceModelRef)
      expect(system.automationRef).toBe(processPlantPwrReferenceAutomationRef)
      expect(system.graph.components.filter(component => component.kind === 'steamGenerator')).toHaveLength(loopCount)
      expect(system.graph.components.filter(component => component.metadata?.equipmentClass === 'reactor-coolant-pump')).toHaveLength(loopCount)
      expect(system.graph.components.filter(component => component.metadata?.loopId !== undefined)
        .every(component => typeof component.metadata?.ordinal === 'number')).toBe(true)
    }
  })

  test('applies sparse operating-point overrides without changing the shared model', () => {
    const baseline = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:baseline' }))
    const tailored = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:tailored',
      parameterOverrides: { core: { ratedPowerMw: 2_200 } },
      valueOverrides: { 'pressurizer.pressureMPa': 14.9 },
    }))

    expect(baseline.graph.components.find(component => component.id === 'core')?.parameters).not.toMatchObject({ ratedPowerMw: 2_200 })
    expect(tailored.graph.components.find(component => component.id === 'core')?.parameters).toMatchObject({ ratedPowerMw: 2_200 })
    expect(tailored.initialState).toContainEqual({ path: variablePathSchema.parse('pressurizer.pressureMPa'), value: 14.9 })
  })

  test('rejects unknown components and invalid initial values at compile time', () => {
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:bad-component',
      parameterOverrides: { missingComponent: {} },
    }))).toThrow('unknown component')
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:bad-value',
      valueOverrides: { 'core.rodInsertionFraction': 2 },
    }))).toThrow('must be between 0 and 1')
  })

  test('keeps raw graph compilation internal to model definitions', () => {
    const invalid = structuredClone(assemblePwrReferencePlantGraph({ loopCount: 4 })) as PlantGraphSpec
    invalid.connections = invalid.connections.filter(connection => connection.id !== 'rcs-hot-leg-a')
    invalid.publishedVariables = invalid.publishedVariables.filter(path => !String(path).startsWith('rcs-hot-leg-a.'))

    expect(() => compileResolvedProcessPlant({
      id: 'plant:invalid-model',
      modelRef: 'test.invalid-model',
      operatingPointRef: 'test.operating-point',
      automationRef: 'test.automation',
      graph: invalid,
      automationForGraph: () => ({ rules: [] }),
      validateGraph: assertPrimaryLoopTopologyValid,
    })).toThrow('primary loop A must have exactly one core hotLegA primaryCoolant outlet')
  })

  test('rejects duplicate Plant identities', () => {
    const definition = createPwrReferencePlantDefinition({ id: 'plant:duplicate' })
    expect(() => compileProcessPlants([definition, definition])).toThrow('duplicate process plant id')
  })
})

describe('process plant discovery', () => {
  test('describes configuration and live-data reads in searchable domain language', () => {
    const descriptions = new Map(processPlantCapabilities.map(capability => [capability.id, capability.description]))
    expect(descriptions.get('world.process-plant.artifact.read')).toContain('authored configuration')
    expect(descriptions.get('world.process-plant.variables.search')).toContain('current Plant variables')
    expect(descriptions.get('world.process-plant.signals.read')).toContain('live values')
    expect(descriptions.get('world.process-plant.transient.diagnostics')).toContain('diagnostics')
  })

  test('exposes only selectable product concepts', () => {
    const catalog = processPlantDefinitionCatalog()
    expect(catalog.models.map(entry => entry.id)).toEqual([processPlantPwrReferenceModelRef])
    expect(catalog.operatingPoints).toHaveLength(1)
    expect(catalog.automations.map(entry => entry.id)).toEqual([processPlantPwrReferenceAutomationRef])
    expect([...processPlantCatalog.displaysById.keys()]).toEqual(['unit-overview'])
    expect([...processPlantCatalog.credibilityEvidenceById.keys()]).toHaveLength(1)
  })

  test('answers catalog discovery without exposing implementation source files', () => {
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.catalog.list',
      input: {},
    }
    const response = answerProcessPlantQuery({ request, plants: new Map() })
    expect(response).toMatchObject({
      models: [{ id: processPlantPwrReferenceModelRef }],
      displays: [{ id: 'unit-overview' }],
    })
    expect(JSON.stringify(response)).not.toContain('sourcePath')
  })

  test('links Plant specification components to their behavior and calculation source', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:source-inspection' }))
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.artifact.read',
      input: { plantId: plant.id, artifact: 'authored-spec' },
    }
    const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
    const response = answerProcessPlantQuery({ request, plants })

    const result = response as {
      readonly components: ReadonlyArray<{
        readonly id: string
        readonly sourcePath: string | null
        readonly sourceLinks: ReadonlyArray<{
          readonly symbol: string
          readonly targetPath: string
          readonly targetLineIndex: number | null
        }>
      }>
      readonly sourceFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>
    }
    const core = result.components.find(component => component.id === 'core')
    expect(core?.sourcePath).toBe('src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts')
    const kineticsLink = core?.sourceLinks.find(link => link.symbol === 'reactorKineticsPowerStep')
    expect(kineticsLink).toMatchObject({
      targetPath: 'src/packs/process-plant/runtime/physics.ts',
    })
    expect(kineticsLink?.targetLineIndex).toBeGreaterThanOrEqual(0)
    expect(result.sourceFiles.find(file => file.path === core?.sourcePath)?.content)
      .toContain('reactorKineticsPowerStep')
    expect(result.sourceFiles.find(file => file.path === kineticsLink?.targetPath)?.content)
      .toContain('export const reactorKineticsPowerStep')
    expect(new Set(result.sourceFiles.map(file => file.path)).size).toBe(result.sourceFiles.length)
  })

  test('validates procedure tags in one tolerant query', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:procedure-tags' }))
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.procedure-tags.validate',
      input: {
        plantId: plant.id,
        tags: [
          {
            id: 'PT-455',
            simPath: 'rcs.pressurizer.pressure_wr',
            units: 'psig',
            equipment: 'pressurizer',
          },
          {
            id: 'NIS-PR-AVG',
            simPath: 'nis.power_range.avg',
            units: 'percent',
            equipment: 'nuclear-instrumentation',
          },
          {
            id: 'SI-SIG',
            simPath: 'ess.si.actuation_signal',
            units: 'bool',
            equipment: 'si-system',
          },
        ],
      },
    }
    const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
    const response = answerProcessPlantQuery({ request, plants })

    expect(response).toMatchObject({
      plantId: plant.id,
      tags: [
        {
          id: 'PT-455',
          status: 'resolved-with-warnings',
          warnings: ['sim-path rcs.pressurizer.pressure_wr does not match process path pressurizer.pressureMPa'],
        },
        { id: 'NIS-PR-AVG', status: 'resolved', warnings: [] },
        { id: 'SI-SIG', status: 'missing', warnings: [] },
      ],
    })
  })

  test('paginates variable and signal discovery without losing Plant identity', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:paged-discovery' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const plants = new Map([[plant.id, {
      plant,
      runtime,
      ramps: createProcessPlantRampRunner({ runtime }),
      performance: createProcessPlantRuntimePerformance(),
    }]])

    const variables = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.variables.search', input: { plantId: plant.id, offset: 1, limit: 2 } },
      plants,
    }) as { total: number; offset: number; returned: number; hasMore: boolean; variables: ReadonlyArray<{ plantId: string; variable: unknown }> }
    expect(variables).toMatchObject({ offset: 1, returned: 2, hasMore: true })
    expect(variables.total).toBeGreaterThan(3)
    expect(variables.variables).toHaveLength(2)
    expect(variables.variables.every(entry => entry.plantId === plant.id)).toBe(true)

    const signals = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.signals.search', input: { plantId: plant.id, offset: 0, limit: 2 } },
      plants,
    }) as { total: number; returned: number; hasMore: boolean; signals: ReadonlyArray<{ plantId: string; signal: unknown }> }
    expect(signals).toMatchObject({ returned: 2, hasMore: true })
    expect(signals.total).toBeGreaterThan(2)
    expect(signals.signals.every(entry => entry.plantId === plant.id)).toBe(true)
  })

  test('rejects duplicate display contributions', () => {
    const existing = processPlantCatalog.displaysById.get('unit-overview')
    if (existing === undefined) throw new Error('unit overview display is required')
    const display = { ...existing, id: 'overview' }
    expect(() => collectProcessPlantCatalog([
      { id: 'one', displays: [display] },
      { id: 'two', displays: [display] },
    ])).toThrow('duplicate display id')
  })
})

describe('built-in process plant scenarios', () => {
  test('compile Plants directly from Scenario Items with no Pack configuration shadow', () => {
    const builtIns = scenarios.filter(scenario => scenario.packs.includes('process-plant' as PackId))
    expect(builtIns.map(scenario => scenario.id).sort()).toEqual([
      'halden-power-complex',
      'test-plant',
    ])

    for (const scenario of builtIns) {
      expect(scenario.packConfigs['process-plant']).toEqual({})
      const plants = scenario.initialObjects.filter(object => object.packId === 'process-plant')
      expect(plants.length).toBeGreaterThan(0)
      for (const plant of plants) {
        const data = processPlantUnitPackDataSchema.parse(plant.packData)
        expect(data.type).toBe('process-plant')
        expect(data.model.ref).toBe(processPlantPwrReferenceModelRef)
        expect(data.automation.ref).toBe(processPlantPwrReferenceAutomationRef)
        expect('plantId' in data).toBe(false)
      }
    }
  })
})
