import { z } from 'zod'
import { commandResultSchema, idSchema, objectIdSchema, type ObjectId } from '../../core/model/index.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { configurationOutputSchema } from './config-schema.ts'
import { intentFields } from './engine/intents.ts'
import { unitOrderInputSchema, unitPlanReorderInputSchema, unitRecallInputSchema, unitStopRemoveInputSchema, unitUndoInputSchema } from './order-schema.ts'
import { einsatzPlanningCapability } from './planning-source.ts'
import { recommendAnswerSchema } from './recommendation-schema.ts'
import { situationInputSchema, situationSchema, unitOptionsInputSchema, unitOptionsSchema } from './situation/schema.ts'
import { stepTargetId } from './steps.ts'

/**
 * The Einsatz Capabilities: five queries and twelve commands. Commands are
 * validated against the current state when they commit, never against a
 * token: a refusal reads `<code>: <message>` in the configuration's own
 * words and sets `code`. Every command is schedulable from the Scenario
 * timeline; in a Run that declares roles, creating units and tasks and
 * adjusting property values are controller-only.
 *
 * Every unit carries out a plan of stops (`orders`, see `steps.ts`):
 * `unit.order` gives it one, all or nothing; `unit.stop.remove` takes one
 * stop out; `unit.undo` takes an order back while none of it has been
 * carried out; `unit.recall` empties the plan and brings the unit home. An
 * accepted command answers with its `commandId`, which `unit.undo` names.
 */

export const einsatzCommandIds = {
  order: 'world.einsatz.unit.order',
  stopRemove: 'world.einsatz.unit.stop.remove',
  planReorder: 'world.einsatz.unit.plan.reorder',
  undo: 'world.einsatz.unit.undo',
  recall: 'world.einsatz.unit.recall',
  taskClose: 'world.einsatz.task.close',
  siteSet: 'world.einsatz.site.set',
  taskCreate: 'world.einsatz.task.create',
  unitCreate: 'world.einsatz.unit.create',
  unitAdjust: 'world.einsatz.unit.adjust',
  setRoe: 'world.einsatz.unit.set-roe',
  engage: 'world.einsatz.unit.engage',
} as const
export const einsatzQueryIds = {
  situation: 'world.einsatz.situation',
  recommend: 'world.einsatz.recommend',
  unitOptions: 'world.einsatz.unit.options',
  configuration: 'world.einsatz.configuration',
  planningBasis: einsatzPlanningCapability.id,
} as const

export const commandInputSchemas = {
  [einsatzCommandIds.order]: unitOrderInputSchema,
  [einsatzCommandIds.stopRemove]: unitStopRemoveInputSchema,
  [einsatzCommandIds.planReorder]: unitPlanReorderInputSchema,
  [einsatzCommandIds.undo]: unitUndoInputSchema,
  [einsatzCommandIds.recall]: unitRecallInputSchema,
  [einsatzCommandIds.taskClose]: z.object(intentFields.taskClose).strict(),
  [einsatzCommandIds.siteSet]: z.object(intentFields.siteSet).strict(),
  [einsatzCommandIds.taskCreate]: z.object(intentFields.taskCreate).strict(),
  [einsatzCommandIds.unitCreate]: z.object({ ...intentFields.unitCreate, label: intentFields.unitCreate.label.optional().describe('The unit\'s label; without one, the type\'s label and the next free number.') }).strict(),
  [einsatzCommandIds.unitAdjust]: z.object(intentFields.unitAdjust).strict(),
  [einsatzCommandIds.setRoe]: z.object(intentFields.setRoe).strict(),
  [einsatzCommandIds.engage]: z.object(intentFields.engage).strict(),
}
export type EinsatzCommandId = keyof typeof commandInputSchemas
export type CommandInput<K extends EinsatzCommandId> = z.output<typeof commandInputSchemas[K]>

export const isEinsatzCommand = (kind: string): kind is EinsatzCommandId => Object.hasOwn(commandInputSchemas, kind)

export const recommendInputSchema = z.object({ taskId: idSchema.describe('The task to recommend units for, as world.einsatz.situation lists it.') }).strict()

/** How an agent searching the Workspace finds the dispatch surface: Pack-owned words, never a domain's. */
const dispatchTerms = ['dispatch', 'send', 'assign', 'respond', 'transport', 'deliver', 'status', 'what is running'] as const

const objectIds = (...ids: ReadonlyArray<string>): ReadonlyArray<ObjectId> => ids.map(id => objectIdSchema.parse(id))

const command = <K extends EinsatzCommandId>(config: {
  readonly id: K
  readonly title: string
  readonly description: string
  readonly searchTerms: ReadonlyArray<string>
  readonly idempotent: boolean
  readonly targets: (input: CommandInput<K>) => ReadonlyArray<ObjectId>
}): SimulationCapability => defineSimulationCommandCapability({
  id: config.id,
  title: config.title,
  description: config.description,
  searchTerms: config.searchTerms,
  input: commandInputSchemas[config.id],
  output: commandResultSchema,
  idempotent: config.idempotent,
  schedulable: true,
  historyObjectIds: raw => {
    if (config.id === einsatzCommandIds.order) {
      const payload = commandInputSchemas[einsatzCommandIds.order].parse(raw)
      return objectIds(...payload.stops.flatMap(stop => [stepTargetId(stop)].filter((id): id is string => id !== undefined)), ...(payload.drops === undefined ? [] : [payload.drops]))
    }
    if (config.id === einsatzCommandIds.engage) return objectIds(commandInputSchemas[einsatzCommandIds.engage].parse(raw).trackId)
    return [] // The remaining commands name only their mutation target.
  },
  buildCommand: raw => {
    const payload = commandInputSchemas[config.id].parse(raw) as CommandInput<K>
    return { targetObjectIds: config.targets(payload), payload }
  },
})

export const einsatzCapabilities: ReadonlyArray<SimulationCapability> = [
  einsatzPlanningCapability,
  defineSimulationQueryCapability({
    readScope: 'collection',
    id: einsatzQueryIds.situation,
    title: 'What is running in the dispatch simulation',
    description: 'What is running now in the dispatch simulation. Open calls (called *tasks*; the configured words are in `words`) are ranked by priority, with waiting time, needs, coverage and assigned units. Every unit has its type, group, status, plan with ETAs, predicted delivery and the actor of its last order. Sites have accepting state and free slots, and there are counts. Start here. For who should go, call `world.einsatz.recommend {taskId}`. Re-read after each order. Example: `{}`, or `{group:\'<group id>\'}`.',
    searchTerms: [...dispatchTerms, 'overview', 'calls', 'units', 'sites', 'waiting', 'overdue'],
    input: situationInputSchema,
    output: situationSchema,
  }),
  defineSimulationQueryCapability({
    readScope: 'collection',
    id: einsatzQueryIds.recommend,
    title: 'Recommend units for a task',
    description: 'Who should go to a task: the smallest set of free units covering what it needs, by fit then ETA, as `proposal.order`, ready to send unchanged with world.einsatz.unit.order. Only free units are proposed, so two recommendations with an order between never propose the same unit. Also other free units per need (each with its own order), why other units are not proposed, and for carriers the sites to deliver to. ETAs include turnout. Example: `{taskId:\'task:c-1\'}`.',
    searchTerms: [...dispatchTerms, 'recommend', 'suggest', 'who should go', 'nearest'],
    input: recommendInputSchema,
    output: recommendAnswerSchema,
    inspectObjectIds: raw => objectIds(recommendInputSchema.parse(raw).taskId),
  }),
  defineSimulationQueryCapability({
    readScope: 'collection',
    id: einsatzQueryIds.unitOptions,
    title: 'Where a unit may be ordered',
    description: 'For one unit: its ordered stop ids and states, and valid targets with a verb, travel estimate, and separate permission to replace the active stop or add to the queue. Use when "after" for a target marked afterOnly. Copy plan into expectedPlan to reject an order if another edit or the run has changed the stops. A busy unit names the task an order with when "now" drops. Example: `{unitId:"unit:a4"}`.',
    searchTerms: [...dispatchTerms, 'targets', 'options', 'where can'],
    input: unitOptionsInputSchema,
    output: unitOptionsSchema,
    inspectObjectIds: raw => objectIds(unitOptionsInputSchema.parse(raw).unitId),
  }),
  defineSimulationQueryCapability({
    readScope: 'catalog',
    id: einsatzQueryIds.configuration,
    title: 'Read the Einsatz configuration',
    description: 'The whole configuration in force (unit types, properties, task templates, load classes, priorities, groups, wording) and its revision. Authoring material: no instances or positions. Example: `{}`.',
    searchTerms: ['configuration', 'unit types', 'task templates', 'priorities'],
    input: z.object({}).strict(),
    output: configurationOutputSchema,
  }),
  command({
    id: einsatzCommandIds.order,
    title: 'Order units',
    description: 'Give units a plan, all or nothing. Example (pick up, then deliver): `{units:[\'unit:a4\'], stops:[{taskId:\'task:c-1\'},{siteId:\'unit:clinic\'}]}`. For a busy unit, set `when`: `after` appends; `now` replaces its job and needs `drops` = its current task. A carrier with no site stop delivers to the nearest accepting site. Refusals: `when_required`, `drops_mismatch`, `requirement_unmet`, `site_not_accepting`, `divert_after_arrival`, `unit_loaded`, `chain_full`.',
    searchTerms: [...dispatchTerms, 'order', 'move', 'plan', 'stops', 'divert'],
    idempotent: false,
    targets: input => objectIds(...input.units),
  }),
  command({
    id: einsatzCommandIds.stopRemove,
    title: 'Remove a stop',
    description: 'Remove one stop from a unit\'s plan. A queued stop leaves; the active one is released as a recall releases it (load not yet picked up returns to its task), and the unit stops where it is and starts its next stop. A stop that delivers load the unit carries, or will carry, stays (unit_loaded); an unknown stop is refused step_not_found. Example: `{unitId:\'unit:a4\', stopId:\'step-3\'}`.',
    searchTerms: ['remove stop', 'cancel stop', 'plan'],
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.planReorder,
    title: 'Reorder queued stops',
    description: 'Supply every queued stop id in the desired order and copy plan from world.einsatz.unit.options into expectedPlan. The active stop continues. A delivery must follow its pickup. Example: `{unitId:"unit:a4",expectedPlan:[{id:"step-1",state:"active"},{id:"step-2",state:"queued"},{id:"step-3",state:"queued"}],stopIds:["step-3","step-2"]}`.',
    searchTerms: ['reorder', 'move stop', 'queue', 'plan'],
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.undo,
    title: 'Undo an order',
    description: 'Take back a unit\'s order while none of it has been carried out: its stops leave quietly, and a task it dropped gets the unit back. Name the commandId the order answered with. Refused newer_order_exists when another command changed the unit\'s plan since; nothing_to_undo once the unit has arrived at or passed the order\'s first stop, and for a return; unit_loaded rather than leave load without its delivery. Example: `{unitId:\'unit:a4\', commandId:\'<commandId>\'}`.',
    searchTerms: ['undo', 'take back', 'revert', 'cancel order'],
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.recall,
    title: 'Return a unit to base',
    description: 'Empty a unit\'s plan, releasing it from its task, if any, and send it back to base. Load not yet picked up returns to the task with its original age. A unit carrying load must deliver first (unit_loaded). Example: `{unitId:\'unit:a4\'}`.',
    searchTerms: ['return', 'recall', 'back to base', 'release'],
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.taskClose,
    title: 'Close a task',
    description: 'Close a task, such as a report that needs no unit. Load not yet picked up is dropped; units still on it stop and are free. A served task closes by itself. Example: `{taskId:\'task:c-4\', reason:\'False alarm\'}`.',
    searchTerms: ['close', 'cancel call', 'false alarm'],
    idempotent: false,
    targets: input => objectIds(input.taskId),
  }),
  command({
    id: einsatzCommandIds.siteSet,
    title: 'Open or close a site',
    description: 'Set whether a site (a unit whose type receives load) accepts arrivals. When it stops accepting, carriers under a deliver standing order heading there deliver elsewhere at once; handovers under way finish. Example: `{siteId:\'unit:clinic\', accepting:false}`.',
    searchTerms: ['site', 'accepting', 'close site', 'open site', 'deliver'],
    idempotent: true,
    targets: input => objectIds(input.siteId),
  }),
  command({
    id: einsatzCommandIds.taskCreate,
    title: 'Create a task',
    description: 'In a Run that declares roles: controller only. Add a task from a declared template at a point, with counted load per load class and an optional priority (else the template\'s, else the lowest). The runtime gives the id. Example: `{template:\'<template id>\', label:\'C-21\', at:{type:\'Point\', coordinates:[11.4, 59.12]}, loads:{\'<class>\':1}}`.',
    searchTerms: ['create task', 'new call', 'add call', 'incident'],
    idempotent: false,
    targets: () => [],
  }),
  command({
    id: einsatzCommandIds.unitCreate,
    title: 'Create a unit',
    description: 'In a Run that declares roles: controller only. Add a unit of a declared type at a point, with an optional base, label and property values; unnamed properties take the type\'s defaults. The runtime gives the id. A side is required exactly when the Run declares sides, and a group once the configuration declares groups, unless the type is public. Example: `{type:\'<type id>\', at:{type:\'Point\', coordinates:[11.4, 59.12]}}`.',
    searchTerms: ['create unit', 'add unit', 'new unit'],
    idempotent: false,
    targets: () => [],
  }),
  command({
    id: einsatzCommandIds.unitAdjust,
    title: 'Adjust unit properties',
    description: 'In a Run that declares roles: controller only. Set property values of a unit, validated against its type, with a recorded reason. A unit on a task may not drop below a condition of its task\'s requirement. Example: `{unitId:\'unit:e2\', properties:{\'<property>\':2500}, reason:\'Refilled\'}`.',
    searchTerms: ['adjust', 'properties', 'set value'],
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.setRoe,
    title: 'Set rules of engagement',
    description: 'Combat configurations only: a unit with an effector. Set its rules of engagement from the next 2 s engagement step on: hold (never fire), return-fire (fire only on tracks whose unit fired in the last 60 s) or free (fire on any eligible track). Example: `{unitId:\'unit:b1\', roe:\'return-fire\'}`.',
    searchTerms: ['rules of engagement', 'roe', 'weapons'],
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.engage,
    title: 'Engage a track',
    description: 'Combat configurations only. Name one of the unit\'s own side\'s identified tracks of a hostile side as its priority target; it fires whenever the fire gate passes (a fix, in range, rules of engagement allow). Another side\'s track is refused cross_side_reference; a contact, a destroyed track or one it cannot engage track_not_engageable. Example: `{unitId:\'unit:b1\', trackId:\'track:blue:3\'}`.',
    searchTerms: ['engage', 'target', 'track'],
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
]

/** The Pack's one line of guidance for agents (≤ 200 characters), fenced in the Run context. */
export const einsatzGuidance = 'Dispatch: read world.einsatz.situation, then world.einsatz.recommend {taskId} for a ready order; send it with world.einsatz.unit.order. Re-read situation after each order.'
