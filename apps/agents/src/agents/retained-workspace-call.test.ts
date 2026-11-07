import { expect, test } from 'bun:test'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'
import { procedureDelegationsOf } from './procedure-resumes.ts'
import { proposedOperationsOf } from './proposal-cards.ts'
import { retainedWorkspaceResults } from './retained-workspace-call.ts'

test('continuations share exact request and resource evidence while preserving refusals', () => {
  const run = workspaceResourceReferenceSchema.parse({ workspaceId: '6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f',
    moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
  const target = { kind: 'resource', ref: run }
  const other = { kind: 'resource', ref: workspaceResourceReferenceSchema.parse({ ...run, id: 'run-2' }) }
  const input = { plantId: 'plant:unit-1', tagId: 'RX-TRIP', value: true }
  const procedure = (key: string, destination = target) => ({ key, operationId: 'world.procedure.run.start', target: destination, input: { procedureId: 'E-0' } })
  const proposal = (key: string, destination = target) => ({ key, operationId: PROPOSE_OPERATION_ID, target: destination, input })
  const success = (key: string, destination = target) => ({ ...procedure(key, destination), success: true,
    data: { ok: true, commandId: key, next: { sequence: 1, run: { runId: `procedure:${key}`, procedureId: 'E-0', status: 'active' } } } })

  const results = retainedWorkspaceResults([{ id: 'mixed', tool: 'workspace_call', startedAt: 10, completedAt: 20, argumentBytes: 1,
    arguments: { calls: [procedure(' start '), proposal('propose'), proposal('refused'), proposal('wrong-op'), procedure('wrong-resource', other), procedure('wrong-key')] },
    result: { success: true, data: { results: [
      success('start'), { ...proposal('propose'), success: true, data: { ok: true, commandId: 'proposal:1' } },
      { key: 'refused', operationId: PROPOSE_OPERATION_ID, success: false, error: 'not permitted' },
      success('wrong-op'), success('wrong-resource'), success('other-key'),
    ] } },
  }])

  expect(results.map(result => result.key)).toEqual(['start', 'propose', 'refused'])
  expect(procedureDelegationsOf(results)).toMatchObject([{ resource: run, runId: 'procedure:start' }])
  expect(proposedOperationsOf(results).map(operation => operation.outcome)).toEqual([
    { kind: 'recorded', proposalId: 'proposal:1', resource: run },
    { kind: 'refused', reason: 'not permitted' },
  ])
})
