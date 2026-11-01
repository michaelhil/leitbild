import { expect, test } from 'bun:test'
import { createProcedureObservationPort, readProcedureTags } from '../src/features/procedures/pack-observations.ts'
import { assessProcedureBranches } from '../src/features/procedures/branch-assessment.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import type { IsoTimestamp } from '../src/core/model/index.ts'

// LD-01 reads its single nuclear tag on one power-proxy channel: the graph signal LD01.CORE.POWER.P1 declares
// externalRefs [LD01.CORE.POWER.NUCLEAR]. A procedure naming the external tag must read that channel, and must
// not lose the other tags of the same batch (the E0 run of 1 Nov lost all three).
const plantId = 'plant:ld01'
const at = '2026-07-12T04:00:05.003Z' as IsoTimestamp
const row = (path: string, tagId: string, unit: string, value: number | boolean, externalRefs?: ReadonlyArray<string>) => ({
  signal: { path, tagId, label: tagId, unit, writable: false, published: true, ...(externalRefs === undefined ? {} : { externalRefs }) },
  variable: { path, value, unit, writable: false, published: true },
  valueView: { status: 'native', value, unit, requestedUnit: unit },
  quality: { status: 'good' },
})
const rows = {
  'LD01.CORE.BANK.INSERTED': row('CORE.BANK-INSERTED', 'LD01.CORE.BANK.INSERTED', 'boolean', true),
  'LD01.CORE.POWER.NUCLEAR': row('CORE.P1', 'LD01.CORE.POWER.P1', 'percent', 3.3175, ['LD01.CORE.POWER.NUCLEAR']),
  'LD01.CORE.POWER.P1': row('CORE.P1', 'LD01.CORE.POWER.P1', 'percent', 3.3175, ['LD01.CORE.POWER.NUCLEAR']),
  // A row answering a request with an identity it neither has nor references.
  'LD01.TEST.FOREIGN': row('CORE.P1', 'LD01.CORE.POWER.P1', 'percent', 3.3175, ['LD01.CORE.POWER.NUCLEAR']),
} as const

const document = (tags: ReadonlyArray<string>) => parseProcedureMarkdown({
  source: { sourceId: 'leitbild-ld01', label: 'test', repository: 'Leitbild-wiki', ref: 'publication', path: 'procedures', revision: '0'.repeat(40), fetchedAt: at, sourceUrl: '/wiki' },
  sourcePath: 'procedures/test.md', sourceUrl: '/wiki',
  rawMarkdown: `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: LD01-TEST\ntitle: External reference\n---\n## Step 1 [id: check]\nCheck: ${tags.map(tag => `«${tag}»`).join(' ')}\n\`\`\`procedure-decisions\n${JSON.stringify([{ branchIndex: 0, condition: { type: 'comparison', tagId: 'LD01.CORE.BANK.INSERTED', operator: '==', value: true, unit: 'boolean', evidence: 'engineering-diagnostic', source: 'test.md#tags', maxAgeSeconds: 2 } }])}\n\`\`\`\n- Inserted → END\n## Tags\n${tags.map(tag => `- id: ${tag}\n  units: ${rows[tag as keyof typeof rows].signal.unit}`).join('\n')}`,
})

const port = () => createProcedureObservationPort({
  scopeId: plantId,
  provider: {
    scopeIdForObject: () => plantId,
    signalReadQuery: (_scope, tags) => ({ capabilityId: 'read', input: tags.map(tag => tag.id) }),
    tagValidationQuery: (_scope, tags) => ({ capabilityId: 'validate', input: tags.map(tag => tag.id) }),
    assessmentsQuery: () => ({ capabilityId: 'assess', input: [] }),
  },
  query: async request => request.capabilityId === 'validate'
    ? { tags: (request.input as string[]).map(id => ({ id, status: 'resolved', warnings: [] })) }
    : { plantId, evidence: { evidenceKind: 'engineering-diagnostic', provenance: 'runtime-model', simulationTime: at },
      signals: (request.input as string[]).map(id => rows[id as keyof typeof rows]) },
})

test('a tag read through its channel external reference keeps the whole batch and its requested identity', async () => {
  const doc = document(['LD01.CORE.BANK.INSERTED', 'LD01.CORE.POWER.NUCLEAR'])
  const reads = await readProcedureTags({ observations: port, declared: doc.tags, tagIds: doc.steps[0]!.tagIds })
  expect(reads.map(read => [read.tagId, read.value?.value, read.value?.signalTagId, read.unavailable])).toEqual([
    ['LD01.CORE.BANK.INSERTED', true, 'LD01.CORE.BANK.INSERTED', undefined],
    ['LD01.CORE.POWER.NUCLEAR', 3.3175, 'LD01.CORE.POWER.NUCLEAR', undefined],
  ])
  expect(assessProcedureBranches({ step: doc.steps[0]!, reads, simulationTime: at, plantId })[0]?.status).toBe('supported')
})

test('the channel and its external reference read together; an unrelated identity is still refused', async () => {
  const both = document(['LD01.CORE.POWER.P1', 'LD01.CORE.POWER.NUCLEAR'])
  const reads = await readProcedureTags({ observations: port, declared: both.tags, tagIds: ['LD01.CORE.POWER.P1', 'LD01.CORE.POWER.NUCLEAR'] })
  expect(reads.map(read => read.value?.signalTagId)).toEqual(['LD01.CORE.POWER.P1', 'LD01.CORE.POWER.NUCLEAR'])
  const foreign = document(['LD01.TEST.FOREIGN'])
  const refused = await readProcedureTags({ observations: port, declared: foreign.tags, tagIds: ['LD01.TEST.FOREIGN'] })
  expect(refused[0]?.value).toBeUndefined()
  expect(refused[0]?.unavailable).toContain('unexpected or duplicated identity LD01.CORE.POWER.P1')
})
