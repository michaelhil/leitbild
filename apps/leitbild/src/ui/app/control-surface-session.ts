import type { SimulationRunId, OperationalObject, ScenarioExecutionState, SimulationClockState } from '../../core/model/index.ts'
import type { LeitbildPack } from '../../core/packs/protocol.ts'
import type { StartupStepId } from '../startup.ts'
import type { SimulationRunResponse } from '../types.ts'

export interface ControlSurfaceSnapshotStartupConfig {
  readonly response: SimulationRunResponse
  readonly pack: LeitbildPack
  readonly startStep: (id: StartupStepId) => void
  readonly completeStep: (id: StartupStepId) => void
  readonly setActiveStartupStep: (id: StartupStepId) => void
  readonly setSimulationRunId: (id: SimulationRunId) => void
  readonly setObjects: (objects: OperationalObject[]) => void
  readonly setScenarioState: (state: ScenarioExecutionState | undefined) => void
  readonly setClock: (clock: SimulationClockState | undefined) => void
  readonly setExpectedRealtimeScenarioId: (scenarioId: string) => void
  readonly setSelectedControllerId: (id: string | null) => void
  readonly setSeenRevisions: (seen: Map<string, number>) => void
  readonly setSnapshotReady: (ready: boolean) => void
  readonly loadSurfaceForScenario: (scenarioId: string) => Promise<void>
  readonly completeObjectsWhenReady: () => Promise<void>
  readonly connectRealtime: (id: SimulationRunId) => void
  readonly rememberRecentRun?: () => void
  readonly onRememberRecentRunFailed?: (error: unknown) => void
}

export const completeControlSurfaceStartupFromSnapshot = async (
  config: ControlSurfaceSnapshotStartupConfig,
): Promise<void> => {
  const snapshot = config.response.snapshot
  config.completeStep('simulation-run')
  config.setActiveStartupStep('snapshot')
  config.startStep('snapshot')
  config.setSimulationRunId(config.response.id)
  config.setObjects([...snapshot.objects])
  config.setScenarioState(snapshot.scenario)
  config.setClock(snapshot.clock)
  if (!snapshot.scenario?.scenarioId) throw new Error('simulation run snapshot is missing scenario state')
  config.setExpectedRealtimeScenarioId(snapshot.scenario.scenarioId)
  try {
    config.rememberRecentRun?.()
  } catch (err) {
    config.onRememberRecentRunFailed?.(err)
  }
  config.setSelectedControllerId(snapshot.objects.find(object => config.pack.commands.isController(object))?.id ?? null)
  config.setSeenRevisions(new Map(snapshot.objects.map(object => [object.id, object.revision])))
  config.setSnapshotReady(true)
  config.completeStep('snapshot')
  config.setActiveStartupStep('realtime')
  config.connectRealtime(config.response.id)
  config.setActiveStartupStep('map')
  config.startStep('map')
  await config.loadSurfaceForScenario(snapshot.scenario.scenarioId)
  config.setActiveStartupStep('objects')
  config.startStep('objects')
  await config.completeObjectsWhenReady()
}
