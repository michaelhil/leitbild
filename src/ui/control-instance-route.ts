import { controlInstanceIdSchema, type ControlInstanceId } from '../core/model/index.ts'

export interface ScenarioRunRoute {
  readonly mode: 'control-instance'
  readonly scenarioId: string
  readonly runId: string
  readonly controlInstanceId: ControlInstanceId
  readonly canonicalPath: string
}

export type ControlSurfaceRoute =
  | { readonly mode: 'picker' }
  | { readonly mode: 'new-run'; readonly scenarioId: string; readonly canonicalPath: string }
  | ScenarioRunRoute

export const controlInstanceIdForScenarioRun = (scenarioId: string, runId: string): ControlInstanceId =>
  controlInstanceIdSchema.parse(`${scenarioId}:${runId}`)

export const pathForNewScenarioRun = (scenarioId: string): string =>
  `/i/${encodeURIComponent(scenarioId)}`

export const pathForScenarioRun = (scenarioId: string, runId: string): string =>
  `/i/${encodeURIComponent(scenarioId)}/${encodeURIComponent(runId)}`

export const createGeneratedRunId = (): string =>
  `run-${crypto.randomUUID()}`

export const parseControlSurfaceRoute = (pathname: string): ControlSurfaceRoute => {
  if (pathname === '/' || pathname === '/i' || pathname === '/i/') return { mode: 'picker' }
  const createMatch = pathname.match(/^\/i\/([^/]+)\/?$/)
  if (createMatch) {
    const scenarioId = decodeURIComponent(createMatch[1] ?? '')
    if (!scenarioId) throw new Error('route must include a non-empty scenario')
    return {
      mode: 'new-run',
      scenarioId,
      canonicalPath: pathForNewScenarioRun(scenarioId),
    }
  }
  const match = pathname.match(/^\/i\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error('route must identify a scenario and run, for example /i/halden/sandbox')
  const scenarioId = decodeURIComponent(match[1] ?? '')
  const runId = decodeURIComponent(match[2] ?? '')
  if (!scenarioId || !runId) throw new Error('route must include a non-empty scenario and run')
  return {
    mode: 'control-instance',
    scenarioId,
    runId,
    controlInstanceId: controlInstanceIdForScenarioRun(scenarioId, runId),
    canonicalPath: pathForScenarioRun(scenarioId, runId),
  }
}
