import { describe, expect, test } from 'bun:test'
import { pathForRecentScenarioRun, rememberRecentScenarioRun } from '../src/ui/recent-scenario-runs.ts'

const createMemoryStorage = (): {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
} => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('recent scenario run navigation memory', () => {
  test('remembers the last joined run per scenario and returns scenario-run paths', () => {
    const storage = createMemoryStorage()

    expect(pathForRecentScenarioRun('halden', storage)).toBeNull()

    rememberRecentScenarioRun('halden', 'run-halden-1', storage)
    rememberRecentScenarioRun('oslo-ambulance', 'run-oslo-1', storage)

    expect(pathForRecentScenarioRun('halden', storage)).toBe('/i/halden/run-halden-1')
    expect(pathForRecentScenarioRun('oslo-ambulance', storage)).toBe('/i/oslo-ambulance/run-oslo-1')

    rememberRecentScenarioRun('halden', 'run-halden-2', storage)

    expect(pathForRecentScenarioRun('halden', storage)).toBe('/i/halden/run-halden-2')
    expect(pathForRecentScenarioRun('oslo-ambulance', storage)).toBe('/i/oslo-ambulance/run-oslo-1')
  })

  test('fails visibly for corrupted navigation memory instead of silently creating a new run', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.recentScenarioRuns.v1', '{')

    expect(() => pathForRecentScenarioRun('halden', storage)).toThrow('recent scenario run storage is invalid JSON')
  })
})
