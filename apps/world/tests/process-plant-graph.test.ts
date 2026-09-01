import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, PackId } from '../src/core/model/index.ts'
import type { PackQueryRequest } from '../src/core/packs/protocol.ts'
import {
  answerProcessPlantQuery,
  assemblePwrReferencePlantGraph,
  assertPrimaryLoopTopologyValid,
  collectProcessPlantCatalog,
  compileProcessPlant,
  compileProcessPlants,
  compileResolvedProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantCatalog,
  processPlantDefinitionCatalog,
  processPlantPwrReferenceAutomationRef,
  processPlantPwrReferenceModelRef,
  processPlantUnitPackDataSchema,
  variablePathSchema,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from '../src/scenarios/index.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'

const at = '2026-01-01T09:00:00.000Z' as IsoTimestamp

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
  test('exposes only selectable product concepts', () => {
    const catalog = processPlantDefinitionCatalog()
    expect(catalog.models.map(entry => entry.id)).toEqual([processPlantPwrReferenceModelRef])
    expect(catalog.operatingPoints).toHaveLength(1)
    expect(catalog.automations.map(entry => entry.id)).toEqual([processPlantPwrReferenceAutomationRef])
    expect([...processPlantCatalog.displaysById.keys()]).toEqual(['unit-overview'])
    expect([...processPlantCatalog.credibilityEvidenceById.keys()]).toHaveLength(1)
  })

  test('answers catalog discovery without exposing implementation source files', () => {
    const request: PackQueryRequest = {
      packId: 'process-plant' as PackId,
      kind: 'process-plant.catalog.list',
      payload: {},
    }
    const response = answerProcessPlantQuery({ request, plants: new Map(), at })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.reason)
    expect(response.result).toMatchObject({
      models: [{ id: processPlantPwrReferenceModelRef }],
      displays: [{ id: 'unit-overview' }],
    })
    expect(JSON.stringify(response.result)).not.toContain('sourcePath')
  })

  test('validates procedure tags in one tolerant query', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:procedure-tags' }))
    const request: PackQueryRequest = {
      packId: 'process-plant' as PackId,
      kind: 'process-plant.procedure-tags.validate',
      payload: {
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
    const response = answerProcessPlantQuery({ request, plants, at })

    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.reason)
    expect(response.result).toMatchObject({
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
      'halden-four-unit-grid',
      'halden-process-plant-demo',
      'oslo-all-packs-demo',
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
