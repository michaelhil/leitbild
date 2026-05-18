import { controlInstanceIdSchema, idSchema, type ControlInstanceId } from './ids.ts'

export interface ScenarioRunIdentity {
  readonly scenarioId: string
  readonly runId: string
}

export const createScenarioRunControlInstanceId = (
  identity: ScenarioRunIdentity,
): ControlInstanceId => {
  const scenarioId = idSchema.parse(identity.scenarioId)
  const runId = idSchema.parse(identity.runId)
  return controlInstanceIdSchema.parse(`${scenarioId}:${runId}`)
}

export const parseScenarioRunControlInstanceId = (
  id: ControlInstanceId,
  scenarioId: string | undefined,
): { readonly scenarioId: string | null; readonly runId: string | null } => {
  if (scenarioId === undefined) return { scenarioId: null, runId: null }
  const prefix = `${scenarioId}:`
  if (!id.startsWith(prefix)) return { scenarioId, runId: null }
  const runId = id.slice(prefix.length)
  return runId ? { scenarioId, runId } : { scenarioId, runId: null }
}

export const createGeneratedScenarioRunId = (): string =>
  `run-${randomUuid()}`

const randomUuid = (): string => {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is not available in this runtime')
  return globalThis.crypto.randomUUID()
}
