import { simulationRunIdSchema, type SimulationRunId } from '../core/model/index.ts'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

export interface SimulationRunRoute {
  readonly mode: 'simulation-run'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly canonicalPath: string
}

export type ControlSurfaceRoute =
  | { readonly mode: 'workspace-home'; readonly workspaceId: WorkspaceId; readonly canonicalPath: string }
  | SimulationRunRoute

export const pathForWorkspace = (workspaceId: WorkspaceId): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}/world`

export const pathForSimulationRun = (workspaceId: WorkspaceId, simulationRunId: SimulationRunId): string =>
  `${pathForWorkspace(workspaceId)}/runs/${encodeURIComponent(simulationRunId)}`

export const parseControlSurfaceRoute = (pathname: string): ControlSurfaceRoute => {
  const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)\/world\/?$/)
  if (workspaceMatch) {
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
    return { mode: 'workspace-home', workspaceId, canonicalPath: pathForWorkspace(workspaceId) }
  }
  const runMatch = pathname.match(/^\/workspaces\/([^/]+)\/world\/runs\/([^/]+)\/?$/)
  if (!runMatch) throw new Error('route must identify a Workspace or Simulation Run')
  const workspaceId = workspaceIdSchema.parse(decodeURIComponent(runMatch[1] ?? ''))
  const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(runMatch[2] ?? ''))
  return {
    mode: 'simulation-run',
    workspaceId,
    simulationRunId,
    canonicalPath: pathForSimulationRun(workspaceId, simulationRunId),
  }
}
