import { expect, test } from 'bun:test'
import { assessmentLeaves, parseProcedureAssessment, parseProcedure, validateProcedurePublication } from './index.ts'

const comparison = { type: 'comparison', tagId: 'LD01.SG.A.NR1', operator: '>=', value: 1.1, unit: 'm', bound: 'lower', evidence: 'instrument', source: '../systems/secondary.md#level', maxAgeSeconds: 2 } as const
const procedure = (assessment: unknown) => `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: LD-TEST\ntitle: Evidence test\nruntime-bindings: uninstalled\n---\n## Step 1 [id: verify]\nCheck: Verify indicated level\n\`\`\`procedure-assessment\n${JSON.stringify(assessment)}\n\`\`\`\n- Done → END\n## Tags\n- id: LD01.SG.A.NR1\n  units: m\n- id: LD01.SG.B.NR1\n  units: m`

test('assessment preserves exact acquired-bound operands, held duration, vote channels and manual judgment without live execution', () => {
  const authored = { condition: { type: 'all', conditions: [
    { type: 'held', durationSeconds: 60, condition: { type: 'vote', required: 2, conditions: [comparison, { ...comparison, tagId: 'LD01.SG.B.NR1' }] } },
    { type: 'manual', description: 'Establish physically available receiving capacity; instrument levels alone do not establish it.', tagIds: ['LD01.SG.A.NR1'], source: '../systems/secondary.md#receiver' },
  ] } } as const
  const parsed = parseProcedure(procedure(authored))
  expect(parsed.steps[0]!.assessment).toEqual(authored)
  expect(parsed.steps[0]!.observation).toBeUndefined()
  expect(parsed.steps[0]!.tagIds).toEqual(['LD01.SG.A.NR1', 'LD01.SG.B.NR1'])
  expect(parsed.steps[0]!.blocks.map(block => block.text).join('')).not.toContain('maxAgeSeconds')
  expect(parsed.description).not.toContain('maxAgeSeconds')
  expect(assessmentLeaves(parsed.steps[0]!.assessment!.condition)).toHaveLength(3)
  const owners: string[] = []
  expect(() => validateProcedurePublication([{ path: 'procedures/test.md', content: procedure(authored) }], (_path, href) => { owners.push(href) })).not.toThrow()
  expect(owners).toEqual([comparison.source, comparison.source, '../systems/secondary.md#receiver'])
})

test('invalid operands, uncertainty selectors, stale-evidence budgets and temporal requirements are rejected at authoring boundary', () => {
  for (const invalid of [
    { ...comparison, operator: 'approximately' }, { ...comparison, value: 'high' }, { ...comparison, value: Infinity },
    { ...comparison, bound: undefined }, { ...comparison, bound: 'midpoint' }, { ...comparison, evidence: undefined },
    { ...comparison, maxAgeSeconds: undefined }, { ...comparison, maxAgeSeconds: -1 }, { ...comparison, maxAgeSeconds: NaN },
    { ...comparison, source: '' }, { ...comparison, tagId: 'a made up alias' },
    { ...comparison, value: true }, { ...comparison, operator: '==', value: true, bound: 'lower' },
    { type: 'held', durationSeconds: 0, condition: comparison }, { type: 'held', durationSeconds: -1, condition: comparison },
    { type: 'held', condition: comparison }, { type: 'any', conditions: [] },
    { type: 'vote', required: 3, conditions: [comparison] }, { type: 'vote', required: 1, conditions: [comparison, comparison] },
    { type: 'vote', required: 2, conditions: [comparison, { ...comparison, source: '../other.md#owner', maxAgeSeconds: 0.3 }] },
    { type: 'vote', required: 2, conditions: [comparison, { type: 'held', durationSeconds: 30, condition: { ...comparison, maxAgeSeconds: 0.3 } }] },
    { type: 'vote', required: 2, conditions: [{ type: 'not', condition: comparison }, { type: 'manual', description: 'Physical assessment', tagIds: [comparison.tagId], source: comparison.source }] },
    { type: 'manual', description: 'Judgment', source: comparison.source },
    { type: 'manual', description: '', tagIds: [], source: comparison.source },
    { ...comparison, targetObjectId: 'other-plant' },
  ]) expect(() => parseProcedureAssessment({ condition: invalid })).toThrow()
  expect(parseProcedureAssessment({ condition: { ...comparison, maxAgeSeconds: 0 } }).condition).toMatchObject({ maxAgeSeconds: 0 })
  expect(() => parseProcedureAssessment({ condition: comparison, automatic: true })).toThrow()
})

test('vote permits two bounds of one channel within one operand, but does not infer physical independence', () => {
  const bounded = { type: 'all', conditions: [comparison, { ...comparison, operator: '<=', value: 5, bound: 'upper' }] }
  expect(() => parseProcedureAssessment({ condition: { type: 'vote', required: 2, conditions: [bounded, { ...comparison, tagId: 'LD01.SG.B.NR1' }] } })).not.toThrow()
})

test('boolean acquired evidence and exact engineering diagnostics remain explicitly different', () => {
  const bool = { ...comparison, tagId: 'LD01.TRIP.A', operator: '==', value: true, unit: 'bool', bound: undefined }
  expect(parseProcedureAssessment({ condition: bool }).condition).toMatchObject({ value: true, evidence: 'instrument' })
  expect(parseProcedureAssessment({ condition: { ...comparison, evidence: 'engineering-diagnostic', bound: 'value' } }).condition).toMatchObject({ evidence: 'engineering-diagnostic', bound: 'value' })
})

test('undeclared assessment operands, unit mismatches and missing owner references fail publication', () => {
  expect(() => validateProcedurePublication([{ path: 'test.md', content: procedure({ condition: { ...comparison, tagId: 'LD01.MISSING' } }) }])).toThrow('Undeclared tag')
  expect(() => validateProcedurePublication([{ path: 'test.md', content: procedure({ condition: { ...comparison, unit: 'cm' } }) }])).toThrow('does not match declared tag')
  expect(() => validateProcedurePublication([{ path: 'test.md', content: procedure({ condition: comparison }) }], () => { throw new Error('Missing engineering owner') })).toThrow('Missing engineering owner')
  const content = procedure({ condition: comparison })
  expect(() => parseProcedure(content.replace('## Tags', '\`\`\`procedure-assessment\n{}\n\`\`\`\n## Tags'))).toThrow('once per step')
  expect(() => parseProcedure(content.slice(0, content.indexOf('\n\`\`\`\n- Done')))).toThrow('unterminated procedure-assessment')
})
