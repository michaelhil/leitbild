import { z } from 'zod'
import {
  commandResultSchema,
  deleteObjectCommandKind,
  deleteObjectPayloadSchema,
  objectIdSchema,
  procedureRunCloseCommandKind,
  procedureRunClosePayloadSchema,
  procedureRunDriveCommandKind,
  procedureRunDrivePayloadSchema,
  procedureRunRequestInputCommandKind,
  procedureRunRequestInputPayloadSchema,
  procedureRunResetCommandKind,
  procedureRunResetPayloadSchema,
  procedureRunStartCommandKind,
  procedureRunStartPayloadSchema,
  procedureRunTransitionCommandKind,
  procedureRunTransitionPayloadSchema,
  procedureStepUpdateCommandKind,
  procedureStepUpdatePayloadSchema,
  type ObjectId,
} from '../core/model/index.ts'
import { procedureStepViewSchema } from '../features/procedures/step-view.ts'
import { procedureTransitionDecisionSchema } from '../features/procedures/transition-receipt.ts'
import { defineSimulationCapability } from './capabilities.ts'
import type { SimulationCapability } from './protocol.ts'

const command = <T>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType<T>
  readonly targets: (input: T) => ReadonlyArray<ObjectId>
  readonly risk?: 'write' | 'destructive'
  readonly schedulable?: boolean
  /** A result that says more than accepted or refused; the core result where absent. */
  readonly output?: z.ZodType
}): SimulationCapability => defineSimulationCapability({
  id: config.id,
  kind: 'command',
  title: config.title,
  description: config.description,
  risk: config.risk ?? 'write',
  idempotent: false,
  ...(config.schedulable === undefined ? {} : { schedulable: config.schedulable }),
  input: config.input,
  output: config.output ?? commandResultSchema,
  buildCommand: raw => {
    const input = config.input.parse(raw)
    return { targetObjectIds: config.targets(input), payload: input }
  },
})

/** Accepted for an AI agent, it carries the step the transition leads to (as step.read returns it), or why that read failed. */
/** A start's pin, for every caller; for an AI agent also the first step, as step.read returns it. */
const procedureStartResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({
    pinned: z.object({ runId: z.string(), sourceId: z.string(), sourceRevision: z.string(), sourcePath: z.string() }).strict().optional(),
    next: procedureStepViewSchema.optional(),
    nextUnavailable: z.string().optional(),
  }),
  commandResultSchema.options[1],
])

const procedureStepResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({ next: procedureStepViewSchema.optional(), nextUnavailable: z.string().optional() }),
  commandResultSchema.options[1],
])

const procedureTransitionResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({ decision: procedureTransitionDecisionSchema, next: procedureStepViewSchema.optional(), nextUnavailable: z.string().optional() }),
  commandResultSchema.options[1],
])

export const worldCoreCapabilities: ReadonlyArray<SimulationCapability> = [
  command({
    id: deleteObjectCommandKind,
    title: 'Delete operational object',
    description: 'Deletes one current operational object from this Simulation Run.',
    input: deleteObjectPayloadSchema,
    targets: input => [input.objectId],
    risk: 'destructive',
    schedulable: true,
  }),
  command({
    id: procedureRunStartCommandKind,
    title: 'Start procedure run',
    description: 'Input {procedureId, scope: {plantId, label?}, sourceId?, sourceRevision?}. Starts a procedure for an explicit operational scope, pinned to a source revision, or resumes a transferred procedure at its preserved step. Without sourceId and sourceRevision it starts from the Run\'s procedure source at its current publication (name sourceId where the Run has several); the result names the pinned run, source, revision and path. Completed or abandoned procedures require an explicit reset. An AI agent that starts or resumes a procedure drives it (see world.procedure.run.drive), and the result carries next: its current step, as world.procedure.run.step.read returns it; it cannot resume one someone else drives.',
    input: procedureRunStartPayloadSchema,
    output: procedureStartResultSchema,
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
  command({
    id: procedureStepUpdateCommandKind,
    title: 'Update procedure step',
    description: 'Records an assessment, note, favorite, or current-step change in an active procedure run. A person ticking a step or moving the current step of a run an AI agent drives takes it over. An AI agent changes only a run it drives. A requested manual assessment or current-step change is placekeeping, not measured confirmation; autonomous procedure work answers through evidence-backed world.procedure.run.transition.',
    input: procedureStepUpdatePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunTransitionCommandKind,
    title: 'Follow procedure branch',
    description: 'Input {runId, stepId, branchIndex, basis?, evidenceTagIds?}. Atomically follows a declared local-step, procedure, retry, END, or ABORT branch from the pinned document. Records the chosen branch, who chose it, an optional basis (at most 300 characters) and the step\'s declared tags as evidenceTagIds, which World reads now on the run\'s plant and records with the decision. A procedure transfer preserves source placekeeping and hands the run\'s driver on; an explicitly parallel branch keeps it active. Only authored outcome labels change step assessment. Read the step (world.procedure.run.step.read) to select stepId and branchIndex. An AI agent selects on a run it drives only a branch whose authored criterion World supports on fresh evidence at commit; unestablished or contradicted criteria are refused with structured assessment details. Read step.branchAssessments first. It works its current step (a normal, RNO or unknown outcome; to a step, another procedure or END), always with a basis, with optional evidenceTagIds for any additional cited readings: each explicit citation must name a readable tag; the complete criterion proof is acquired and retained by World independently. A person selecting a branch off the current step of a run an AI agent drives takes it over. Every accepted result carries decision: the exact committed branch event and its pinned source Run identity, including the selected step\'s criterion proof. This is historical evidence, distinct from next. Accepted for an AI agent, the result also carries next: the step the run is now at, as step.read returns it; after a transfer, the destination\'s current step, which it now drives (the run alone after END).',
    input: procedureRunTransitionPayloadSchema,
    output: procedureTransitionResultSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunCloseCommandKind,
    title: 'Close procedure run',
    description: 'Completes or abandons an active procedure run. An AI agent closes only a run it drives; a person closing a run an AI agent drives takes it over.',
    input: procedureRunClosePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunDriveCommandKind,
    title: 'Drive procedure run',
    description: 'Input {runId, action: "claim" | "release"}. Claims or releases driving an active procedure run, so the procedure window shows who works it. An AI agent claims a run nobody drives (or one it drives already) and must drive a run to change it; a person\'s claim takes over at once, and a person also takes over by ticking a step, jumping, closing it or selecting a branch off its current step. While a person drives, AI agents only read it. Release makes the run shared again: the driver or a person releases; only then may an AI agent claim it. An accepted AI claim carries next, the current step of the exact claimed run; release does not.',
    input: procedureRunDrivePayloadSchema,
    output: procedureStepResultSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunRequestInputCommandKind,
    title: 'Request procedure input',
    description: 'Input {runId, stepId, issue}. The current AI driver names the precise human judgement, field report or missing input it needs at its current step (issue at most 500 characters). Records a durable request without changing the step or clock. The procedure window shows it until the step is answered, changed, closed or handed over; dismissal only hides its notification. Identical pending requests do not repeat. Accepted for the AI driver, the result carries next with the exact pending request and step. Never request input merely because an observation is unknown when an authored branch or a readable signal settles it.',
    input: procedureRunRequestInputPayloadSchema,
    output: procedureStepResultSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunResetCommandKind,
    title: 'Reset procedure run',
    description: 'Clears current procedure state for an explicit operational scope. An AI agent resets only on an explicit operator request; it must drive an active run and cannot override another driver. A reset is placekeeping, not proof of physical conditions. Completed or abandoned state may be reset without an active driver.',
    input: procedureRunResetPayloadSchema,
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
]
