import type { ActorId, IsoTimestamp, ProcedureRunDriver, ProcedureRunState, ProcedureStep } from '../../core/model/index.ts'
import type { ProcedureTagRead } from './pack-observations.ts'

// Who may work a procedure Run, and how an AI agent decides on it. An AI
// agent that drives a Run works its current step as the procedure says: it
// selects any declared branch there (a normal, response-not-obtained or
// unknown outcome; to a step, another procedure or END) on a stated basis,
// citing the step's tags World reads now wherever any of them reads. A person
// takes over by acting. Explicit placekeeping is distinct from an evidence-backed
// branch decision; World enforces ownership and document validity at commit.

/** Who issues a procedure command: an AI agent, a person, or the Run itself (its Scenario timeline). */
export type ProcedureActorKind = 'ai' | 'person' | 'system'

/** An AI agent selects a branch only of its Run's current step. */
export const assertAiWorksCurrentStep = (run: Pick<ProcedureRunState, 'currentStepId'>, step: ProcedureStep): void => {
  if (run.currentStepId === step.id) return
  throw new Error(`Step ${step.label} is not the run's current step${run.currentStepId === undefined ? '' : ` (${run.currentStepId})`}: an AI agent works only the current step; read it with world.procedure.run.step.read.`)
}

const runName = (run: ProcedureRunState): string => `${run.procedureId} on ${run.scope.label ?? run.scope.plantId}`

const drivenBy = (run: ProcedureRunState, driver: ProcedureRunDriver): Error => driver.kind === 'person'
  ? new Error(`A person${driver.label === undefined ? '' : ` (${driver.label})`} drives ${runName(run)} since ${driver.since}: an AI agent only reads it until a person hands it back. Report where the procedure stands and what you would do next.`)
  : new Error(`${driver.label ?? driver.actorId}, another AI agent, drives ${runName(run)} since ${driver.since}: an AI agent changes it only after that agent or a person releases it.`)

/** An AI agent may take a Run nobody drives or one it drives already. */
export const assertAiMayDrive = (run: ProcedureRunState, actorId: ActorId): void => {
  if (run.driver === undefined || (run.driver.kind === 'ai' && run.driver.actorId === actorId)) return
  throw drivenBy(run, run.driver)
}

/** An AI agent changes only a Run it drives. */
export const assertAiDrives = (run: ProcedureRunState, actorId: ActorId): void => {
  if (run.driver === undefined) {
    throw new Error(`Nobody drives ${runName(run)}: claim it with world.procedure.run.drive {"runId":"${run.runId}","action":"claim"} before changing it.`)
  }
  assertAiMayDrive(run, actorId)
}

/**
 * An AI agent's selection rests on a stated basis and, wherever the step's
 * tags read on the plant now, on those it relied on, each read by World now.
 * `readableStepTagIds`: the step's tags that read now, read for a selection
 * that cites none.
 */
export const assertAiDecisionEvidence = (config: {
  readonly step: ProcedureStep
  readonly basis?: string
  readonly evidenceTagIds?: ReadonlyArray<string>
  readonly reads: ReadonlyArray<ProcedureTagRead>
  readonly readableStepTagIds?: ReadonlyArray<string>
}): void => {
  const { step } = config
  if (config.basis === undefined) {
    throw new Error('An AI agent selects a branch only with a basis: what the step asks, the values read with units and plant time, and what could not be observed (at most 300 characters).')
  }
  if (config.evidenceTagIds === undefined) {
    if (step.tagIds.length === 0) return
    if (config.readableStepTagIds === undefined) throw new Error('This transition was prepared without its actor, so the step\'s tags were not read: an AI agent\'s selection cannot be checked.')
    if (config.readableStepTagIds.length === 0) return
    throw new Error(`Step ${step.label}'s ${config.readableStepTagIds.map(tagId => `«${tagId}»`).join(', ')} ${config.readableStepTagIds.length === 1 ? 'reads' : 'read'} on this plant now: cite those you relied on as evidenceTagIds (1 to 6); World reads them and records the readings with the decision.`)
  }
  for (const read of config.reads) {
    if (read.binding === 'missing') throw new Error(`«${read.tagId}» has no binding on this Plant: cite only tags World reads now, and say in the basis what is not observable.`)
    if (read.value === undefined) throw new Error(`«${read.tagId}» could not be read (${read.unavailable ?? 'no value'}): cite only tags World reads now, and say in the basis what is not observable.`)
  }
}

export const procedureDriver = (config: {
  readonly kind: 'ai' | 'person'
  readonly actorId: ActorId
  readonly label?: string
  readonly since: IsoTimestamp
}): ProcedureRunDriver => ({
  kind: config.kind,
  actorId: config.actorId,
  ...(config.label === undefined ? {} : { label: config.label }),
  since: config.since,
})

export const sameProcedureDriver = (left: ProcedureRunDriver | undefined, right: ProcedureRunDriver | undefined): boolean =>
  left?.kind === right?.kind && left?.actorId === right?.actorId
