import { limitMaxAgeSeconds } from '@leitbild/procmd'
import type { ActorId, IsoTimestamp, ProcedureDocument, ProcedureRunDriver, ProcedureRunState, ProcedureStep } from '../../core/model/index.ts'
import type { ProcedureBranchAssessment } from '../../core/model/procedure-criteria.ts'
import { procedureCheckedTagIds, procedureReadingProblem, procedureStepAsksPerson } from './branch-assessment.ts'
import type { ProcedureTagRead } from './pack-observations.ts'

// Who may work a procedure Run, and how an AI agent decides on it. An AI
// agent that drives a Run works its current step as the procedure says: it
// selects any declared branch there (a normal, response-not-obtained or
// unknown outcome; to a step, another procedure or END) on a stated basis.
// A person takes over by acting. Explicit placekeeping is distinct from an evidence-backed
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

/** A person-readable basis accompanies authoritative World criteria; optional citations are receipts, not proof. */
export const assertAiStatesBasis = (basis: string | undefined): void => {
  if (basis === undefined) {
    throw new Error('An AI agent selects a branch only with a basis: what the step asks, the values read with units and plant time, and what could not be observed (at most 300 characters).')
  }
}

const askInstead = 'A person decides it: ask with world.procedure.run.request-input.'

/**
 * Why World refuses an AI agent this branch, if it does. A document marked
 * ai-workable lets an AI go on by stated judgement where no limit decides, on
 * valid readings. It stops the AI to ask at a judgement transfer, at the end,
 * and on any answer to a question no limit decides when one answer transfers.
 * Any other document refuses everything its criteria do not support.
 */
export const aiBranchRefusal = (config: {
  readonly document: ProcedureDocument
  readonly step: ProcedureStep
  readonly branchIndex: number
  readonly criterion: ProcedureBranchAssessment
  readonly reads: ReadonlyArray<ProcedureTagRead>
  readonly plantId: string
}): string | undefined => {
  const { document, step, branchIndex, criterion } = config
  const branch = step.branches[branchIndex]!
  const name = `Branch ${branchIndex} of step ${step.label}`
  const marked = document.annotations?.['ai-workable'] === 'true'
  if (marked && (branch.targetKind === 'end' || branch.targetKind === 'abort')) return `${name} ends the procedure. ${askInstead}`
  if (!marked || step.decisions?.some(decision => decision.branchIndex === branchIndex)) {
    return criterion.status === 'supported' ? undefined : `${name} is ${criterion.status}: ${criterion.reasons.join(' ') || 'the current evidence contradicts its declared criterion'}`
  }
  if (branch.targetKind === 'procedure') return `${name} transfers on judgement, with no limit stated. ${askInstead}`
  if (procedureStepAsksPerson(step)) return `${name} answers a question no limit decides, and another answer leaves the procedure. ${askInstead}`
  const checked = procedureCheckedTagIds(step)
  const problems = config.reads.filter(read => checked.includes(read.tagId)).flatMap(read => procedureReadingProblem(read, read.tagId, { simulationTime: criterion.simulationTime, plantId: config.plantId, maxAgeSeconds: limitMaxAgeSeconds }) ?? [])
  return problems.length === 0 ? undefined : `${name} rests on readings that are not valid: ${problems.join(' ')}`
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
