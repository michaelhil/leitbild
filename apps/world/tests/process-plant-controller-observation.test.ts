import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { operatorControllerBindings } from '../src/packs/process-plant/graph/valve-controller.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { answerProcessPlantObservationQuery, processPlantObservationCapabilityIds } from '../src/packs/process-plant/observation/query.ts'
import { answerProcessPlantQuery } from '../src/packs/process-plant/query.ts'
import { evaluateProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'
import { createProcessPlantRuntimeInstances } from '../src/packs/process-plant/sim/runtime-instance-factory.ts'
import type { IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

describe('operator-controller configuration is published without being physical evidence', () => {
  test('every selected controller publishes its exact native command bindings across loop counts', () => {
    for (const loopCount of [2, 4, 6]) {
      const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controller-observation', loopCount }))
      const declaration = plantDeclaration(plant.id as ObjectId, plant, null)
      const paths = plant.graph.components.flatMap(component => {
        const bindings = operatorControllerBindings(component)
        return bindings === null ? [] : [bindings.automatic, bindings.setpoint]
      })
      expect(paths).toHaveLength(2 * (2 * loopCount + 1))
      for (const path of paths) {
        const binding = plant.graph.signalBindingByPath.get(path)!
        expect(binding.published).toBe(true)
        expect(binding.writable).toBe(true)
        expect(binding.actuation).toBe('command')
        expect(binding.description).toContain('configuration, not physical response')
        expect(declaration.observables.find(entry => entry.ref === `${plant.id}#${path}`)).toMatchObject({ basis: 'command', element: binding.equipmentId, tag: binding.tagId })
      }
    }
  })

  test('ordinary signal and World observation reads retain live configuration and never write or qualify it', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controller-read', loopCount: 4 }))
    const plants = createProcessPlantRuntimeInstances({ compiledPlants: [plant], runtimeState: null })
    const instance = plants.get(plant.id)!
    const paths = ['turbineBypassValve.controllerAutomatic', 'turbineBypassValve.controllerSetpoint', 'feedwaterControlValveA.controllerSetpoint']
    const before = instance.runtime.checkpoint()
    const signals: any = answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.signals.read', input: { plantId: plant.id, signals: paths.map(path => ({ path })) } }, plants, objects: new Map() })
    expect(signals.signals.map((row: any) => row.variable.value)).toEqual([true, 7.6, 55])
    expect(signals.signals.every((row: any) => row.signal.writable && row.signal.published)).toBe(true)
    const observations: any = answerProcessPlantObservationQuery({ request: { capabilityId: processPlantObservationCapabilityIds.read, input: { refs: paths.map(path => `${plant.id}#${path}`) } }, plants,
      simulationTime: '2026-10-29T00:00:00.000Z' as IsoTimestamp, recording: { seriesIds: new Set(), intervalMs: 1_000 } })
    expect(observations.unknown).toEqual([])
    expect(observations.observations.map((row: any) => row.value)).toEqual([true, 7.6, 55])
    const judgement = evaluateProcessPlantProcedureCondition({ plant: instance,
      condition: { type: 'comparison', signal: { path: paths[1] as never }, operator: '==', value: 7.6, unit: 'MPa' },
      basis: { modelRef: plant.modelRef, modelDigest: plant.modelDigest, source: 'test/configuration-boundary', description: 'A requested setting is not achieved physical response.' } })
    expect(judgement).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('Writable commands/demands') }] })
    expect(instance.runtime.checkpoint()).toEqual(before)
  })
})
