import { controlInstanceIdSchema, type ControlInstanceId } from '../core/model/index.ts'

export interface ScenarioRunRoute {
  readonly mode: 'control-instance'
  readonly workspaceId: string
  readonly scenarioId: string
  readonly controlInstanceId: ControlInstanceId
  readonly canonicalPath: string
}

export type ControlSurfaceRoute =
  | { readonly mode: 'picker' }
  | ScenarioRunRoute

const defaultWorkspaceId = 'sandbox'
const defaultScenarioId = 'oslo-ambulance'

export const controlInstanceIdForScenarioRun = (workspaceId: string, scenarioId: string): ControlInstanceId =>
  controlInstanceIdSchema.parse(`${workspaceId}:${scenarioId}`)

export const pathForScenarioRun = (workspaceId: string, scenarioId: string): string =>
  `/i/${encodeURIComponent(workspaceId)}/${encodeURIComponent(scenarioId)}`

export const defaultScenarioRunPath = (): string =>
  pathForScenarioRun(defaultWorkspaceId, defaultScenarioId)

export const parseControlSurfaceRoute = (pathname: string): ControlSurfaceRoute => {
  if (pathname === '/i') return { mode: 'picker' }
  if (pathname === '/') {
    return {
      mode: 'control-instance',
      workspaceId: defaultWorkspaceId,
      scenarioId: defaultScenarioId,
      controlInstanceId: controlInstanceIdForScenarioRun(defaultWorkspaceId, defaultScenarioId),
      canonicalPath: defaultScenarioRunPath(),
    }
  }
  const match = pathname.match(/^\/i\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error('route must identify a workspace and scenario, for example /i/sandbox/halden')
  const workspaceId = decodeURIComponent(match[1] ?? '')
  const scenarioId = decodeURIComponent(match[2] ?? '')
  if (!workspaceId || !scenarioId) throw new Error('route must include a non-empty workspace and scenario')
  return {
    mode: 'control-instance',
    workspaceId,
    scenarioId,
    controlInstanceId: controlInstanceIdForScenarioRun(workspaceId, scenarioId),
    canonicalPath: pathForScenarioRun(workspaceId, scenarioId),
  }
}
