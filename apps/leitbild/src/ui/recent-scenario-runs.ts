import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { simulationRunIdSchema, type SimulationRunId } from '../core/model/index.ts'
import { pathForSimulationRun } from './simulation-run-route.ts'

const storageKey = 'leitbild.recentSimulationRuns.v2'

type RecentScenarioRuns = Readonly<Record<string, Readonly<Record<string, string>>>>

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const browserStorage = (): StorageLike | null =>
  typeof localStorage === 'undefined' ? null : localStorage

const assertRecentRuns = (value: unknown): RecentScenarioRuns => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('recent Simulation Run storage must contain a Workspace map')
  }
  for (const [workspaceId, scenarioRuns] of Object.entries(value)) {
    if (!workspaceIdSchema.safeParse(workspaceId).success
      || typeof scenarioRuns !== 'object'
      || scenarioRuns === null
      || Array.isArray(scenarioRuns)) {
      throw new Error('recent Simulation Run storage contains an invalid Workspace entry')
    }
    for (const [scenarioId, simulationRunId] of Object.entries(scenarioRuns)) {
      if (scenarioId.length === 0 || !simulationRunIdSchema.safeParse(simulationRunId).success) {
        throw new Error('recent Simulation Run storage contains an invalid Scenario/Run entry')
      }
    }
  }
  return value as RecentScenarioRuns
}

const readRecentScenarioRuns = (storage: StorageLike | null): RecentScenarioRuns => {
  if (!storage) return {}
  const raw = storage.getItem(storageKey)
  if (raw === null) return {}
  try {
    return assertRecentRuns(JSON.parse(raw) as unknown)
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`recent Simulation Run storage is invalid JSON: ${err.message}`)
    throw err
  }
}

export const rememberRecentScenarioRun = (
  workspaceId: WorkspaceId,
  scenarioId: string,
  simulationRunId: SimulationRunId,
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  if (scenarioId.length === 0) throw new Error('Scenario id must be non-empty')
  const recentRuns = readRecentScenarioRuns(storage)
  storage.setItem(storageKey, JSON.stringify({
    ...recentRuns,
    [workspaceId]: { ...recentRuns[workspaceId], [scenarioId]: simulationRunId },
  }))
}

export const pathForRecentScenarioRun = (
  workspaceId: WorkspaceId,
  scenarioId: string,
  storage: StorageLike | null = browserStorage(),
): string | null => {
  if (scenarioId.length === 0) throw new Error('Scenario id must be non-empty')
  const simulationRunId = readRecentScenarioRuns(storage)[workspaceId]?.[scenarioId]
  return simulationRunId === undefined
    ? null
    : pathForSimulationRun(workspaceId, simulationRunIdSchema.parse(simulationRunId))
}
