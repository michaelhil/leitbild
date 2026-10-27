import { expect, test } from 'bun:test'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { describeProcessPlantPhysicalTargets } from '../src/packs/process-plant/physical-targets.ts'
import { physicalDesignTargets } from '../src/packs/physical-layout/targets.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

test('physical Designs opt into exact owner graph connections without changing retained component-only coverage', async () => {
  const compiled = await compileScenarioDefinition({ id: 'targets-test', title: 'Connection target test', packs: [{ id: 'process-plant', config: {}, items: [{ type: 'plant', id: 'plant:targets', label: 'Targets', location: [11.47, 59.087], model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } }] }], world: { startsAt: '2026-10-27T00:00:00.000Z', environment: {} } }, [processPlantPack], { routing: createDirectRoutingAdapter() })
  const owner = compiled.initialObjects.find(object => object.id === 'plant:targets')!, description = describeProcessPlantPhysicalTargets(owner)
  expect(physicalDesignTargets(description, false)).toBe(description.subjects)
  const all = physicalDesignTargets(description, true)
  expect(all.length).toBe(description.subjects.length + description.connections!.length)
  const surge = description.connections!.find(connection => connection.id === 'pressurizer-surge-line')!
  expect(surge.from).toEqual({ subjectId: 'core', port: 'hotLegA' }); expect(surge.to).toEqual({ subjectId: 'pressurizer', port: 'surgeLine' })
  expect(surge.kind).toBe('fluidFlow')
  expect(description.subjects.some(subject => subject.id === surge.id)).toBe(false)
  expect(new Set(all.map(subject => subject.id)).size).toBe(all.length)
})
test('unsupported or ambiguous graph target identities are refused explicitly', () => {
  const data = { objectId: 'owner', modelRef: 'model', modelDigest: 'exact', subjects: [{ id: 'same', label: 'Pump' }] }
  expect(() => physicalDesignTargets(data, true)).toThrow('does not supply')
  expect(() => physicalDesignTargets({ ...data, connections: [{ id: 'same', label: 'Line', kind: 'fluidFlow', from: { subjectId: 'same', port: 'out' }, to: { subjectId: 'tank', port: 'in' } }] }, true)).toThrow('ambiguous')
})
