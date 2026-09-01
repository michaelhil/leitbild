import { describe, expect, test } from 'bun:test'
import type {
  ActorId,
  CommandEnvelope,
  CommandId,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  PackRuntimeRecordingBatch,
  PackId,
  SimulationRunId,
} from '../src/core/model/index.ts'
import type { PackQueryRequest } from '../src/core/packs/protocol.ts'
import type { PackRuntimeStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantPackRuntimeAdapter,
  processPlantControlRampCommandKind,
  processPlantControlWriteCommandKind,
  processPlantPwrReferenceModelRef,
  processPlantUnitPackDataSchema,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from '../src/scenarios/index.ts'

const simulationRunId = 'run:process-plant-test' as SimulationRunId
const issuedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
const builtIn = scenarios.find(scenario => scenario.id === 'halden-process-plant-demo')
if (builtIn === undefined) throw new Error('Halden Process Plant scenario is required by runtime tests')
const basePlant = builtIn.initialObjects.find(object => object.packId === 'process-plant')
if (basePlant === undefined) throw new Error('Halden Process Plant scenario has no Plant')

const createMemoryStateStore = (): PackRuntimeStateStore => {
  let state: unknown | null = null
  return {
    load: async () => state,
    save: async next => { state = structuredClone(next) },
  }
}

const scenarioWithPlants = (plants: ReadonlyArray<OperationalObject> = [basePlant]) => ({
  scenarioId: builtIn.id,
  runtimeIds: ['process-plant.local'],
  world: builtIn.world,
  initialObjects: plants,
  runtimeConfig: {},
})

const query = (kind: string, payload: unknown = {}): PackQueryRequest => ({
  packId: 'process-plant' as PackId,
  kind,
  payload,
})

const command = (kind: string, payload: unknown): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId,
  actorId: 'actor:operator' as ActorId,
  kind,
  targetObjectIds: [],
  payload,
  issuedAt,
})

describe('process plant Pack runtime lifecycle', () => {
  test('discovers Plants from Operational Objects and projects live status', async () => {
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
    })
    try {
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects.map(object => object.id)).toEqual([basePlant.id])
      const data = processPlantUnitPackDataSchema.parse(snapshot.objects[0]?.packData)
      expect(data.model.ref).toBe(processPlantPwrReferenceModelRef)
      expect(data.projection?.fields.map(field => field.key)).toContain('thermal-power')

      const read = await connection.query(query('process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['core.totalThermalPowerMw', 'pressurizer.pressureMPa'],
      }))
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error(read.reason)
      expect((read.result as { variables: ReadonlyArray<unknown> }).variables).toHaveLength(2)
    } finally {
      await connection.close()
    }
  })

  test('keeps commands isolated by Plant identity', async () => {
    const secondPlant: OperationalObject = {
      ...structuredClone(basePlant),
      id: 'plant:test-second' as ObjectId,
      label: 'Second test Plant',
      provenance: { ...basePlant.provenance, externalId: 'plant:test-second' },
    }
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants([basePlant, secondPlant]),
      runtimeStateStore: createMemoryStateStore(),
    })
    try {
      const accepted = await connection.sendCommand(command(processPlantControlWriteCommandKind, {
        plantId: basePlant.id,
        path: 'rcpA.running',
        value: false,
      }))
      expect(accepted.ok).toBe(true)
      await Bun.sleep(1_100)

      const first = await connection.query(query('process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['rcpA.running'],
      }))
      const second = await connection.query(query('process-plant.variables.read', {
        plantId: secondPlant.id,
        paths: ['rcpA.running'],
      }))
      if (!first.ok || !second.ok) throw new Error('Plant variable query failed')
      expect((first.result as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(false)
      expect((second.result as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('persists queued commands and restores them against the same model', async () => {
    const stateStore = createMemoryStateStore()
    const first = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: stateStore,
    })
    expect((await first.sendCommand(command(processPlantControlWriteCommandKind, {
      plantId: basePlant.id,
      path: 'rcpA.running',
      value: false,
    }))).ok).toBe(true)
    await first.close()

    const restored = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: stateStore,
    })
    try {
      await Bun.sleep(1_100)
      const read = await restored.query(query('process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['rcpA.running'],
      }))
      if (!read.ok) throw new Error(read.reason)
      expect((read.result as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(false)
    } finally {
      await restored.close()
    }
  })

  test('applies typed ramps and exposes displays and automation through discovery', async () => {
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
    })
    try {
      expect((await connection.sendCommand(command(processPlantControlRampCommandKind, {
        plantId: basePlant.id,
        path: 'turbine.loadFraction',
        targetValue: 0.5,
        durationSeconds: 1,
      }))).ok).toBe(true)
      await Bun.sleep(1_100)

      const read = await connection.query(query('process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['turbine.loadFraction'],
      }))
      if (!read.ok) throw new Error(read.reason)
      expect((read.result as { variables: ReadonlyArray<{ value: number }> }).variables[0]?.value).toBeCloseTo(0.5, 2)

      const displays = await connection.query(query('process-plant.displays.list', { plantId: basePlant.id }))
      if (!displays.ok) throw new Error(displays.reason)
      expect((displays.result as { displays: ReadonlyArray<{ id: string }> }).displays).toContainEqual(expect.objectContaining({ id: 'unit-overview' }))

      const automation = await connection.query(query('process-plant.ic.catalog', { plantId: basePlant.id }))
      if (!automation.ok) throw new Error(automation.reason)
      expect((automation.result as { ic: { rules: ReadonlyArray<unknown> } }).ic.rules.length).toBeGreaterThan(0)

      const catalog = await connection.query(query('process-plant.catalog.list'))
      if (!catalog.ok) throw new Error(catalog.reason)
      expect(catalog.result).toMatchObject({ models: [{ id: processPlantPwrReferenceModelRef }] })
    } finally {
      await connection.close()
    }
  })

  test('emits only the selected recording profile with discoverable series metadata', async () => {
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
      recording: { packId: 'process-plant', profileId: 'operations', intervalMs: 250 },
    })
    try {
      const batch = await new Promise<PackRuntimeRecordingBatch>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('recording emission timed out')), 2_500)
        connection.subscribe(emission => {
          if (!emission.recording) return
          clearTimeout(timeout)
          resolve(emission.recording)
        })
      })
      expect(batch.descriptors.length).toBeGreaterThan(0)
      expect(batch.samples).toHaveLength(batch.descriptors.length)
      expect(batch.descriptors.every(descriptor => descriptor.subjectId === basePlant.id)).toBe(true)
      expect(batch.descriptors.map(descriptor => descriptor.signalId)).toContain('core.totalThermalPowerMw')
    } finally {
      await connection.close()
    }
  })

  test('rejects unknown model refs before starting a Run', async () => {
    const data = processPlantUnitPackDataSchema.parse(basePlant.packData)
    const invalid: OperationalObject = {
      ...structuredClone(basePlant),
      packData: { ...data, model: { ...data.model, ref: 'process-plant.unknown' } },
    }
    await expect(createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants([invalid]),
      runtimeStateStore: createMemoryStateStore(),
    })).rejects.toThrow('unknown process plant model')
  })
})
