import { expect, test } from 'bun:test'
import { parseProcedure, parseProcedureDecisions, validateProcedurePublication } from './index.ts'

const condition = { type: 'comparison', tagId: 'PT-455', operator: '<', value: 12.7, unit: 'MPa', bound: 'value', evidence: 'engineering-diagnostic', source: '../systems/criteria.md#si', maxAgeSeconds: 0 } as const
const source = (decisions: unknown) => `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: TEST\ntitle: Decisions\n---\n## Step 1 [id: check]\nCheck: Evaluate current conditions\n\`\`\`procedure-decisions\n${JSON.stringify(decisions)}\n\`\`\`\n- Required → END\n- Not required → END\n## Tags\n- id: PT-455\n  units: MPa`

test('branch decisions preserve criteria, sourced applicability and hidden structural operands', () => {
  const decisions = [{ branchIndex: 0, condition, applicability: { description: 'Current model diagnostic; reference instrument qualification is not established.', source: '../systems/criteria.md#scope' } }]
  const parsed = parseProcedure(source(decisions))
  expect(parsed.steps[0]!.decisions).toEqual(decisions)
  expect(parsed.steps[0]!.assessment).toBeUndefined()
  expect(parsed.steps[0]!.tagIds).toEqual(['PT-455'])
  expect(parsed.steps[0]!.blocks.map(block => block.text).join('')).not.toContain('maxAgeSeconds')
  const sources: string[] = []
  validateProcedurePublication([{ path: 'procedures/test.md', content: source(decisions) }], (_path, href) => { sources.push(href) })
  expect(sources).toEqual([condition.source, '../systems/criteria.md#scope'])
})

test('branch eligibility rejects ambiguous, unbound and invented authoring constructs', () => {
  for (const invalid of [[], {}, [{ branchIndex: -1, condition }], [{ branchIndex: 0.5, condition }], [{ branchIndex: 0, condition }, { branchIndex: 0, condition }],
    [{ branchIndex: 0, condition, assumeMissingNormal: true }], [{ branchIndex: 0, condition, applicability: { description: 'All missing devices absent', source: 'x', excludeUnbound: true } }],
    [{ branchIndex: 0, condition: { ...condition, maxAgeSeconds: undefined } }]]) expect(() => parseProcedureDecisions(invalid)).toThrow()
  expect(() => parseProcedure(source([{ branchIndex: 2, condition }]))).toThrow('has no branch')
  expect(() => validateProcedurePublication([{ path: 'test.md', content: source([{ branchIndex: 0, condition: { ...condition, unit: 'bar' } }]) }])).toThrow('does not match declared tag')
  expect(() => parseProcedure(source([{ branchIndex: 0, condition }]).replace('## Tags', '\`\`\`procedure-decisions\n[]\n\`\`\`\n## Tags'))).toThrow('once per step')
})
