import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { simulationRunIdSchema } from '../src/core/model/index.ts'
import { pathForRecentScenarioRun, rememberRecentScenarioRun } from '../src/ui/recent-scenario-runs.ts'

const firstWorkspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const secondWorkspaceId = workspaceIdSchema.parse('22222222-2222-4222-8222-222222222222')

const createMemoryStorage = (): {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
} => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe('recent Scenario Run navigation memory', () => {
  test('scopes remembered runs by Workspace and Scenario', () => {
    const storage = createMemoryStorage()
    const firstRunId = simulationRunIdSchema.parse('run-halden-1')
    const secondRunId = simulationRunIdSchema.parse('run-halden-2')

    expect(pathForRecentScenarioRun(firstWorkspaceId, 'halden', storage)).toBeNull()
    rememberRecentScenarioRun(firstWorkspaceId, 'halden', firstRunId, storage)
    rememberRecentScenarioRun(secondWorkspaceId, 'halden', secondRunId, storage)

    expect(pathForRecentScenarioRun(firstWorkspaceId, 'halden', storage))
      .toBe(`/workspaces/${firstWorkspaceId}/runs/${firstRunId}`)
    expect(pathForRecentScenarioRun(secondWorkspaceId, 'halden', storage))
      .toBe(`/workspaces/${secondWorkspaceId}/runs/${secondRunId}`)
    expect(pathForRecentScenarioRun(firstWorkspaceId, 'oslo-ambulance', storage)).toBeNull()
  })

  test('fails visibly for corrupt navigation memory', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.recentSimulationRuns.v2', '{')
    expect(() => pathForRecentScenarioRun(firstWorkspaceId, 'halden', storage))
      .toThrow('recent Simulation Run storage is invalid JSON')
  })
})
