import { expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { answerProcessPlantQuery, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, createProcessPlantRampRunner } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { capabilityJsonSchema } from '../src/simulation/capabilities.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

test('compact search preserves selection and meaning, with exact full metadata and live-read drilldown', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:discovery' }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const plants = new Map([[plant.id, { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }]])
  const query = (capabilityId: string, input: Record<string, unknown>): any => {
    const result = answerProcessPlantQuery({ request: { capabilityId, input: { plantId: plant.id, ...input } }, plants, objects: new Map() })
    expect(processPlantCapabilities.find(capability => capability.id === capabilityId)!.output.parse(result)).toEqual(result)
    return result
  }
  const search = (input: Record<string, unknown> = {}) => query('world.process-plant.signals.search', input)
  expect(processPlantCapabilities.find(capability => capability.id === 'world.process-plant.signals.search')!.description).toContain('literal AND terms')
  // "total" is not advertised by the header-flow signal: a narrower literal
  // query can miss evidence that broader names and structural filters offer.
  expect(search({ text: 'auxiliary feedwater total flow' }).total).toBe(0)
  const headerFlow = search({ text: 'auxiliary feedwater', equipmentId: 'auxFeedwaterHeader', quantity: 'flowRate' })
  expect(headerFlow.signals.map((row: any) => row.signal.tagId)).toContain('AFW-FLOW')
  expect(query('world.process-plant.signals.read', { signals: [{ tagId: 'AFW-FLOW' }] }).signals[0].variable.value).toBeNumber()
  const summary = search()
  const full = search({ detail: 'full' })
  expect(summary).toMatchObject({ total: full.total, offset: full.offset, returned: full.returned, hasMore: full.hasMore })
  expect(summary.signals).toEqual(full.signals.map(({ plantId, signal }: any) => {
    const { capabilities, limits, owner, externalRefs, ...rest } = signal
    return { plantId, signal: rest }
  }))
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary))
  const fullBytes = Buffer.byteLength(JSON.stringify(full))
  console.info(`signal search default page: summary ${summaryBytes} bytes; full ${fullBytes} bytes`)
  expect(summaryBytes).toBeLessThan(fullBytes * 0.8)
  // Hidden metadata must remain searchable/filterable, not removed before matching.
  for (const filter of [{ text: 'RCP running' }, { procedureRelevant: true }, { writable: true }, { offset: 100, limit: 2 }]) {
    const compactPage = search(filter)
    const fullPage = search({ ...filter, detail: 'full' })
    expect(compactPage.signals.map((row: any) => row.signal.path)).toEqual(fullPage.signals.map((row: any) => row.signal.path))
  }
  const references = summary.signals.slice(0, 3).map((row: any) => ({ path: row.signal.path }))
  const resolved = query('world.process-plant.signals.resolve', { signals: references })
  const live = query('world.process-plant.signals.read', { signals: references })
  expect(resolved.signals).toEqual(full.signals.slice(0, 3).map((row: any) => row.signal))
  expect(live.signals.map((row: any) => row.signal)).toEqual(resolved.signals)
  expect(live.signals.every((row: any) => row.variable.value !== undefined && row.quality.status)).toBe(true)
})

test('discovered signal reference contracts explain exclusive Plant-local identities and keep runtime validation exact', () => {
  for (const id of ['world.process-plant.signals.read', 'world.process-plant.signals.resolve']) {
    const capability = processPlantCapabilities.find(entry => entry.id === id)!
    const wire = capabilityJsonSchema(capability.input) as { properties: { signals: { items: { properties: { path: { description: string }; tagId: { description: string } } } } } }
    const fields = wire.properties.signals.items.properties
    expect(fields.path.description).toContain('Exactly one of path or tagId')
    expect(fields.path.description).toContain('Plant-local dotted path')
    expect(fields.tagId.description).toContain('Exactly one of tagId or path')
    expect(fields.tagId.description).toContain('never substitute a variable path or a global objectId#path')
    expect(capability.input.safeParse({ plantId: 'plant:one', signals: [{ tagId: 'GEN-MW' }] }).success).toBe(true)
    expect(capability.input.safeParse({ plantId: 'plant:one', signals: [{ path: 'turbine.electricMw' }] }).success).toBe(true)
    for (const signal of [{}, { path: 'turbine.electricMw', tagId: 'GEN-MW' }, { path: 'plant:one#turbine.electricMw' }, { tagId: 'plant:one#turbine.electricMw' }]) {
      expect(capability.input.safeParse({ plantId: 'plant:one', signals: [signal] }).success).toBe(false)
    }
  }
})


test('advertised signal-reference XOR matches Zod through extension and every shared capability use', () => {
  const ajv = new Ajv2020({ allErrors: true })
  for (const id of ['world.process-plant.signals.read', 'world.process-plant.signals.resolve']) {
    const capability = processPlantCapabilities.find(entry => entry.id === id)!
    const schema = capabilityJsonSchema(capability.input)
    const validate = ajv.compile(schema)
    const item = (schema.properties as { signals: { items: { oneOf?: unknown; properties: Record<string, unknown> } } }).signals.items
    expect(item.oneOf).toEqual([{ required: ['path'] }, { required: ['tagId'] }])
    expect(item.properties.path).toHaveProperty('description')
    expect(item.properties.tagId).toHaveProperty('description')
    const examples = [
      [{ tagId: 'GEN-MW' }, true], [{ path: 'turbine.electricMw' }, true], [{ tagId: 'TAG.WITH.DOTS' }, true],
      [{}, false], [{ path: 'turbine.electricMw', tagId: 'GEN-MW' }, false],
      [{ path: 'plant:one#turbine.electricMw' }, false], [{ tagId: 'plant:one#turbine.electricMw' }, false],
      [{ path: null }, false], [{ tagId: 7 }, false], [{ tagId: 'GEN-MW', unexpected: true }, false],
      [{ path: 'turbine.electricMw', requestedUnit: 'MW' }, id.endsWith('.read')],
    ] as const
    for (const [signal, accepted] of examples) {
      const input = { plantId: 'plant:one', signals: [signal] }
      expect(capability.input.safeParse(input).success).toBe(accepted)
      expect(validate(input)).toBe(accepted)
    }
  }
  // These capabilities reuse the base object directly; read above uses its
  // safeExtend requestedUnit form. None may lose the shared standard rule.
  const refs = processPlantCapabilities.filter(capability => ['world.process-plant.conditions.evaluate', 'world.process-plant.controls.list', 'world.process-plant.response.evaluate'].includes(capability.id))
  expect(refs).toHaveLength(3)
  for (const capability of refs) expect(JSON.stringify(capabilityJsonSchema(capability.input))).toContain('"oneOf":[{"required":["path"]},{"required":["tagId"]}]')
})
