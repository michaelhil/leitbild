import { z } from 'zod'
import { idSchema, objectIdSchema, type IsoTimestamp } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { evaluateProcessPlantAssessments } from '../assessments.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { rejectCapabilityInput, rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { validateOperatorWrite } from '../operations/command-guard.ts'
import { plantControlsFor } from '../operations/controls.ts'
import { listedControlsFor, listedResetsFor, proposalPortsFor } from '../operations/instance-ports.ts'
import { reviewProposal } from '../operations/proposals.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantSignalReferenceSchema, readableProcessPlantSignalBinding, refuseInjectedFaultsIn } from '../signals.ts'
import { requirePlant } from './common.ts'
import { evaluateProcessPlantProcedureCondition, processPlantProcedureBasisSchema, processPlantProcedureConditionSchema } from '../condition-evidence.ts'

export const procedureConditionEvaluateQuerySchema = z.object({
  targetObjectId: objectIdSchema,
  condition: processPlantProcedureConditionSchema,
  basis: processPlantProcedureBasisSchema,
}).strict()

export const conditionsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  condition: processPlantIcConditionSchema,
}).strict()

export const assessmentsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  /** The critical safety functions to judge, by id; every one the Plant declares when absent. */
  assessmentIds: z.array(z.string().min(1)).min(1).optional(),
  /** Current status-board projection, or the complete tree and deciding values. */
  detail: z.enum(['full', 'summary']).default('full'),
}).strict()

export const processPlantControlQueryKinds = [
  'world.process-plant.procedure-condition.evaluate',
  'world.process-plant.conditions.evaluate',
  'world.process-plant.assessments.evaluate',
  'world.process-plant.control.validate',
  'world.process-plant.control.proposals',
  'world.process-plant.controls.list',
] as const

export const controlProposalsQuerySchema = z.object({
  plantId: idSchema,
  /** The proposals to read, by id; every one the Plant holds when absent (its pending ones and the last closed ones). */
  proposalIds: z.array(z.string().min(1)).min(1).max(64).optional(),
}).strict()

export const controlsListQuerySchema = z.object({
  plantId: idSchema,
  /** The drawn items to list, by the id an agent names them by ("pressurizer.blockValve"); every one when absent. */
  items: z.array(z.string().min(1)).min(1).max(64).optional(),
  /** Exact command bindings, independent of the drawn equipment carrying their controls. */
  commands: z.array(processPlantSignalReferenceSchema).min(1).optional(),
}).strict().superRefine((payload, ctx) => {
  if (payload.items !== undefined && payload.commands !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'controls.list accepts items or commands, not both' })
  }
})

export const answerProcessPlantControlQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly simulationTime?: IsoTimestamp
}): unknown | undefined => {
  if (!processPlantControlQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.procedure-condition.evaluate') {
    const payload = procedureConditionEvaluateQuerySchema.parse(config.request.input)
    const plant = requirePlant(config.plants, payload.targetObjectId)
    refuseInjectedFaultsIn(plant.plant.graph, payload.condition)
    return { targetObjectId: payload.targetObjectId, ...evaluateProcessPlantProcedureCondition({ plant, condition: payload.condition, basis: payload.basis, ...(config.simulationTime === undefined ? {} : { simulationTime: config.simulationTime }) }) }
  }
  if (config.request.capabilityId === 'world.process-plant.conditions.evaluate') {
    const payload = conditionsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    refuseInjectedFaultsIn(system.plant.graph, payload.condition)
    const evaluation = evaluateProcessPlantIcCondition({
      system: system.plant,
      runtime: system.runtime,
      condition: payload.condition,
    })
    return {
      plantId: payload.plantId,
      matches: evaluation.matches,
      signalsRead: evaluation.signalsRead,
    }
  }
  if (config.request.capabilityId === 'world.process-plant.assessments.evaluate') {
    const payload = assessmentsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const assessments = evaluateProcessPlantAssessments(system, payload.assessmentIds, payload.detail)
    return {
      plantId: payload.plantId,
      detail: payload.detail,
      assessments,
      ...(payload.detail === 'summary' ? { inspect: {
        capabilityId: 'world.process-plant.assessments.evaluate',
        input: { plantId: payload.plantId, ...(assessments.length === 0 ? {} : { assessmentIds: assessments.map(row => String(row.id)) }), detail: 'full' },
      } } : {}),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.control.proposals') {
    const payload = controlProposalsQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    if (system.operations === undefined) return rejectCapabilityTarget(`Process Plant ${payload.plantId} keeps no operations record`)
    const held = system.operations.book().proposals
    const unknown = (payload.proposalIds ?? []).filter(id => !held.some(proposal => proposal.id === id))
    if (unknown.length > 0) return rejectCapabilityTarget(`No proposal ${unknown.join(', ')} on Process Plant ${payload.plantId}; it holds ${held.map(proposal => proposal.id).join(', ') || 'none'}`)
    // A pending proposal is reviewed as a person or an agent would act on it now.
    const ports = proposalPortsFor(system, undefined)
    // Each names its drawn item by the item's label, as a person reads it there (W7.4: labels, not ids).
    const labels = new Map(plantControlsFor(system.plant).items.map(item => [item.id, item.label]))
    const labelOf = (item: string): string => {
      const label = labels.get(item)
      if (label === undefined) throw new Error(`A proposal names ${item}, which Process Plant ${payload.plantId} does not draw`)
      return label
    }
    return {
      plantId: payload.plantId,
      plantElapsedMs: system.runtime.elapsedMs(),
      proposals: held
        .filter(proposal => payload.proposalIds === undefined || payload.proposalIds.includes(proposal.id))
        .map(proposal => ({ proposal, label: labelOf(proposal.item), ...(proposal.status === 'pending' ? { review: reviewProposal(proposal, ports) } : {}) })),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.controls.list') {
    const payload = controlsListQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const commandPaths = payload.commands === undefined ? undefined : new Set(payload.commands.map(reference => {
      const binding = readableProcessPlantSignalBinding(system.plant.graph, reference)
      if (!binding.writable || binding.actuation !== 'command') {
        return rejectCapabilityInput(`${binding.tagId ?? binding.path} (${binding.path}) is not a writable Plant command. Discover command bindings with world.process-plant.signals.search using writable:true; feedback readings are not commands.`)
      }
      return binding.path
    }))
    if (commandPaths !== undefined) {
      const declared = plantControlsFor(system.plant).items
      for (const path of commandPaths) {
        if (!declared.some(item => item.offered.some(control => control.path === path) || item.withheld.some(control => control.path === path))) {
          return rejectCapabilityTarget(`Plant command ${path} has no offered or withheld control on Process Plant ${payload.plantId}; no other command or control item was substituted.`)
        }
      }
    }
    const items = listedControlsFor(system, payload.items, commandPaths)
    const missing = (payload.items ?? []).filter(id => !items.some(item => item.id === id))
    if (missing.length > 0) {
      // A rejected guess should lead to canonical discovery, not another guess
      // or a dump of every control's live options and configuration.
      const identities = plantControlsFor(system.plant).items.map(item => ({ id: item.id, label: item.label }))
      return rejectCapabilityTarget(`Process Plant ${payload.plantId} has no item ${missing.join(', ')}. Select exact ids from these declared control-item identities: ${JSON.stringify(identities)}`)
    }
    let resets = listedResetsFor(system)
    if (commandPaths !== undefined) {
      const offered = items.flatMap(item => item.offered.map(entry => entry.control))
      const heldPaths = new Set([...commandPaths, ...offered.flatMap(control => control.isolation === undefined ? [] : [control.isolation])])
      const relatedRules = new Set(offered.flatMap(control => control.options.flatMap(option => [...option.consequences, ...option.opposing].map(rule => rule.ruleId))))
      // A reset follows the selected command or its declared I&C relations,
      // including an isolation input held elsewhere; owner proximity is not evidence.
      resets = resets.filter(reset => reset.holds.some(path => heldPaths.has(path)) || relatedRules.has(reset.ruleId))
    }
    return { plantId: payload.plantId, plantElapsedMs: system.runtime.elapsedMs(), items, resets }
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  // As a person's or an AI agent's write: the Run's own writes are not previewed.
  return validateOperatorWrite({
    system: system.plant,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
    origin: undefined,
  })
}
