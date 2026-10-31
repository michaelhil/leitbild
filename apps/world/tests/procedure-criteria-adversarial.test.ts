import { describe, expect, test } from 'bun:test'
import type { ProcedureAssessmentCondition } from '@leitbild/procmd'
import { isoTimestampSchema, objectIdSchema } from '../src/core/model/index.ts'
import { assessProcedureBranches } from '../src/features/procedures/branch-assessment.ts'
import { createProcedureObservationPort, readProcedureTags, type ProcedureTagRead } from '../src/features/procedures/pack-observations.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { processPlantPackView } from '../src/packs/process-plant/ui-pack.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Regressions from actual E-0 trials, acquired through the real four-loop
// model and its public observation wire. These are deliberately incomplete
// reference criteria: normal-looking available readings cannot fill the gaps.
const plantId = objectIdSchema.parse('plant:e0-independent-evidence')
const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: plantId, loopCount: 4 }))
const at = isoTimestampSchema.parse('2026-10-29T04:00:00.000Z')
const owner = 'source:apps/world/src/packs/process-plant/specs/pwr-reference-template.graph.json'

const comparison = (tagId: string, value: number | boolean, operator: '<' | '>' | '==' = '==', unit?: string): ProcedureAssessmentCondition => ({
  type: 'comparison', tagId, operator, value, unit: unit ?? resolveProcessPlantSignalBinding(compiled.graph, { tagId: tagId as never }).unit,
  ...(typeof value === 'number' ? { bound: 'value' as const } : {}), evidence: 'engineering-diagnostic', source: owner, maxAgeSeconds: 0,
})
const manual = (description: string): ProcedureAssessmentCondition => ({ type: 'manual', description, tagIds: [], source: 'archive/pwr-reference-model/procedures/E-0.md' })

const documentFor = (condition: ProcedureAssessmentCondition) => {
  const tags = new Map<string, string>()
  const visit = (node: ProcedureAssessmentCondition): void => {
    if (node.type === 'comparison') tags.set(node.tagId, node.unit)
    else if (node.type === 'not' || node.type === 'held') visit(node.condition)
    else if (node.type !== 'manual') node.conditions.forEach(visit)
  }
  visit(condition)
  return parseProcedureMarkdown({
    source: { sourceId: 'independent-e0-review', label: 'Independent E-0 evidence cases', repository: 'test', ref: 'publication', path: 'procedures', revision: 'e'.repeat(40), fetchedAt: at, sourceUrl: '/wiki' },
    sourcePath: 'procedures/E-0-evidence.md', sourceUrl: '/wiki?path=procedures/E-0-evidence.md',
    rawMarkdown: `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: E-0-EVIDENCE\ntitle: Independent E-0 reference criterion\n---\n## Step 1 [id: verify]\nCheck: Establish the whole authored criterion.\n\`\`\`procedure-decisions\n${JSON.stringify([{ branchIndex: 0, condition }])}\n\`\`\`\n- Verified → END\n- Requires human judgment → END\n## Tags\n${[...tags].map(([tag, unit]) => `- id: ${tag}\n  units: ${unit}`).join('\n')}`,
  })
}

const setup = () => {
  const runtime = createProcessPlantRuntime({ system: compiled })
  const plant: ProcessPlantRuntimeInstance = { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
  const port = createProcedureObservationPort({ scopeId: plantId, provider: processPlantPackView.procedures, query: async request =>
    answerProcessPlantQuery({ request, plants: new Map([[plantId, plant]]), objects: new Map(), simulationTime: at }),
  })
  const read = async (condition: ProcedureAssessmentCondition) => {
    const document = documentFor(condition)
    const step = document.steps[0]!
    const reads = await readProcedureTags({ observations: () => port, declared: document.tags, tagIds: step.tagIds })
    const assess = (observations: ReadonlyArray<ProcedureTagRead> = reads, time = at, target = plantId) =>
      assessProcedureBranches({ step, reads: observations, simulationTime: time, plantId: target })
    return { document, reads, assess, result: assess() }
  }
  return { runtime, read }
}

describe('independent E-0 evidence acceptance', () => {
  test('a trip demand is not physical trip feedback even when it returns a valid current reading', async () => {
    const { read } = setup()
    const commanded = await read(comparison('TRIP-BKR-A', false))
    expect(commanded.reads[0]?.value?.value).toBe(true)
    expect(commanded.result[0]?.status).toBe('unknown')
    expect(commanded.result[0]?.reasons.join(' ')).toContain('command/demand')
    const feedback = await read(comparison('TRIP-BKR-A-POS', false))
    expect(feedback.reads[0]?.value?.value).toBe(true)
    expect(feedback.result[0]?.status).toBe('contradicted')
  })

  test('normal pressures cannot prove the reference no-SI branch when a required steam criterion is missing', async () => {
    const { read } = setup()
    const result = await read({ type: 'all', conditions: [comparison('PT-455', 12.7, '>'), comparison('CTMT-PR', 0.128, '<'), manual('Establish the reference low steam-line SI criterion and full actuation state.')] })
    expect(result.result[0]?.readings.filter(row => row.tagId).map(row => row.status)).toEqual(['supported', 'supported'])
    expect(result.result[0]?.status).toBe('unknown')
    expect(result.result[1]?.status).toBe('unknown') // An undeclared alternative is not a fallback.
  })

  test('a spray threshold cannot establish Phase B and available relief feedback cannot silently exclude PORV B', async () => {
    const { read } = setup()
    const phaseB = await read({ type: 'all', conditions: [comparison('CTMT-PR', 0.186, '<'), manual('Establish the reference Phase B isolation setpoint and applicability; Hi-3 spray is a different function.')] })
    expect(phaseB.result[0]?.readings[0]?.status).toBe('supported')
    expect(phaseB.result[0]?.status).toBe('unknown')
    const relief = await read({ type: 'all', conditions: [comparison('PORV-456A-POS', 0), comparison('PSV-8010-OPEN', false), manual('Establish reference PORV B and its block-valve applicability, without assuming missing means absent.')] })
    expect(relief.result[0]?.readings.filter(row => row.tagId).map(row => row.status)).toEqual(['supported', 'supported'])
    expect(relief.result[0]?.status).toBe('unknown')
  })

  test('a real current observation is tied to its plant, quality, semantics, and time rather than just its numeric value', async () => {
    const { read } = setup()
    const sample = await read(comparison('PT-455', 12.7, '>'))
    expect(sample.result[0]?.status).toBe('supported')
    expect(sample.result[0]?.readings[0]).toMatchObject({ provenance: 'runtime-model', modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, sampledAt: at })
    const observed = sample.reads[0]!
    for (const patch of [{ scopeId: 'plant:other' }, { signalTagId: 'CTMT-PR' }, { unit: 'psig' }, { conversionStatus: 'unavailable' as const }]) {
      expect(sample.assess([{ ...observed, value: { ...observed.value!, ...patch } }])[0]?.status).toBe('unknown')
    }
    for (const key of ['quality', 'writable', 'evidence'] as const) {
      const without = { ...observed.value! }
      delete without[key]
      expect(sample.assess([{ ...observed, value: without }])[0]?.status).toBe('unknown')
    }
    expect(sample.assess(sample.reads, isoTimestampSchema.parse('2026-10-29T04:00:00.001Z'))[0]?.status).toBe('unknown')
    expect(sample.assess(sample.reads, isoTimestampSchema.parse('2026-10-29T03:59:59.999Z'))[0]?.status).toBe('unknown')
    expect(sample.assess(sample.reads, at, objectIdSchema.parse('plant:other'))[0]?.status).toBe('unknown')
  })

  test('a model scalar does not establish instrument qualification, an interval bound, or continuous history', async () => {
    const { read } = setup()
    const current = comparison('PT-455', 12.7, '>')
    if (current.type !== 'comparison') throw new Error('test criterion must be a comparison')
    for (const condition of [{ ...current, evidence: 'instrument' as const }, { ...current, bound: 'lower' as const }, { type: 'held' as const, durationSeconds: 60, condition: current }]) {
      expect((await read(condition)).result[0]?.status).toBe('unknown')
    }
    expect((await read({ type: 'not', condition: manual('No observation is not proof of no fault.') })).result[0]?.status).toBe('unknown')
  })
})
