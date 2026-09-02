import type { ProcedureCatalog, ProcedureDocument, ProcedureRunState, SimulationRunId } from '../src/core/model/index.ts'
import { actorIdSchema, nowIso } from '../src/core/model/index.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'

export const procedureTestRunId = 'procedure-session-test' as SimulationRunId
export const procedureTestSource = {
  sourceId: 'test-procedures', label: 'Test procedures', repository: 'test/procedures', ref: 'main',
  path: 'wiki/procedures', revision: 'a'.repeat(40), fetchedAt: nowIso(), sourceUrl: 'https://example.test/procedures',
}
export const procedureTestDocument = (id = 'E-0', revision = procedureTestSource.revision): ProcedureDocument =>
  parseProcedureMarkdown({
    source: { ...procedureTestSource, revision }, sourcePath: `wiki/procedures/${id}.md`,
    sourceUrl: `https://example.test/${revision}/${id}.md`,
    rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: ${id}
title: Test ${id}
category: custom-category
csfs-monitored: [test-condition]
---
# ${id}
## Step 1 [id: first]
Check: First condition
- Not verified → [[TARGET]]
## Step 2 [id: second]
Action: Second action
- Verified → END
`,
  })

export const procedureTestCatalog = (ids = ['E-0', 'TARGET']): ProcedureCatalog => ({
  source: procedureTestSource,
  procedures: ids.map(id => {
    const document = procedureTestDocument(id)
    return { sourceId: document.source.sourceId, procedureId: id, title: document.title,
      category: document.category!, csfsMonitored: document.csfsMonitored, entryTriggers: [],
      stepCount: document.steps.length, tagCount: 0, sourcePath: document.sourcePath, sourceUrl: document.sourceUrl }
  }),
})

export const procedureTestRun = (currentStepId = 'first'): ProcedureRunState => ({
  runId: 'procedure-run:test', sourceId: procedureTestSource.sourceId, sourceRevision: procedureTestSource.revision,
  sourcePath: 'wiki/procedures/E-0.md', procedureId: 'E-0', title: 'Test', status: 'active',
  scope: { plantId: 'plant:test' }, startedAt: nowIso(), startedBy: actorIdSchema.parse('operator:one'),
  currentStepId, stepStates: [],
})

export const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const settle = async (): Promise<void> => { for (let index = 0; index < 20; index++) await Promise.resolve() }
