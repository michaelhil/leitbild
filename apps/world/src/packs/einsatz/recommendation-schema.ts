import { z } from 'zod'
import { idSchema } from '../../core/model/index.ts'
import { configIdSchema } from './config-schema.ts'
import { unitOrderInputSchema } from './order-schema.ts'

/**
 * The `world.einsatz.recommend` answer's wire schema. It imports nothing from
 * the engine or the Capability module, so the browser validates each answer
 * it receives with the very schema the Capability declares.
 */

const seconds = z.number().finite().nonnegative()
const metres = z.number().finite().nonnegative()
/**
 * Time to arrive, turnout included. `routed` comes from the road router;
 * `straight-line` from a direct unit or a Run on the direct router. Where a
 * order of the unit would be refused for its route (the router fails or finds
 * no route, or a point lies more than 1 km from a road) the ETA is
 * unavailable: the reason reads `<code>: <message>` with that refusal's code,
 * and only the straight distance is shown.
 */
const etaSeconds = seconds.describe('Seconds to arrive, turnout included.')
const etaDistance = metres.describe('Metres along the way.')
export const etaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('routed').describe('Routed on the road network.'), seconds: etaSeconds, distanceM: etaDistance }).strict(),
  z.object({ kind: z.literal('straight-line').describe('A straight line: a direct unit, or a Run on the direct router.'), seconds: etaSeconds, distanceM: etaDistance }).strict(),
  z.object({
    kind: z.literal('unavailable').describe('No ETA: an order would be refused for its route.'),
    reason: z.string().min(1).describe('The refusal an order would get, as <code>: <message> (routing_unavailable, no_road_near_point).'),
    straightDistanceM: metres.describe('The straight distance in metres.'),
  }).strict(),
])
export type Eta = z.output<typeof etaSchema>

/**
 * A task's priority as the configuration declares it: `rank` 0 is the
 * highest. `responseTargetS` is present only where the priority declares a
 * response target.
 */
export const priorityRefSchema = z.object({
  id: configIdSchema.describe('The priority id the configuration declares.'),
  label: z.string().min(1).describe('The priority\'s label in configuration words.'),
  code: z.string().min(1).describe('The short code, e.g. "P1".'),
  rank: z.number().int().nonnegative().describe('Position in the declared priorities; 0 is the highest.'),
  responseTargetS: seconds.optional().describe('Seconds a task of this priority may wait before it is overdue; absent when none is declared.'),
}).strict().describe('A task priority.')
export type PriorityRef = z.output<typeof priorityRefSchema>

const unitEtaSchema = z.object({
  unitId: idSchema.describe('The unit id.'),
  label: z.string().min(1).describe('The unit\'s label.'),
  eta: etaSchema.describe('Arrival at the task, turnout included.'),
}).strict()

/** What a need is: a requirement the template declares (by what it provides) or load waiting of a class. */
const needRefSchema = z.object({
  kind: z.enum(['requirement', 'load']).describe('requirement: units providing a service; load: carry capacity for waiting load of a class.'),
  id: configIdSchema.describe('The provided service id for a requirement, the load class id for load.'),
  label: z.string().min(1).describe('The need in configuration words.'),
}).strict()

/**
 * The `world.einsatz.recommend` answer for the plan model. It proposes free
 * units only, so two recommendations separated by an order never propose
 * the same unit; `proposal.order` is sent to `world.einsatz.unit.order`
 * unchanged.
 */
export const recommendAnswerSchema = z.object({
  taskId: idSchema.describe('The task the answer is for.'),
  priority: priorityRefSchema.describe('The task\'s priority.'),
  proposal: z.object({
    order: unitOrderInputSchema.describe('Send this to world.einsatz.unit.order unchanged.'),
    units: z.array(unitEtaSchema).min(1).describe('The proposed free units with their ETAs.'),
    covers: z.object({
      covered: z.number().int().nonnegative().describe('How many of the needed units are covered once the proposal goes, those already assigned and those planned as a later stop included.'),
      needed: z.number().int().nonnegative().describe('How many units the task\'s needs add up to.'),
    }).strict().describe('"covers n of m".'),
    remainder: z.array(z.string().min(1)).describe('What the task still needs after the proposal, in configuration words; empty when covered.'),
  }).strict().nullable().describe('The smallest set of free units covering what the task needs beyond the units assigned to it and those holding it as a later stop (the situation\'s planned), by fit then ETA; null when those cover it, or no free unit can help.'),
  alternatives: z.array(z.object({
    need: needRefSchema.describe('The need these units can serve.'),
    units: z.array(unitEtaSchema.extend({
      order: unitOrderInputSchema.describe('Send this to world.einsatz.unit.order to dispatch this unit alone.'),
    }).strict()).describe('Other free units for the need, nearest first.'),
  }).strict()).describe('Per need: other free units to send instead.'),
  whyNot: z.array(z.object({
    unitId: idSchema.describe('The unit id.'),
    label: z.string().min(1).describe('The unit\'s label.'),
    reasons: z.array(z.string().min(1)).min(1).describe('Why it is not proposed, in property and lexicon words.'),
  }).strict()).describe('Units that provide what the task needs but are not proposed (busy, or failing a condition).'),
  deliverTo: z.array(z.object({
    unitId: idSchema.describe('A proposed carrier.'),
    label: z.string().min(1).describe('The carrier\'s label.'),
    sites: z.array(z.object({
      siteId: idSchema.describe('A site that accepts the load the carrier will pick up.'),
      label: z.string().min(1).describe('The site\'s label.'),
      eta: etaSchema.describe('Travel from the task to the site.'),
    }).strict()).min(1).describe('Accepting sites, nearest first.'),
  }).strict()).describe('For each proposed carrier that will pick up load: sites a site stop may name, appended with when "after".'),
}).strict()
export type RecommendAnswer = z.output<typeof recommendAnswerSchema>
