import { z } from 'zod'
import { commandIdSchema, idSchema } from '../../core/model/index.ts'
import { maxSteps, stepTargetSchema } from './steps.ts'

/**
 * Wire inputs of the Einsatz plan commands: `world.einsatz.unit.order`,
 * `unit.undo`, `unit.stop.remove` and `unit.recall`. Each answers with the
 * core `CommandResult`; an accepted one carries the `commandId` that
 * `unit.undo` names. A refusal reads `<code>: <message>` and sets `code`.
 * This module imports nothing from the engine, so the browser and agents
 * validate with the very schemas the Capabilities declare.
 */

/** The most units one order names. */
export const maxOrderUnits = 10

/** A stop of a plan: where the unit goes; the verb there follows from the target and the unit's components. */
export const stopSchema = stepTargetSchema
export type Stop = z.output<typeof stopSchema>

/** For a busy unit: `after` appends the stops to its plan; `now` replaces its current job and needs `drops`. */
export const orderWhen = ['now', 'after'] as const
export type OrderWhen = typeof orderWhen[number]

const distinct = (ids: ReadonlyArray<string>): boolean => new Set(ids).size === ids.length

/**
 * Give units a plan, all or nothing. `when` is refused `when_required` when
 * a named unit is busy and it is absent, and an order naming a busy unit
 * names that unit alone. With `when: 'now'` a busy unit's `drops` must be
 * its current task (`drops_mismatch`).
 */
export const unitOrderInputSchema = z.object({
  units: z.array(idSchema.describe('A unit id, as world.einsatz.situation lists it.'))
    .min(1).max(maxOrderUnits)
    .refine(distinct, 'Each unit is named once')
    .describe(`The units to order, 1 to ${maxOrderUnits}, each named once. A busy unit must be the only one.`),
  stops: z.array(stopSchema).min(1).max(maxSteps)
    .describe(`The plan's stops in order, 1 to ${maxSteps}. A carrier under a deliver standing order with no site stop delivers to the nearest accepting site.`),
  when: z.enum(orderWhen).optional()
    .describe('Required when a named unit is busy, else refused when_required: "after" appends after its current job; "now" replaces its current job and needs drops.'),
  drops: idSchema.optional()
    .describe('With when "now": the task id the busy unit drops, which must be its current task, else refused drops_mismatch.'),
}).strict()
  .refine(input => input.drops === undefined || input.when === 'now', { message: 'drops goes only with when "now"', path: ['drops'] })
  .describe('An order: units, the stops of their plan, and for a busy unit when it applies.')
export type UnitOrderInput = z.output<typeof unitOrderInputSchema>

/** Take back a unit's last order; refused `newer_order_exists` when another command ordered it since, `nothing_to_undo` when it has nothing to take back. */
export const unitUndoInputSchema = z.object({
  unitId: idSchema.describe('The unit whose last order is taken back.'),
  commandId: commandIdSchema.describe('The commandId the accepted order answered with; it must be the unit\'s latest order, else refused newer_order_exists.'),
}).strict().describe('Undo one order of one unit.')
export type UnitUndoInput = z.output<typeof unitUndoInputSchema>

/** Remove one stop of a unit's plan; an unknown stop is refused `step_not_found`. */
export const unitStopRemoveInputSchema = z.object({
  unitId: idSchema.describe('The unit whose plan holds the stop.'),
  stopId: idSchema.describe('The stop id, as world.einsatz.situation lists it in the unit\'s plan.'),
}).strict().describe('Remove one stop from a unit\'s plan.')
export type UnitStopRemoveInput = z.output<typeof unitStopRemoveInputSchema>

/** Empty a unit's plan, releasing it from its task, and send it back to base; a unit carrying load is refused `unit_loaded`. */
export const unitRecallInputSchema = z.object({
  unitId: idSchema.describe('The unit to bring back to base.'),
}).strict().describe('Return a unit to base.')
export type UnitRecallInput = z.output<typeof unitRecallInputSchema>
