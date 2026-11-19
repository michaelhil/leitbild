import { z } from 'zod'
import { commandIdSchema, idSchema } from '../../../core/model/index.ts'
import { configIdSchema } from '../config-schema.ts'
import { unitPhases } from '../lexicon.ts'
import { stopSchema } from '../order-schema.ts'
import { etaSchema, priorityRefSchema } from '../recommendation-schema.ts'
import { einsatzRefusalCodeSchema } from '../refusal.ts'
import { stepStates } from '../steps.ts'

/**
 * Wire schemas of the Einsatz read models `world.einsatz.situation` and
 * `world.einsatz.unit.options`. Both are projections of the Run as the caller
 * sees it, computed on each read and never stored. Every word in them comes
 * from the configuration and its lexicon. This module imports nothing from
 * the engine, so the Dispatch panel validates each answer in the browser
 * with the very schema the Capability declares.
 */

const seconds = z.number().finite().nonnegative()
const count = z.number().int().nonnegative()
const text = z.string().min(1)

/** The verb a stop gives, from its target and the unit's components: a task is served, or its load picked up by a carrier; a site takes a delivery or is gone to; a point is gone to; a track is engaged. */
export const stopVerbs = ['serve', 'pick-up', 'deliver', 'go-to', 'engage'] as const
export type StopVerb = typeof stopVerbs[number]

/** A unit status's colour class: free to send, busy with work, returning to base, needing attention, or out (destroyed). */
export const unitTones = ['free', 'busy', 'returning', 'attention', 'out'] as const
export type UnitTone = typeof unitTones[number]

/** The surface words the configuration's lexicon sets, resolved: its own word, else the neutral one. */
export const situationWordKeys = ['calls', 'units', 'sites', 'send', 'return', 'move', 'close', 'plan', 'stop', 'noCalls', 'noUnits'] as const
export type SituationWordKey = typeof situationWordKeys[number]
const wordMeanings: Readonly<Record<SituationWordKey, string>> = {
  calls: 'The heading of the tasks list.',
  units: 'The heading of the units list.',
  sites: 'The heading of the sites list.',
  send: 'The verb for ordering units to a target (neutral "Dispatch").',
  return: 'The verb for sending a unit back to base.',
  move: 'The verb for sending a unit to a map point.',
  close: 'The verb for closing a task.',
  plan: 'The word for a unit\'s ordered stops.',
  stop: 'The word for one stop of a plan.',
  noCalls: 'What the tasks list says while empty.',
  noUnits: 'What the units list says while empty.',
}

const actorSchema = z.object({
  label: text.describe('Who gave it, in words: a role, the Assistant or another agent, the Scenario timeline, or a standing order.'),
  isViewer: z.boolean().describe('Whether the caller reading this gave it.'),
}).strict().describe('Who gave an order.')

const statusSchema = z.object({
  word: text.describe('The unit\'s phase in the lexicon\'s words, e.g. "En route".'),
  tone: z.enum(unitTones).describe('The colour class the status is drawn in.'),
}).strict().describe('A unit\'s status.')

/** A condition that needs action, held on its object's row while it lasts. */
const rowStateSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('An engine alert code (e.g. work_returned) or a derived one (overdue, no_free_unit).'),
  text: text.describe('The condition in configuration words.'),
}).strict()
const rowStatesSchema = z.array(rowStateSchema).describe('Conditions on this object that need action, while they hold; empty when none.')

const loadCountSchema = z.object({
  classId: configIdSchema.describe('The load class id.'),
  code: text.describe('The load class code.'),
  label: text.describe('The count with the load class\'s noun.'),
  count: count.describe('How many.'),
}).strict()

const planStopSchema = z.object({
  id: idSchema.describe('The stop id, for world.einsatz.unit.stop.remove.'),
  verb: z.enum(stopVerbs).describe('What the unit does there.'),
  target: stopSchema.describe('Where the stop leads, in world.einsatz.unit.order form.'),
  label: text.describe('The target in words: the task\'s, site\'s or track\'s label, or the words for a point.'),
  state: z.enum(stepStates).describe('active: the unit carries it out now; queued: it follows.'),
  eta: etaSchema.nullable().describe('Arrival at the stop; null once the unit is there.'),
  by: actorSchema.describe('Who gave the stop.'),
}).strict()

const unitRowSchema = z.object({
  id: idSchema.describe('The unit id.'),
  label: text.describe('The unit\'s label.'),
  icon: text.describe('The unit type\'s icon.'),
  typeLabel: text.describe('The unit type\'s label.'),
  group: z.object({ id: configIdSchema.describe('The group id.'), label: text.describe('The group\'s label.') }).strict().nullable()
    .describe('The declared group the unit belongs to; null when none.'),
  status: statusSchema,
  phase: z.enum(unitPhases).describe('The unit\'s phase.'),
  phaseDueInS: seconds.nullable().describe('Seconds until the current phase ends (work on task, a handover, turnout); null when it has no set end.'),
  plan: z.array(planStopSchema).describe('The unit\'s stops in order; the first, when active, is its current stop. Empty when it has none.'),
  predictedDelivery: z.object({
    siteId: idSchema.describe('The site the unit will deliver to.'),
    label: text.describe('The site\'s label.'),
    eta: etaSchema.describe('Arrival at the site from the end of the plan.'),
  }).strict().nullable().describe('Where a carrier\'s deliver standing order will take its load after the plan, as the engine resolves it now; null when there is none.'),
  lastOrder: z.object({
    by: actorSchema,
    commandId: commandIdSchema.nullable().describe('The latest command that changed the unit\'s plan, the one world.einsatz.unit.undo names; null while no command has.'),
  }).strict().nullable().describe('The unit\'s last order, by whoever gave it, a standing order and the plan going on included; null before its first.'),
  carry: z.object({
    capacity: count.describe('How much load the unit carries at most.'),
    load: z.array(loadCountSchema).describe('The load on board, per class; empty when none.'),
  }).strict().nullable().describe('The load the unit carries; null when its type carries none.'),
  properties: z.array(z.object({
    id: configIdSchema.describe('The property id.'),
    label: text.describe('The property\'s label.'),
    value: text.describe('The value in words, with its unit.'),
  }).strict()).describe('The values of the properties the type shows.'),
  commandedBy: text.nullable().describe('Who commands the unit when the caller does not, in role words; null when the caller commands it.'),
  states: rowStatesSchema,
}).strict()

const needSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('requirement').describe('Units providing a service.'),
    provides: configIdSchema.describe('The service id.'),
    label: text.describe('The requirement\'s own label, counted.'),
    where: z.array(text).describe('Its property conditions in words, e.g. "<property> ≥ <value> <unit>".'),
    count: count.describe('How many units it needs.'),
    enRoute: count.describe('Assigned units turning out or on their way.'),
    onTask: count.describe('Assigned units working on it.'),
    completed: count.describe('Units that finished their part.'),
  }).strict(),
  z.object({
    kind: z.literal('load').describe('Load waiting to be carried.'),
    classId: configIdSchema.describe('The load class id.'),
    code: text.describe('The load class code.'),
    label: text.describe('The waiting load, counted with the load class\'s noun.'),
    waiting: count.describe('Load not yet picked up.'),
    covered: count.describe('How much of it assigned carriers\' free capacity covers.'),
  }).strict(),
]).describe('One need of a task and its coverage.')

const callRowSchema = z.object({
  id: idSchema.describe('The task id.'),
  label: text.describe('The task\'s label.'),
  icon: text.describe('The task template\'s icon.'),
  templateLabel: text.describe('The task template\'s label.'),
  priority: priorityRefSchema,
  waitingS: seconds.describe('Seconds since the task was created.'),
  overdue: z.boolean().optional().describe('Whether it has waited past its priority\'s response target; present only when the priority declares one.'),
  observed: z.object({
    by: text.describe('The observer\'s label, e.g. a drone of the Drone Pack.'),
    at: z.string().datetime().describe('The Run time it observed the task at.'),
  }).strict().optional().describe('The latest observation of the task by another Pack\'s sensor; present once observed.'),
  needs: z.array(needSchema).describe('What the task needs, with coverage.'),
  assigned: z.array(z.object({
    unitId: idSchema.describe('The unit id.'),
    label: text.describe('The unit\'s label.'),
    phase: z.enum(unitPhases).describe('The unit\'s phase.'),
    status: statusSchema,
    eta: etaSchema.nullable().describe('Arrival at the task; null once there.'),
    by: actorSchema.describe('Who ordered the unit here.'),
  }).strict()).describe('Units whose current stop is this task.'),
  states: rowStatesSchema,
}).strict()

const siteRowSchema = z.object({
  id: idSchema.describe('The site id, for a {siteId} stop.'),
  label: text.describe('The site\'s label.'),
  icon: text.describe('The site type\'s icon.'),
  typeLabel: text.describe('The site type\'s label.'),
  accepting: z.boolean().nullable().describe('Whether it takes arrivals now: accepting and not destroyed; null for a place that receives no load.'),
  slots: z.object({ used: count.describe('Slots in use.'), total: count.describe('All slots.') }).strict().nullable()
    .describe('Handover slots; null for a place that receives no load.'),
  inbound: z.array(z.object({
    unitId: idSchema.describe('The unit id.'),
    label: text.describe('The unit\'s label.'),
    eta: etaSchema.nullable().describe('Arrival at the site; null once there.'),
  }).strict()).describe('Units whose plan or predicted delivery leads here, soonest first.'),
  states: rowStatesSchema,
}).strict()

export const situationInputSchema = z.object({
  group: configIdSchema.optional().describe('Only the units of this declared group; calls and sites are listed in full.'),
}).strict()
export type SituationInput = z.output<typeof situationInputSchema>

/** The `world.einsatz.situation` answer. It makes no suggestions: who should go comes from `world.einsatz.recommend`. */
export const situationSchema = z.object({
  counts: z.object({
    calls: z.array(z.object({
      priorityId: configIdSchema.describe('The priority id.'),
      code: text.describe('The priority code.'),
      count: count.describe('Open tasks of this priority.'),
    }).strict()).describe('Open tasks per priority, highest first.'),
    oldestWaitingS: seconds.nullable().describe('Seconds the longest-waiting open task has waited; null when none is open.'),
    freeUnits: count.describe('Units listed that are free to send: no task and no load.'),
    units: count.describe('All units listed.'),
    acceptingSites: count.describe('Sites taking arrivals now.'),
    sites: count.describe('Sites that receive load.'),
  }).strict().describe('The counts line.'),
  calls: z.array(callRowSchema).describe('Open tasks, by priority rank, then creation time.'),
  units: z.array(unitRowSchema).describe('Units: every unit whose type moves, by group, else by type.'),
  sites: z.array(siteRowSchema).describe('Sites: every unit whose type does not move, a place units go to; one that receives load takes deliveries there.'),
  words: z.object(Object.fromEntries(situationWordKeys.map(key => [key, text.describe(wordMeanings[key])])) as Record<SituationWordKey, typeof text>).strict()
    .describe('The configuration\'s words for the surface: headings, verbs and empty lists.'),
  features: z.object({
    hasCarry: z.boolean().describe('Some unit type carries load.'),
    hasSites: z.boolean().describe('Some unit type receives load.'),
    hasContacts: z.boolean().describe('Some unit type declares a sensor or an effector (combat configurations).'),
    propertyColumns: z.array(z.object({
      id: configIdSchema.describe('The property id.'),
      label: text.describe('The property\'s label.'),
    }).strict()).describe('The properties unit types show, in declaration order.'),
  }).strict().describe('What the configuration declares, which decides the sections and columns.'),
}).strict()
export type Situation = z.output<typeof situationSchema>
export type SituationUnit = Situation['units'][number]
export type SituationCall = Situation['calls'][number]
export type SituationSite = Situation['sites'][number]

export const unitOptionsInputSchema = z.object({
  unitId: idSchema.describe('The unit to list targets for.'),
}).strict()
export type UnitOptionsInput = z.output<typeof unitOptionsInputSchema>

/** The `world.einsatz.unit.options` answer: where the unit may be ordered now, and where not and why. */
export const unitOptionsSchema = z.object({
  unitId: idSchema.describe('The unit the answer is for.'),
  busy: z.object({
    taskId: idSchema.describe('The task the unit works for now; an order with when "now" drops it.'),
    label: text.describe('That task\'s label.'),
    code: text.describe('That task\'s priority code.'),
    freeInS: seconds.nullable().describe('Estimated seconds until its current job is done; null when it cannot be estimated.'),
  }).strict().nullable().describe('Set when the unit is busy: an order then needs when ("after" or "now" with drops = taskId).'),
  targets: z.array(z.object({
    target: stopSchema.describe('The stop, in world.einsatz.unit.order form.'),
    verb: z.enum(stopVerbs).describe('What the unit would do there.'),
    label: text.describe('The target\'s label.'),
    etaS: seconds.describe('Seconds to arrive, turnout included; routed for road units, straight-line for direct ones. For a target only "after" takes, from where and when the unit\'s plan ends, the delivery its deliver standing order makes included.'),
    now: z.boolean().describe('Whether an order now takes it: for a busy unit one with when "now", dropping its job; for any other one without when. False: only an order with when "after" takes it, after the unit\'s plan (a loaded carrier\'s call once it has delivered).'),
  }).strict()).describe('Valid targets, nearest first: those an order now or "after" the unit\'s plan would take.'),
  refused: z.array(z.object({
    target: stopSchema.describe('The stop, in world.einsatz.unit.order form.'),
    label: text.describe('The target\'s label.'),
    code: einsatzRefusalCodeSchema.describe('The refusal code an order to it would get.'),
    text: text.describe('The refusal in configuration words.'),
  }).strict()).describe('Targets an order would be refused for, with the reason.'),
}).strict()
export type UnitOptions = z.output<typeof unitOptionsSchema>
