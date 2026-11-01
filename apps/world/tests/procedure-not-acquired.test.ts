import { expect, test } from 'bun:test'
import { assessProcedureBranches } from '../src/features/procedures/branch-assessment.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import type { ProcedureTagRead } from '../src/features/procedures/pack-observations.ts'
import type { IsoTimestamp } from '../src/core/model/index.ts'

// An unknown-outcome continuation may name tags the Plant does not acquire. Only the owning Pack's
// own unbound report supports it; an acquired reading contradicts it; an unchecked one stays unknown.
const at = '2026-07-12T04:00:05.003Z' as IsoTimestamp
const plantId = 'plant:ld01'
const reason = 'PRHR is not modelled in LD-01 1.0 (class c).'
const doc = parseProcedureMarkdown({
  source: { sourceId: 'leitbild-ld01', label: 'test', repository: 'Leitbild-wiki', ref: 'publication', path: 'procedures', revision: '0'.repeat(40), fetchedAt: at, sourceUrl: '/wiki' },
  sourcePath: 'procedures/test.md', sourceUrl: '/wiki',
  rawMarkdown: `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: LD01-TEST\ntitle: Not acquired\n---\n## Step 1 [id: prhr]\nCheck: «LD01.PRHR.ISO.POS» «LD01.PRHR.FT»\n\`\`\`procedure-decisions\n${JSON.stringify([{ branchIndex: 1, condition: { type: 'not-acquired', description: reason, tagIds: ['LD01.PRHR.ISO.POS', 'LD01.PRHR.FT'], source: 'criteria.md#step-3' } }])}\n\`\`\`\n- Established [outcome: normal] → END\n- Unresolved PRHR response; continue [outcome: unknown] → END\n## Tags\n- id: LD01.PRHR.ISO.POS\n  units: percent\n- id: LD01.PRHR.FT\n  units: kg/s`,
})
const step = doc.steps[0]!
const missing = (tagId: string): ProcedureTagRead => ({ tagId, binding: 'missing', warnings: [], unavailable: 'procedure tag is not bound to this Plant' })
const assess = (reads: ReadonlyArray<ProcedureTagRead>) => assessProcedureBranches({ step, reads, simulationTime: at, plantId })[1]!

test('every named tag unbound on the Plant supports the unknown route and shows the authored reason', () => {
  const result = assess([missing('LD01.PRHR.ISO.POS'), missing('LD01.PRHR.FT')])
  expect(result.status).toBe('supported')
  expect(result.readings.map(reading => [reading.tagId, reading.status, reading.reason])).toEqual([
    ['LD01.PRHR.ISO.POS', 'supported', `Not acquired on this Plant: ${reason}`],
    ['LD01.PRHR.FT', 'supported', `Not acquired on this Plant: ${reason}`],
  ])
  expect(assessProcedureBranches({ step, reads: [missing('LD01.PRHR.ISO.POS'), missing('LD01.PRHR.FT')], simulationTime: at, plantId })[0]!.status).toBe('unknown')
})

test('an acquired reading contradicts it; an unchecked or failed acquisition is never read as absence', () => {
  const acquired: ProcedureTagRead = { tagId: 'LD01.PRHR.FT', binding: 'resolved', warnings: [], value: { tagId: 'LD01.PRHR.FT', label: 'PRHR FT', value: 0, formatted: '0 kg/s', unit: 'kg/s' } }
  expect(assess([missing('LD01.PRHR.ISO.POS'), acquired]).status).toBe('contradicted')
  const unchecked: ProcedureTagRead = { tagId: 'LD01.PRHR.FT', binding: 'unchecked', warnings: [], unavailable: 'LD-01 engine failed' }
  const result = assess([missing('LD01.PRHR.ISO.POS'), unchecked])
  expect(result.status).toBe('unknown')
  expect(result.reasons).toEqual(['Signal LD01.PRHR.FT acquisition is not established: LD-01 engine failed.'])
  const bound: ProcedureTagRead = { tagId: 'LD01.PRHR.FT', binding: 'resolved', warnings: [], unavailable: 'no reading' }
  expect(assess([missing('LD01.PRHR.ISO.POS'), bound]).status).toBe('unknown')
  expect(assess([missing('LD01.PRHR.ISO.POS')]).status).toBe('unknown')
})
