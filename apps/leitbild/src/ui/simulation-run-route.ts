import { simulationRunIdSchema, type SimulationRunId } from '../core/model/index.ts'
import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface SimulationRunRoute {
  readonly mode: 'simulation-run'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly canonicalPath: string
}

export type ControlSurfaceRoute =
  | { readonly mode: 'run-picker'; readonly workspaceId: WorkspaceId; readonly canonicalPath: string }
  | { readonly mode: 'new-run'; readonly workspaceId: WorkspaceId; readonly scenarioId: string; readonly canonicalPath: string }
  | SimulationRunRoute

export const pathForWorkspace = (workspaceId: WorkspaceId): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}`

export const pathForNewSimulationRun = (workspaceId: WorkspaceId, scenarioId: string): string =>
  `${pathForWorkspace(workspaceId)}/scenarios/${encodeURIComponent(scenarioId)}/runs/new`

export const pathForSimulationRun = (workspaceId: WorkspaceId, simulationRunId: SimulationRunId): string =>
  `${pathForWorkspace(workspaceId)}/runs/${encodeURIComponent(simulationRunId)}`

export const parseControlSurfaceRoute = (pathname: string): ControlSurfaceRoute => {
  const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)\/?$/)
  if (workspaceMatch) {
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
    return { mode: 'run-picker', workspaceId, canonicalPath: pathForWorkspace(workspaceId) }
  }
  const createMatch = pathname.match(/^\/workspaces\/([^/]+)\/scenarios\/([^/]+)\/runs\/new\/?$/)
  if (createMatch) {
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(createMatch[1] ?? ''))
    const scenarioId = decodeURIComponent(createMatch[2] ?? '')
    if (!scenarioId) throw new Error('route must include a non-empty Scenario id')
    return {
      mode: 'new-run',
      workspaceId,
      scenarioId,
      canonicalPath: pathForNewSimulationRun(workspaceId, scenarioId),
    }
  }
  const runMatch = pathname.match(/^\/workspaces\/([^/]+)\/runs\/([^/]+)\/?$/)
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
