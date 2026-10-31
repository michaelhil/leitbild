import { expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRampRunner } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntime } from '../src/packs/process-plant/runtime/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'

test('a refused control-item guess supplies canonical identities without accepting it or dumping every control', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:control-discovery', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const instance: ProcessPlantRuntimeInstance = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
  const capability = processPlantCapabilities.find(row => row.id === 'world.process-plant.controls.list')!
  const read = (input: Record<string, unknown>) => answerProcessPlantQuery({
    request: { capabilityId: capability.id, input: capability.input.parse(input) }, plants: new Map([[plant.id, instance]]), objects: new Map(),
  })
  const time = runtime.elapsedMs()
  let refusal: Error & { code?: string; status?: number } | undefined
  try { read({ plantId: plant.id, items: ['manualReactorTrip'] }) } catch (error) {
    if (!(error instanceof Error)) throw error
    refusal = error
  }
  expect(refusal).toBeDefined()
  expect(refusal!.code).toBe('capability_target_not_found')
  expect(refusal!.status).toBe(404)
  const marker = 'declared control-item identities: '
  const identities = JSON.parse(refusal!.message.slice(refusal!.message.indexOf(marker) + marker.length)) as Array<{ id: string; label: string }>
  expect(identities.some(row => row.id === 'core' && row.label === 'Core')).toBe(true)
  expect(identities.every(row => Object.keys(row).sort().join(',') === 'id,label')).toBe(true)
  const selected = capability.output.parse(read({ plantId: plant.id, items: [identities.find(row => row.id === 'core')!.id] })) as { items: Array<{ id: string }> }
  expect(selected.items).toHaveLength(1)
  expect(selected.items[0]!.id).toBe('core')
  expect(JSON.stringify(selected)).toContain('RX-TRIP-MAN')
  expect(runtime.elapsedMs()).toBe(time)
  expect(() => read({ plantId: plant.id, items: ['manualReactorTrip'] })).toThrow('has no item manualReactorTrip')
})
