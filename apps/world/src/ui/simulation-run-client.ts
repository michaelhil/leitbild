import type { SimulationRunId } from '../core/model/index.ts'
import type {
  ClockResponse,
  CapabilityInvocationResponse,
  SimulationRunResponse,
  ScenarioResponse,
} from './types.ts'
import { recordCapabilityQueryDiagnostics } from './internal-diagnostics.ts'
import { workspaceApiPath } from './workspace-context.ts'

export interface SimulationRunCapabilityRequest {
  readonly capabilityId: string
  readonly input: unknown
  readonly expectedRevision?: number
  readonly idempotencyKey?: string
}

export interface SimulationRunRequestOptions {
  readonly signal?: AbortSignal
}

const readJsonResponse = async <T>(
  response: Response,
  failureMessage: string,
): Promise<T> => {
  if (!response.ok) throw new Error(`${failureMessage}: ${response.status}`)
  return await response.json() as T
}

export const fetchScenario = async (scenarioId: string): Promise<ScenarioResponse> => {
  const response = await fetch(workspaceApiPath(`/scenarios/${encodeURIComponent(scenarioId)}`), { cache: 'no-store' })
  return await readJsonResponse<ScenarioResponse>(response, 'scenario fetch failed')
}

export const joinSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}`), {
    cache: 'no-store',
  })
  return await readJsonResponse<SimulationRunResponse>(response, 'simulation run join failed')
}

export const syncSimulationRunSnapshot = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/snapshot`), { cache: 'no-store' })
  return await readJsonResponse<SimulationRunResponse>(response, 'snapshot sync failed')
}

export const resetSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/reset`), {
    method: 'POST',
  })
  return await readJsonResponse<SimulationRunResponse>(response, 'simulation run reset failed')
}

export const deleteSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<{ readonly id: SimulationRunId; readonly deleted: true }> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}`), {
    method: 'DELETE',
  })
  return await readJsonResponse<{ readonly id: SimulationRunId; readonly deleted: true }>(response, 'simulation run delete failed')
}

export const invokeSimulationRunCapability = async (
  simulationRunId: SimulationRunId,
  invocation: SimulationRunCapabilityRequest,
): Promise<CapabilityInvocationResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/capabilities/${encodeURIComponent(invocation.capabilityId)}/invoke`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: invocation.input,
      ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    }),
  })
  return await readJsonResponse<CapabilityInvocationResponse>(response, 'capability invocation failed')
}

export const setSimulationRunClock = async (
  simulationRunId: SimulationRunId,
  update: { readonly paused?: boolean; readonly speed?: number; readonly currentTime?: string },
): Promise<ClockResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/clock`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  return await readJsonResponse<ClockResponse>(response, 'clock update failed')
}

const capabilityQueryFailureMessage = (status: number, text: string): string => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `Capability query failed: ${status}`
    const error = (parsed as { readonly error?: unknown }).error
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return `Capability query failed: ${status}`
    const message = (error as { readonly message?: unknown }).message
    return typeof message === 'string' && message.length > 0 ? message : `Capability query failed: ${status}`
  } catch {
    return `Capability query failed: ${status}`
  }
}

const diagnosticPackId = (capabilityId: string): string => capabilityId.split('.')[1] ?? 'world'

export const querySimulationRunCapability = async <T = unknown>(
  simulationRunId: SimulationRunId,
  capabilityId: string,
  input: unknown,
  options: SimulationRunRequestOptions = {},
): Promise<T> => {
  const body = JSON.stringify({ input })
  const startedAtMs = performance.now()
  let responseStatus: number | undefined
  let recorded = false
  try {
    const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    responseStatus = response.status
    const text = await response.text()
    recordCapabilityQueryDiagnostics({
      ownerId: diagnosticPackId(capabilityId),
      capabilityId,
      startedAtMs,
      durationMs: performance.now() - startedAtMs,
      requestBytes: body.length,
      responseBytes: text.length,
      status: response.status,
      ok: response.ok,
    })
    recorded = true
    if (!response.ok) throw new Error(capabilityQueryFailureMessage(response.status, text))
    const invocation = JSON.parse(text) as CapabilityInvocationResponse
    if (invocation.kind !== 'query') throw new Error(`Simulation Capability is not a query: ${capabilityId}`)
    return invocation.result as T
  } catch (err) {
    if (!recorded) {
      recordCapabilityQueryDiagnostics({
        ownerId: diagnosticPackId(capabilityId),
        capabilityId,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        requestBytes: body.length,
        responseBytes: 0,
        ...(responseStatus === undefined ? {} : { status: responseStatus }),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }
}
