import type { ProcedureTag } from '../src/core/model/index.ts'
import { unrestrictedQueryReadPolicy } from '../src/simulation/query-read-policy.ts'
import { describe, expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantProtectionRunner, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { processPlantAutomationDigest } from '../src/packs/process-plant/evidence-frame.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { createProcedureObservationPort, parseProcedureTagValue, parseProcedureTagValidations, readProcedureTags } from '../src/features/procedures/pack-observations.ts'
import { assessProcedureBranches } from '../src/features/procedures/branch-assessment.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { procedureTestSource } from './procedure-fixtures.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const instance = (id: string): ProcessPlantRuntimeInstance & { readonly step: (seconds: number) => void } => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id, loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
  return { plant: compiled, runtime, protection, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance(),
    step: (seconds: number) => { for (let index = 0; index < seconds; index++) { runtime.tick(1000); protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run:status' as never, sourceRuntimeId: 'process-plant.local' as never }) } } } as never
}
const query = (plant: ProcessPlantRuntimeInstance, capabilityId: string, input: Record<string, unknown>) => answerProcessPlantQuery({
  request: { capabilityId, input, readPolicy: unrestrictedQueryReadPolicy }, plants: new Map([[plant.plant.id, plant]]) } as never) as Record<string, never>
const tag = (id: string, units: string) => ({ id, units })
const read = (plant: ProcessPlantRuntimeInstance, id: string, units: string) => parseProcedureTagValue(tag(id, units) as never, query(plant, 'world.process-plant.signals.read', { plantId: plant.plant.id, signals: [{ tagId: id, requestedUnit: units }] }))

describe('read-only status signals', () => {
  test('SI-ACTUATED reads the existing rule state: false on a healthy plant, true from actuation, latched afterwards, and never writable', () => {
    const plant = instance('plant:status-si')
    const manual = String(resolveProcessPlantSignalBinding(plant.plant.graph, { tagId: 'SI-MAN' as never }).path)
    plant.step(5)
    expect(read(plant, 'SI-ACTUATED', 'boolean')).toMatchObject({ value: false, unit: 'boolean', writable: false, quality: 'good', signalTagId: 'SI-ACTUATED', conversionStatus: 'native' })
    plant.runtime.writeCommand({ type: 'setVariable', path: manual as never, value: true })
    plant.step(1)
    const rules = () => plant.protection!.snapshot().rules.filter(rule => rule.ruleId.startsWith('safety-injection-'))
    expect(rules().some(rule => rule.active || rule.latched)).toBe(true)
    expect(read(plant, 'SI-ACTUATED', 'boolean').value).toBe(true)
    plant.step(60)
    expect(rules().some(rule => rule.active)).toBe(false)
    expect(read(plant, 'SI-ACTUATED', 'boolean').value).toBe(true)
  })

  test('with no protection runner it is unavailable, not false', () => {
    const plant = instance('plant:status-no-ic')
    const { protection: _protection, ...without } = plant
    expect(read(without as ProcessPlantRuntimeInstance, 'SI-ACTUATED', 'boolean')).toMatchObject({ quality: 'unavailable' })
  })

  test('a cold-leg row is the existing flow variable under the row\'s tag', () => {
    const plant = instance('plant:status-cold-leg')
    const path = 'safety-injection-header-to-cold-leg-c.flowKgPerS'
    plant.step(1)
    expect(read(plant, 'SI-CL-C-FLOW', 'kg/s')).toMatchObject({ value: plant.runtime.readVariable(path as never), unit: 'kg/s', writable: false, path, signalTagId: 'SI-CL-C-FLOW', quality: 'good' })
  })

  test('tag validation resolves the table, and a model without what a row reads reports it missing', () => {
    const plant = instance('plant:status-validate')
    const validations = parseProcedureTagValidations(query(plant, 'world.process-plant.procedure-tags.validate', { plantId: plant.plant.id, tags: [tag('SI-ACTUATED', 'boolean'), tag('SI-CL-A-FLOW', 'kg/s'), tag('NOT-A-TAG', 'kg/s')] }))
    expect(validations.get('SI-ACTUATED')).toMatchObject({ status: 'resolved', warnings: [] })
    expect(validations.get('SI-CL-A-FLOW')).toMatchObject({ status: 'resolved', warnings: [] })
    expect(validations.get('NOT-A-TAG')).toMatchObject({ status: 'missing' })
    const two = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:status-two-loop', loopCount: 2 }))
    const runtime = createProcessPlantRuntime({ system: two })
    const small = { plant: two, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() } as ProcessPlantRuntimeInstance
    expect(parseProcedureTagValidations(query(small, 'world.process-plant.procedure-tags.validate', { plantId: two.id, tags: [tag('SI-CL-D-FLOW', 'kg/s')] })).get('SI-CL-D-FLOW')).toMatchObject({ status: 'missing' })
  })

  test('compiled limits on these tags pass the evaluator\'s whole guard chain', async () => {
    const plant = instance('plant:status-limits')
    const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'p/T.md', sourceUrl: '/wiki?path=p%2FT.md', rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: T
title: T
ai-workable: true
---

## Step 1 [id: s] Is SI actuated

Basis: [Why](basis.md#si).
Pair: [id: question]
Check: Is SI actuated? «SI-ACTUATED» «SI-CL-A-FLOW»

- Actuated, with flow «SI-ACTUATED == true» «SI-CL-A-FLOW > 0» [outcome: normal] → END
- Not actuated «SI-ACTUATED == false» [outcome: normal] → END

## Tags

- id: SI-ACTUATED
  units: boolean
  states: ACTUATED/NOT ACTUATED
- id: SI-CL-A-FLOW
  units: kg/s
` })
    const step = document.steps[0]!
    const simulationTime = '2026-11-08T08:00:00.000Z' as never
    const port = createProcedureObservationPort({ scopeId: plant.plant.id, provider: {
      signalReadQuery: (plantId: string, tags: ReadonlyArray<ProcedureTag>) => ({ capabilityId: 'world.process-plant.signals.read', input: { plantId, evidence: true, signals: tags.map(item => ({ tagId: item.id, requestedUnit: item.units })) } }),
      tagValidationQuery: (plantId: string, tags: ReadonlyArray<ProcedureTag>) => ({ capabilityId: 'world.process-plant.procedure-tags.validate', input: { plantId, tags: tags.map(item => ({ id: item.id, units: item.units })) } }),
    } as never, query: async ({ capabilityId, input }) => answerProcessPlantQuery({ request: { capabilityId, input, readPolicy: unrestrictedQueryReadPolicy }, plants: new Map([[plant.plant.id, plant]]), simulationTime } as never) })
    const statuses = async () => assessProcedureBranches({ step, plantId: plant.plant.id, simulationTime, reads: await readProcedureTags({ observations: () => port, declared: document.tags, tagIds: step.tagIds }) }).map(item => [item.status, item.reasons.join(' ')])
    plant.step(5)
    expect(await statuses()).toEqual([['contradicted', ''], ['supported', '']])
    plant.runtime.writeCommand({ type: 'setVariable', path: String(resolveProcessPlantSignalBinding(plant.plant.graph, { tagId: 'SI-MAN' as never }).path) as never, value: true })
    plant.step(30)
    expect((await statuses())[1]).toEqual(['contradicted', ''])
  })

  test('the table moves neither digest', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:status-digests', loopCount: 4 }))
    expect(plant.modelDigest.startsWith('b7d6924f768f')).toBe(true)
    expect(processPlantAutomationDigest(plant.automation).startsWith('9ba96655f569')).toBe(true)
  })
})
