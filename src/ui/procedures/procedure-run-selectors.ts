import type {
  ProcedureBranch,
  ProcedureDocument,
  ProcedureId,
  ProcedureRunScope,
  ProcedureRunState,
  ProcedureSourceId,
  ProcedureStep,
} from '../../core/model/index.ts'

export type ProcedureRunVisualState = 'idle' | 'active' | 'completed'

export interface ProcedureRunStepProgress {
  readonly label: string
  readonly name: string
}

export interface ProcedureRunSummary {
  readonly run: ProcedureRunState
  readonly procedureId: ProcedureId
  readonly title: string
  readonly status: Extract<ProcedureRunState['status'], 'active' | 'completed'>
  readonly step: ProcedureRunStepProgress | null
}

export const sameProcedureScope = (
  left: ProcedureRunScope,
  right: ProcedureRunScope,
): boolean =>
  left.systemId === right.systemId
    && left.targetObjectId === right.targetObjectId

export const procedureStepDisplayName = (step: ProcedureStep): string => {
  const fallback = `Step ${step.label}`
  return step.title.trim() === fallback ? step.id : step.title
}

export const procedureStepHoverLabel = (step: ProcedureStep): string =>
  `Step ${step.label}: ${procedureStepDisplayName(step)}`

export const procedureStepById = (
  document: ProcedureDocument,
  stepId: string,
): ProcedureStep | null =>
  document.steps.find(step => step.id === stepId) ?? null

export const procedureFirstStep = (
  document: ProcedureDocument,
): ProcedureStep | null =>
  document.steps[0] ?? null

export const procedureStepReferenceText = (
  document: ProcedureDocument,
  step: ProcedureStep,
): string =>
  `${document.procedureId}, step ${step.label}: ${procedureStepDisplayName(step)}`

export const procedureBranchActionText = (config: {
  readonly currentDocument: ProcedureDocument
  readonly branch: ProcedureBranch
  readonly targetDocument?: ProcedureDocument
}): string => {
  if (config.branch.targetKind === 'step') {
    const targetStep = procedureStepById(config.currentDocument, config.branch.target)
    return targetStep
      ? `Go to ${procedureStepReferenceText(config.currentDocument, targetStep)}`
      : `Go to ${config.currentDocument.procedureId}, step ?: ${config.branch.target}`
  }

  if (config.branch.targetKind === 'procedure') {
    const targetStep = config.targetDocument ? procedureFirstStep(config.targetDocument) : null
    return targetStep && config.targetDocument
      ? `Go to ${procedureStepReferenceText(config.targetDocument, targetStep)}`
      : `Go to ${config.branch.target}, step 1`
  }

  return config.branch.target
}

export const procedureRunFor = (
  runs: ReadonlyArray<ProcedureRunState>,
  config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): ProcedureRunState | null => {
  const candidates = runs.filter(run =>
    run.procedureId === config.procedureId
      && (config.sourceId === undefined || run.sourceId === config.sourceId)
      && sameProcedureScope(run.scope, config.scope),
  )
  return candidates.find(run => run.status === 'active')
    ?? candidates.find(run => run.status === 'completed')
    ?? null
}

export const procedureRunVisualStateFor = (
  runs: ReadonlyArray<ProcedureRunState>,
  config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): ProcedureRunVisualState => {
  const run = procedureRunFor(runs, config)
  if (run?.status === 'active') return 'active'
  if (run?.status === 'completed') return 'completed'
  return 'idle'
}

export const completedStepCount = (run: ProcedureRunState): number =>
  run.stepStates.filter(step => step.assessment === 'complete').length

export const furthestTouchedStep = (
  run: ProcedureRunState,
  document: ProcedureDocument | undefined,
): ProcedureRunStepProgress | null => {
  const touchedStepIds = new Set(run.stepStates
    .filter(step => step.assessment !== 'blank')
    .map(step => step.stepId))
  if (touchedStepIds.size === 0) return null
  if (!document) {
    const lastTouched = findLast(run.stepStates, step => step.assessment !== 'blank')
    return lastTouched ? { label: lastTouched.stepId, name: lastTouched.stepId } : null
  }
  const furthest = findLast(document.steps, step => touchedStepIds.has(step.id))
  return furthest
    ? { label: furthest.label, name: procedureStepDisplayName(furthest) }
    : null
}

export const procedureRunSummaryFor = (
  run: ProcedureRunState,
  document: ProcedureDocument | undefined,
): ProcedureRunSummary | null => {
  if (run.status !== 'active' && run.status !== 'completed') return null
  return {
    run,
    procedureId: run.procedureId,
    title: document?.title ?? run.title,
    status: run.status,
    step: furthestTouchedStep(run, document),
  }
}

export const procedureRunSummariesForScope = (
  runs: ReadonlyArray<ProcedureRunState>,
  scope: ProcedureRunScope,
  documents: ReadonlyMap<ProcedureId, ProcedureDocument>,
): {
  readonly active: ReadonlyArray<ProcedureRunSummary>
  readonly completed: ReadonlyArray<ProcedureRunSummary>
} => {
  const summaries = runs
    .filter(run => sameProcedureScope(run.scope, scope))
    .map(run => procedureRunSummaryFor(run, documents.get(run.procedureId)))
    .filter((summary): summary is ProcedureRunSummary => summary !== null)
  return {
    active: summaries.filter(summary => summary.status === 'active'),
    completed: summaries.filter(summary => summary.status === 'completed'),
  }
}

export const procedureRunSummaryText = (summary: ProcedureRunSummary): string =>
  `${summary.procedureId}:${summary.step?.label ?? '-'}`

export const procedureRunSummaryTitle = (summary: ProcedureRunSummary): string =>
  `${summary.procedureId} - ${summary.title}\nStep ${summary.step?.label ?? '-'}: ${summary.step?.name ?? 'not started'}`

const findLast = <T>(
  values: ReadonlyArray<T>,
  predicate: (value: T) => boolean,
): T | undefined => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && predicate(value)) return value
  }
  return undefined
}
