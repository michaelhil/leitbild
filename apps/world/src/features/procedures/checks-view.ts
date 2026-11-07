import { sourceDocumentPathSchema, sourceRevisionSchema } from '@leitbild/contracts'
import { assessmentLeaves } from '@leitbild/procmd'
import { z } from 'zod'
import {
  isoTimestampSchema, procedureRunIdSchema, procedureRunScopeSchema, procedureSourceIdSchema, procedureStepIdSchema,
  type ProcedureDocument, type ProcedureRunState, type ProcedureStep,
} from '../../core/model/index.ts'
import { procedureBranchAssessmentSchema } from '../../core/model/procedure-criteria.ts'
import type { SimulationRunStateSnapshot } from '../../core/simulation-runs/state-store.ts'
import { assessProcedureBranch, readProcedureBranchObservation } from './branch-assessment.ts'
import { readProcedureTags, type ProcedureObservationPort } from './pack-observations.ts'

export const procedureChecksReadInputSchema = z.object({
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  sourceId: procedureSourceIdSchema,
  sourceRevision: sourceRevisionSchema,
  sourcePath: sourceDocumentPathSchema,
  branchIndex: z.number().int().nonnegative().optional(),
}).strict()

export const procedureChecksViewSchema = procedureChecksReadInputSchema.extend({
  plantId: procedureRunScopeSchema.shape.plantId,
  sequence: z.number().int().nonnegative(),
  simulationTime: isoTimestampSchema,
  checks: z.array(procedureBranchAssessmentSchema.pick({ branchIndex: true, status: true, reasons: true, readings: true }).extend({
    /** Conservative simulation-time expiry of the evidence that established this verdict. */
    validThrough: isoTimestampSchema.optional(),
    observation: z.object({ result: z.record(z.string(), z.unknown()) }).strict().optional(),
  })),
}).strict()
export type ProcedureChecksView = z.infer<typeof procedureChecksViewSchema>

export const canInspectProcedureBranchCheck = (step: ProcedureStep, branchIndex: number): boolean => {
  if (step.branches[branchIndex]?.outcome !== 'normal') return false
  const decision = step.decisions?.find(item => item.branchIndex === branchIndex)
  return decision?.observation !== undefined ||
    (decision?.condition !== undefined && assessmentLeaves(decision.condition).every(leaf => leaf.type === 'comparison'))
}

const changed = () => Object.assign(
  new Error('The current procedure step, source, or plant state changed. Read it again before showing live checks.'),
  { status: 409, code: 'procedure_checks_superseded' },
)

/** An advisory read for the exact current step of an active Run, without acquiring branch/CSF or historical proof views. */
export const readProcedureChecks = async (config: {
  readonly input: z.infer<typeof procedureChecksReadInputSchema>
  readonly snapshot: () => Pick<SimulationRunStateSnapshot, 'procedures' | 'clock' | 'seq'>
  readonly canInspect: (plantId: string) => boolean
  readonly document: (run: ProcedureRunState) => Promise<ProcedureDocument>
  readonly observations: (plantId: string) => ProcedureObservationPort
}): Promise<ProcedureChecksView> => {
  const { input } = config
  const selectedRun = (snapshot: ReturnType<typeof config.snapshot>) =>
    snapshot.procedures?.runs.find(run => run.runId === input.runId)
  const run = selectedRun(config.snapshot())
  if (run === undefined) throw Object.assign(new Error('This procedure Run was not found.'), { status: 404, code: 'procedure_run_not_found' })
  const plantId = run.scope.plantId
  const assertInspection = () => {
    if (!config.canInspect(plantId)) throw Object.assign(new Error('This procedure scope is not available to inspect.'), { status: 403, code: 'agent_access_restricted' })
  }
  assertInspection()
  if (run.status !== 'active' || run.currentStepId !== input.stepId || run.sourceId !== input.sourceId ||
      run.sourceRevision !== input.sourceRevision || run.sourcePath !== input.sourcePath) throw changed()
  const document = await config.document(run)
  const before = config.snapshot()
  assertInspection()
  if (selectedRun(before) !== run || document.source.sourceId !== input.sourceId || document.source.revision !== input.sourceRevision ||
      document.sourcePath !== input.sourcePath || document.procedureId !== run.procedureId) throw changed()
  const step = document.steps.find(candidate => candidate.id === input.stepId)
  if (step === undefined) throw Object.assign(new Error('The pinned procedure does not contain the current step.'), { status: 404, code: 'procedure_step_not_found' })

  const requested = new Set(step.pairs?.flatMap(pair => pair.advisoryBranchIndex === undefined ? [] : [pair.advisoryBranchIndex]))
  if (input.branchIndex !== undefined) {
    if (!canInspectProcedureBranchCheck(step, input.branchIndex)) {
      throw Object.assign(new Error('This branch has no deterministic normal check to inspect.'), { status: 400, code: 'procedure_check_not_available' })
    }
    requested.add(input.branchIndex)
  }
  const decisions = step.decisions?.filter(decision => requested.has(decision.branchIndex)) ?? []
  if (decisions.length !== requested.size) throw new Error('A response pair references a missing authored criterion.')
  const tagIds = [...new Set(decisions.flatMap(decision => decision.condition === undefined ? [] : assessmentLeaves(decision.condition)
    .flatMap(leaf => leaf.type === 'comparison' ? [leaf.tagId] : leaf.tagIds)))]
  const port = () => config.observations(plantId)
  const reads = tagIds.length === 0 ? [] : await readProcedureTags({ observations: port, declared: document.tags, tagIds })
  const observations = new Map<number, Awaited<ReturnType<typeof readProcedureBranchObservation>>>()
  for (const decision of decisions) {
    if (decision.observation !== undefined) observations.set(decision.branchIndex, await readProcedureBranchObservation(port, decision.observation))
  }

  const after = config.snapshot()
  assertInspection()
  if (selectedRun(after) !== run || after.seq !== before.seq) throw changed()
  if (after.clock === undefined) throw new Error('Simulation Run clock is not initialized')
  const simulationTime = after.clock.currentTime
  const checks = decisions.map(decision => {
    const { assessment, observationApplies, validThrough } = assessProcedureBranch({
      branchIndex: decision.branchIndex, decision, observation: observations.get(decision.branchIndex), plantId, simulationTime, reads,
    })
    const result = assessment.observation?.result
    return {
      branchIndex: decision.branchIndex, status: assessment.status, reasons: assessment.reasons,
      // Keep caveats for refused evidence without displaying another unit's values.
      readings: assessment.readings.filter(reading => reading.value === undefined || reading.scopeId === plantId),
      ...(observationApplies && result !== undefined ? { observation: { result } } : {}),
      ...(validThrough === undefined ? {} : { validThrough }),
    }
  })
  return procedureChecksViewSchema.parse({ ...input, plantId, sequence: after.seq, simulationTime, checks })
}
