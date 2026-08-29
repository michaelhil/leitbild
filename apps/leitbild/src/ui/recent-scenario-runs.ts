import { pathForScenarioRun } from './control-instance-route.ts'

const storageKey = 'leitbild.recentScenarioRuns.v1'

type RecentScenarioRuns = Readonly<Record<string, string>>

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const browserStorage = (): StorageLike | null =>
  typeof localStorage === 'undefined' ? null : localStorage

const assertScenarioRunMap = (value: unknown): RecentScenarioRuns => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('recent scenario run storage must contain an object')
  }
  const entries = Object.entries(value)
  for (const [scenarioId, runId] of entries) {
    if (scenarioId.length === 0 || typeof runId !== 'string' || runId.length === 0) {
      throw new Error('recent scenario run storage contains an invalid scenario/run entry')
    }
  }
  return Object.fromEntries(entries) as RecentScenarioRuns
}

const readRecentScenarioRuns = (storage: StorageLike | null): RecentScenarioRuns => {
  if (!storage) return {}
  const raw = storage.getItem(storageKey)
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`recent scenario run storage is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return assertScenarioRunMap(parsed)
}

export const rememberRecentScenarioRun = (
  scenarioId: string,
  runId: string,
  storage: StorageLike | null = browserStorage(),
): void => {
  if (!storage) return
  if (scenarioId.length === 0 || runId.length === 0) throw new Error('scenario and run ids must be non-empty')
  const recentRuns = readRecentScenarioRuns(storage)
  storage.setItem(storageKey, JSON.stringify({ ...recentRuns, [scenarioId]: runId }))
}

export const pathForRecentScenarioRun = (
  scenarioId: string,
  storage: StorageLike | null = browserStorage(),
): string | null => {
  if (scenarioId.length === 0) throw new Error('scenario id must be non-empty')
  const runId = readRecentScenarioRuns(storage)[scenarioId]
  return runId === undefined ? null : pathForScenarioRun(scenarioId, runId)
}
