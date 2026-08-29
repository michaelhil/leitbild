import type { SimulationRunId } from '../core/model/index.ts'
import type {
  ClockResponse,
  CommandResponse,
  SimulationRunListResponse,
  SimulationRunResponse,
  PackQueryApiResponse,
  ScenarioListResponse,
  ScenarioResponse,
} from './types.ts'
import type { PackQueryRequest } from '../core/packs/protocol.ts'
import { recordPackQueryDiagnostics } from './internal-diagnostics.ts'
import { workspaceApiPath } from './workspace-context.ts'

export interface SimulationRunCommandRequest {
  readonly kind: string
  readonly targetObjectIds: readonly string[]
  readonly payload: unknown
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

export const listSimulationRuns = async (): Promise<SimulationRunListResponse> => {
  const response = await fetch(workspaceApiPath('/simulation-runs'), { cache: 'no-store' })
  return await readJsonResponse<SimulationRunListResponse>(response, 'simulation run list failed')
}

export const fetchScenario = async (scenarioId: string): Promise<ScenarioResponse> => {
  const response = await fetch(workspaceApiPath(`/scenarios/${encodeURIComponent(scenarioId)}`), { cache: 'no-store' })
  return await readJsonResponse<ScenarioResponse>(response, 'scenario fetch failed')
}

export const listScenarios = async (): Promise<ScenarioListResponse> => {
  const response = await fetch(workspaceApiPath('/scenarios'), { cache: 'no-store' })
  return await readJsonResponse<ScenarioListResponse>(response, 'scenario list failed')
}

const requestBody = (body: object): BodyInit | undefined => {
  const text = JSON.stringify(body)
  return text === '{}' ? undefined : text
}

export const createSimulationRun = async (
  config: { readonly scenarioId?: string } = {},
): Promise<SimulationRunResponse> => {
  const body = requestBody(config)
  const response = await fetch(workspaceApiPath('/simulation-runs'), {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  })
  return await readJsonResponse<SimulationRunResponse>(response, 'simulation run create failed')
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

export const sendSimulationRunCommand = async (
  simulationRunId: SimulationRunId,
  command: SimulationRunCommandRequest,
): Promise<CommandResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  return await readJsonResponse<CommandResponse>(response, 'command failed')
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

const packQueryFailureMessage = (status: number, text: string): string => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `pack query failed: ${status}`
    const response = (parsed as { readonly response?: unknown }).response
    if (typeof response !== 'object' || response === null || Array.isArray(response)) return `pack query failed: ${status}`
    const reason = (response as { readonly reason?: unknown }).reason
    return typeof reason === 'string' && reason.length > 0 ? reason : `pack query failed: ${status}`
  } catch {
    return `pack query failed: ${status}`
  }
}

export const querySimulationRunPack = async (
  simulationRunId: SimulationRunId,
  request: PackQueryRequest,
  options: SimulationRunRequestOptions = {},
): Promise<PackQueryApiResponse> => {
  const body = JSON.stringify(request)
  const startedAtMs = performance.now()
  let responseStatus: number | undefined
  let recorded = false
  try {
    const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/queries`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    responseStatus = response.status
    const text = await response.text()
    recordPackQueryDiagnostics({
      packId: request.packId,
      kind: request.kind,
      startedAtMs,
      durationMs: performance.now() - startedAtMs,
      requestBytes: body.length,
      responseBytes: text.length,
      status: response.status,
      ok: response.ok,
    })
    recorded = true
    if (!response.ok) throw new Error(packQueryFailureMessage(response.status, text))
    return JSON.parse(text) as PackQueryApiResponse
  } catch (err) {
    if (!recorded) {
      recordPackQueryDiagnostics({
        packId: request.packId,
        kind: request.kind,
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
