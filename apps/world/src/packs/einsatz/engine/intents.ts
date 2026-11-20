import { z } from 'zod'
import { idSchema, type CommandId, type GeoJsonPoint } from '../../../core/model/index.ts'
import { configIdSchema, roeModes } from '../config-schema.ts'
import { unitOrderInputSchema, unitRecallInputSchema, unitStopRemoveInputSchema, unitUndoInputSchema } from '../order-schema.ts'
import type { Draft } from './draft.ts'
import { pointSchema, propertyValueSchema, type Leg, type UnitRecord } from './model.ts'

/**
 * Intents: what an actor asks the engine to do. Commands, scenario cues and
 * standing orders all arrive as intents and pass the same validation.
 */

const propertiesSchema = z.record(configIdSchema, propertyValueSchema)
const loadsSchema = z.record(configIdSchema, z.number().int().min(1).max(1_000))
const labelSchema = z.string().trim().min(1).max(120)
const reasonSchema = z.string().trim().min(1).max(500)

/**
 * The fields each intent carries besides its `kind`. Command Capabilities
 * accept the same fields on the wire; a create's id is the runtime's to give.
 */
export const intentFields = {
  /** The plan commands' wire inputs (`order-schema.ts`): an order's units, stops, and for a busy unit when it applies; a recall, undo or stop removal's unit and what it names. */
  order: unitOrderInputSchema.shape,
  recall: unitRecallInputSchema.shape,
  undo: unitUndoInputSchema.shape,
  stopRemove: unitStopRemoveInputSchema.shape,
  taskCreate: {
    template: configIdSchema.describe('A task template id the configuration declares (world.einsatz.configuration).'),
    priority: configIdSchema.optional().describe('A declared priority id; without it the template\'s priority, else the lowest declared.'),
    side: configIdSchema.optional().describe('The task\'s side: required exactly when the Run declares sides.'),
    at: pointSchema.describe('Where the task is, a GeoJSON point.'),
    loads: loadsSchema.optional().describe('Counted load waiting there, per declared load class id, e.g. {"<class>": 1}.'),
    label: labelSchema.describe('The task\'s label, e.g. "C-21 Harbour fall".'),
  },
  taskClose: {
    taskId: idSchema.describe('The task to close.'),
    reason: reasonSchema.optional().describe('Why, in words, recorded with the close.'),
  },
  siteSet: {
    siteId: idSchema.describe('A site: a unit whose type receives load.'),
    accepting: z.boolean().describe('Whether it accepts arrivals.'),
  },
  unitCreate: {
    type: configIdSchema.describe('A unit type id the configuration declares.'),
    side: configIdSchema.optional().describe('The unit\'s side: required exactly when the Run declares sides, unless the type is public.'),
    group: configIdSchema.optional().describe('A declared group id: required once the configuration declares groups, unless the type is public.'),
    at: pointSchema.describe('Where the unit is created, a GeoJSON point.'),
    base: pointSchema.optional().describe('Where it returns to; where it is created unless given.'),
    label: labelSchema.describe('The unit\'s label, e.g. "A7".'),
    properties: propertiesSchema.optional().describe('Values of the type\'s declared properties by id; unnamed ones take the type\'s defaults.'),
  },
  unitAdjust: {
    unitId: idSchema.describe('The unit to adjust.'),
    properties: propertiesSchema.refine(properties => Object.keys(properties).length > 0, 'Name at least one property').describe('New values of declared properties by id.'),
    reason: reasonSchema.describe('Why, in words, recorded with the change.'),
  },
  setRoe: {
    unitId: idSchema.describe('A unit with an effector.'),
    roe: z.enum(roeModes).describe('hold: never fire; return-fire: only on tracks whose unit fired in the last 60 s; free: on any eligible track.'),
  },
  engage: {
    unitId: idSchema.describe('A unit with an effector.'),
    trackId: idSchema.describe('One of the unit\'s own side\'s identified tracks.'),
  },
} as const

/**
 * Give units a plan, all or nothing (`orders.ts`). For a free unit the first
 * stop starts now and the rest follow. A busy unit, one serving a task, needs
 * `when`: `after` appends the stops behind its plan; `now` drops its current
 * task (`drops` names it) and starts the first stop, keeping the steps it
 * had queued behind the new ones. If any stop is refused, nothing changes.
 */
export const orderIntentSchema = z.object({ kind: z.literal('order'), ...intentFields.order }).strict()

/** Release a unit from its task, if any, clear its plan and bring it back to base. */
export const recallIntentSchema = z.object({ kind: z.literal('recall'), ...intentFields.recall }).strict()
/** Take back the order of a command while none of it has been carried out (`orders.ts`). */
export const undoIntentSchema = z.object({ kind: z.literal('undo'), ...intentFields.undo }).strict()
/** Remove one stop; the active one is released as a recall releases it, and the next stop starts. */
export const stopRemoveIntentSchema = z.object({ kind: z.literal('stop.remove'), ...intentFields.stopRemove }).strict()
/**
 * Start the first queued step of an idle unit. No command asks for it: the
 * engine runs it like a standing order as soon as a unit's active step is
 * done, so it passes the same validation. A step that can no longer be
 * carried out is skipped.
 */
export const chainNextIntentSchema = z.object({ kind: z.literal('chain.next'), unitId: idSchema }).strict()

export const taskCreateIntentSchema = z.object({ kind: z.literal('task.create'), id: idSchema, ...intentFields.taskCreate }).strict()
export const taskCloseIntentSchema = z.object({ kind: z.literal('task.close'), ...intentFields.taskClose }).strict()
export const siteSetIntentSchema = z.object({ kind: z.literal('site.set'), ...intentFields.siteSet }).strict()

/**
 * A new unit of a declared type. Its base is where it is created unless one
 * is named. Once the configuration declares groups, a unit that is not of a
 * public type names exactly one, of its own side.
 */
export const unitCreateIntentSchema = z.object({ kind: z.literal('unit.create'), id: idSchema, ...intentFields.unitCreate }).strict()
export const unitAdjustIntentSchema = z.object({ kind: z.literal('unit.adjust'), ...intentFields.unitAdjust }).strict()

/** Set a unit's rules of engagement: hold fire, return fire, or fire on any eligible track. */
export const setRoeIntentSchema = z.object({ kind: z.literal('set-roe'), ...intentFields.setRoe }).strict()
/** Name an own-side track as a unit's priority target. */
export const engageIntentSchema = z.object({ kind: z.literal('engage'), ...intentFields.engage }).strict()

export const intentSchema = z.discriminatedUnion('kind', [
  orderIntentSchema,
  recallIntentSchema,
  undoIntentSchema,
  stopRemoveIntentSchema,
  taskCreateIntentSchema,
  taskCloseIntentSchema,
  siteSetIntentSchema,
  unitCreateIntentSchema,
  unitAdjustIntentSchema,
  setRoeIntentSchema,
  engageIntentSchema,
  chainNextIntentSchema,
])

export type Intent = z.output<typeof intentSchema>
export type IntentOf<K extends Intent['kind']> = Extract<Intent, { kind: K }>

/** Who acts. Roles, scenario cues and standing orders all act through this. */
export interface EngineActor {
  /**
   * Who acted, recorded in `lastAction.by`: the labels of the roles a caller
   * holds in a Run with roles; otherwise an id: the core actor, `scenario`
   * for authored items, or `standing-order:<id>`. Refusal wording never shows it.
   */
  readonly by: string
  /** The units the actor commands; need and divert comparisons are taken over them. */
  readonly commandable: (unit: UnitRecord) => boolean
  /** The command the actor gives, when it is one: the steps it gives and the units it orders name it, so `unit.undo` can take it back. */
  readonly commandId?: CommandId
}

/** An actor that commands every unit: the Controller, open mode, scenario cues and standing orders. */
export const commandsEveryUnit = (): boolean => true

export interface RouteNeed {
  readonly unitId: string
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
}

/**
 * A validated intent: the routes it needs, notes for what it leaves
 * unchanged ("already en route"), and how it applies once routes exist.
 */
export type Plan =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true
    readonly routes: ReadonlyArray<RouteNeed>
    readonly notes: ReadonlyArray<string>
    readonly apply: (draft: Draft, legs: ReadonlyMap<string, Leg>) => void
  }
