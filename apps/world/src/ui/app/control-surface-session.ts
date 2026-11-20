import type { SimulationRunId, ObjectId, OperationalObject, ScenarioExecutionState, SimulationClockState } from '../../core/model/index.ts'
import type { StartupStepId } from '../startup.ts'
import type { SimulationRunResponse } from '../types.ts'

export interface ControlSurfaceSnapshotStartupConfig {
  readonly response: SimulationRunResponse
  readonly startStep: (id: StartupStepId) => void
  readonly completeStep: (id: StartupStepId) => void
  readonly setActiveStartupStep: (id: StartupStepId) => void
  readonly setSimulationRunId: (id: SimulationRunId) => void
  readonly setObjects: (objects: OperationalObject[]) => void
  readonly setScenarioState: (state: ScenarioExecutionState | undefined) => void
  readonly setClock: (clock: SimulationClockState | undefined) => void
  readonly setExpectedRealtimeScenarioId: (scenarioId: string) => void
  readonly setSelectedControllerId: (id: ObjectId | null) => void
  /** The controller this screen starts with selected among a snapshot's objects, if any. */
  readonly startingControllerId: (objects: ReadonlyArray<OperationalObject>) => ObjectId | null
  readonly setSeenRevisions: (seen: Map<string, number>) => void
  readonly setSnapshotReady: (ready: boolean) => void
  readonly loadSurfaceForScenario: (scenarioId: string) => Promise<void>
  readonly completeObjectsWhenReady: () => Promise<void>
  readonly connectRealtime: (id: SimulationRunId) => void
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
  config.setSelectedControllerId(config.startingControllerId(snapshot.objects))
  config.setSeenRevisions(new Map(snapshot.objects.map(object => [object.id, object.revision])))
  config.setSnapshotReady(true)
  config.completeStep('snapshot')
  config.setActiveStartupStep('realtime')
  config.connectRealtime(config.response.id)
  config.setActiveStartupStep('map')
  config.startStep('map')
  await config.loadSurfaceForScenario(snapshot.scenario.scenarioId)
  config.setActiveStartupStep('objects')
  await config.completeObjectsWhenReady()
}
