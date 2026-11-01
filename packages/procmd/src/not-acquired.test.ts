import { expect, test } from 'bun:test'
import { parseProcedure, validateProcedurePublication } from './index.ts'

const notAcquired = { type: 'not-acquired', description: 'PRHR is not modelled on this Plant.', tagIds: ['PRHR-FT'], source: 'criteria.md#prhr' } as const
const source = (decisions: unknown, outcome = 'unknown', assessment?: unknown) => `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: TEST\ntitle: Not acquired\n---\n## Step 1 [id: check]\nCheck: «PRHR-FT»\n${assessment === undefined ? '' : `\`\`\`procedure-assessment\n${JSON.stringify(assessment)}\n\`\`\`\n`}\`\`\`procedure-decisions\n${JSON.stringify(decisions)}\n\`\`\`\n- Established [outcome: normal] → END\n- Unresolved; continue [outcome: ${outcome}] → END\n## Tags\n- id: PRHR-FT\n  units: kg/s`

test('a not-acquired leaf names its tags, reason and source, and joins the step tags', () => {
  const parsed = parseProcedure(source([{ branchIndex: 1, condition: notAcquired }]))
  expect(parsed.steps[0]!.decisions).toEqual([{ branchIndex: 1, condition: notAcquired }])
  expect(parsed.steps[0]!.tagIds).toEqual(['PRHR-FT'])
  const sources: string[] = []
  validateProcedurePublication([{ path: 'procedures/test.md', content: source([{ branchIndex: 1, condition: { type: 'all', conditions: [notAcquired] } }]) }], (_path, href) => { sources.push(href) })
  expect(sources).toEqual(['criteria.md#prhr'])
})

test('not-acquired is refused outside an unknown-outcome branch and without explicit tags or reason', () => {
  expect(() => parseProcedure(source([{ branchIndex: 0, condition: notAcquired }]))).toThrow('[outcome: unknown]')
  expect(() => parseProcedure(source([{ branchIndex: 1, condition: { type: 'not', condition: notAcquired } }], 'rno'))).toThrow('[outcome: unknown]')
  expect(() => parseProcedure(source([{ branchIndex: 1, condition: notAcquired }], 'normal'))).toThrow('[outcome: unknown]')
  expect(() => parseProcedure(source([{ branchIndex: 1, condition: notAcquired }], 'unknown', { condition: notAcquired }))).toThrow('not step assessment')
  for (const invalid of [{ ...notAcquired, tagIds: [] }, { ...notAcquired, tagIds: ['PRHR-FT', 'PRHR-FT'] }, { ...notAcquired, description: '' },
    { ...notAcquired, source: undefined }, { ...notAcquired, assumeNormal: true }]) expect(() => parseProcedure(source([{ branchIndex: 1, condition: invalid }]))).toThrow()
  expect(() => validateProcedurePublication([{ path: 'test.md', content: source([{ branchIndex: 1, condition: { ...notAcquired, tagIds: ['UNDECLARED'] } }]) }])).toThrow('Undeclared tag')
})
