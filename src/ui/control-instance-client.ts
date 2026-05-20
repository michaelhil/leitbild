import type { ControlInstanceId } from '../core/model/index.ts'
import type {
  ClockResponse,
  CommandResponse,
  ControlInstanceListResponse,
  ControlInstanceResponse,
  PackQueryApiResponse,
  ScenarioListResponse,
  ScenarioResponse,
} from './types.ts'
import type { PackQueryRequest } from '../core/packs/protocol.ts'

export interface ControlInstanceCommandRequest {
  readonly kind: string
  readonly targetObjectIds: readonly string[]
  readonly payload: unknown
}

const readJsonResponse = async <T>(
  response: Response,
  failureMessage: string,
): Promise<T> => {
  if (!response.ok) throw new Error(`${failureMessage}: ${response.status}`)
  return await response.json() as T
}

export const listControlInstances = async (): Promise<ControlInstanceListResponse> => {
  const response = await fetch('/api/control-instances', { cache: 'no-store' })
  return await readJsonResponse<ControlInstanceListResponse>(response, 'control instance list failed')
}

export const fetchScenario = async (scenarioId: string): Promise<ScenarioResponse> => {
  const response = await fetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, { cache: 'no-store' })
  return await readJsonResponse<ScenarioResponse>(response, 'scenario fetch failed')
}

export const listScenarios = async (): Promise<ScenarioListResponse> => {
  const response = await fetch('/api/scenarios', { cache: 'no-store' })
  return await readJsonResponse<ScenarioListResponse>(response, 'scenario list failed')
}

const requestBody = (body: object): BodyInit | undefined => {
  const text = JSON.stringify(body)
  return text === '{}' ? undefined : text
}

export const createControlInstance = async (
  config: { readonly id?: ControlInstanceId; readonly scenarioId?: string } = {},
): Promise<ControlInstanceResponse> => {
  const body = requestBody(config)
  const response = await fetch('/api/control-instances', {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  })
  return await readJsonResponse<ControlInstanceResponse>(response, 'control instance create failed')
}

export const joinControlInstance = async (
  controlInstanceId: ControlInstanceId,
  config: { readonly scenarioId?: string } = {},
): Promise<ControlInstanceResponse> => {
  const body = requestBody(config)
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  })
  return await readJsonResponse<ControlInstanceResponse>(response, 'control instance join failed')
}

export const syncControlInstanceSnapshot = async (
  controlInstanceId: ControlInstanceId,
): Promise<ControlInstanceResponse> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/snapshot`, { cache: 'no-store' })
  return await readJsonResponse<ControlInstanceResponse>(response, 'snapshot sync failed')
}

export const resetControlInstance = async (
  controlInstanceId: ControlInstanceId,
  config: { readonly scenarioId?: string } = {},
): Promise<ControlInstanceResponse> => {
  const body = requestBody(config)
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/reset`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  })
  return await readJsonResponse<ControlInstanceResponse>(response, 'control instance reset failed')
}

export const deleteControlInstance = async (
  controlInstanceId: ControlInstanceId,
): Promise<{ readonly id: ControlInstanceId; readonly deleted: true }> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}`, {
    method: 'DELETE',
  })
  return await readJsonResponse<{ readonly id: ControlInstanceId; readonly deleted: true }>(response, 'control instance delete failed')
}

export const sendControlInstanceCommand = async (
  controlInstanceId: ControlInstanceId,
  command: ControlInstanceCommandRequest,
): Promise<CommandResponse> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  return await readJsonResponse<CommandResponse>(response, 'command failed')
}

export const setControlInstanceClock = async (
  controlInstanceId: ControlInstanceId,
  update: { readonly paused?: boolean; readonly speed?: number; readonly currentTime?: string },
): Promise<ClockResponse> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/clock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  return await readJsonResponse<ClockResponse>(response, 'clock update failed')
}

export const queryControlInstancePack = async (
  controlInstanceId: ControlInstanceId,
  request: PackQueryRequest,
): Promise<PackQueryApiResponse> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/queries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return await readJsonResponse<PackQueryApiResponse>(response, 'pack query failed')
}
