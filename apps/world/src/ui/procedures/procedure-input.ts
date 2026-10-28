import { sameProcedureScope } from '../../core/model/index.ts'
import type { ObjectId, ProcedureDocument, ProcedureRunScope, ProcedureRunState, SimulationRunId } from '../../core/model/index.ts'
import { procedureRunDocumentKey } from './procedure-run-selectors.ts'
import type { ProcedureSession } from './procedure-session.ts'

export interface ProcedureInputFocus {
  readonly simulationRunId: SimulationRunId
  readonly runId: ProcedureRunState['runId']
  readonly sourceId: ProcedureRunState['sourceId']
  readonly sourcePath: ProcedureRunState['sourcePath']
  readonly procedureId: ProcedureRunState['procedureId']
  readonly requestId: NonNullable<ProcedureRunState['inputRequest']>['requestId']
  readonly stepId: NonNullable<ProcedureRunState['inputRequest']>['stepId']
  readonly sourceRevision: ProcedureRunState['sourceRevision']
}

export interface ProcedureInputView {
  readonly key: string
  readonly objectId: ObjectId
  readonly unit: string
  readonly run: ProcedureRunState
  readonly focus: ProcedureInputFocus
  readonly issue: string
  readonly stepLabel?: string
}

export const currentProcedureInput = (run: ProcedureRunState): boolean => run.status === 'active'
  && run.driver?.kind === 'ai' && run.inputRequest !== undefined
  && run.inputRequest.requestedBy === run.driver.actorId && run.inputRequest.stepId === run.currentStepId

export const procedureInputFocusFor = (simulationRunId: SimulationRunId, run: ProcedureRunState): ProcedureInputFocus | null => {
  if (!currentProcedureInput(run)) return null
  const request = run.inputRequest!
  return { simulationRunId, runId: run.runId, sourceId: run.sourceId, sourcePath: run.sourcePath, procedureId: run.procedureId, requestId: request.requestId, stepId: request.stepId, sourceRevision: run.sourceRevision }
}

/** Only the current driver-authored request in a visible unit can ask for attention. */
export const procedureInputViews = (
  simulationRunId: SimulationRunId,
  runs: ReadonlyArray<ProcedureRunState>,
  documents: ReadonlyMap<string, ProcedureDocument>,
  units: ReadonlyArray<{ readonly objectId: ObjectId; readonly label: string; readonly scope: ProcedureRunScope }>,
): ReadonlyArray<ProcedureInputView> => runs.flatMap(run => {
  if (!currentProcedureInput(run)) return []
  const unit = units.find(candidate => sameProcedureScope(candidate.scope, run.scope))
  if (!unit) return [] // Hidden or withdrawn unit: never expose its request through a stale UI row.
  const request = run.inputRequest!, document = documents.get(procedureRunDocumentKey(run))
  const step = document?.steps.find(candidate => candidate.id === request.stepId)
  return [{
    key: JSON.stringify([simulationRunId, run.runId, run.sourceId, run.sourceRevision, run.sourcePath, request.requestId]),
    objectId: unit.objectId, unit: unit.label, run, issue: request.issue,
    focus: procedureInputFocusFor(simulationRunId, run)!,
    ...(step ? { stepLabel: step.label } : {}),
  }]
})

/** Recheck at activation and after async document loading; an old popup never retargets another step. */
export const resolveProcedureInputFocus = (
  runs: ReadonlyArray<ProcedureRunState>, focus: ProcedureInputFocus, scope: ProcedureRunScope, simulationRunId: SimulationRunId,
): ProcedureRunState | null => focus.simulationRunId !== simulationRunId ? null : runs.find(run => currentProcedureInput(run)
  && run.runId === focus.runId && run.sourceRevision === focus.sourceRevision
  && run.sourceId === focus.sourceId && run.sourcePath === focus.sourcePath && run.procedureId === focus.procedureId
  && run.inputRequest?.requestId === focus.requestId && run.inputRequest.stepId === focus.stepId
  && sameProcedureScope(run.scope, scope)) ?? null

/** Refresh current truth before reading the retained document. Recheck after
 * the async read, so an answered request never navigates to a later step. */
export const readProcedureInputTarget = async (
  session: Pick<ProcedureSession, 'snapshot' | 'refreshRuns' | 'readDocument'>,
  focus: ProcedureInputFocus, scope: ProcedureRunScope, simulationRunId: SimulationRunId,
): Promise<ProcedureRunState | null> => {
  const current = () => resolveProcedureInputFocus(session.snapshot().runs, focus, scope, simulationRunId)
  if (!current()) return null
  await session.refreshRuns()
  const run = current()
  if (!run) return null
  const document = await session.readDocument(run)
  if (!current()) return null
  if (document.source.sourceId !== focus.sourceId || document.source.revision !== focus.sourceRevision
    || document.sourcePath !== focus.sourcePath || document.procedureId !== focus.procedureId) throw new Error('Retained procedure document does not match the input request')
  if (!document.steps.some(step => step.id === focus.stepId)) throw new Error('Requested input step is absent from the retained procedure revision')
  return current()
}
