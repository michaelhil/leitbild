/**
 * How an object's alerts are annunciated (plan v5 W2.3–W2.6, D-E): a static declaration beside its observables, kept
 * by the declaration's revision, so nothing is stored per Run. World reads each alert slot's facets with it per sample:
 * a row's tag, the first-out group it is annunciated in and that group's label ("RX TRIP"), its category, and whether
 * it came in as the expected consequence of a first-out, inside the declared window. Words are the Pack's; World adds
 * none.
 */
import { z } from 'zod'

const groupIdSchema = z.string().min(1).max(64)
const categoryIdSchema = z.string().min(1).max(64)

export const annunciationSchema = z.object({
  /**
   * The first-out groups, each by its label as a row and the trip line name it, and the elements its actuations stop
   * (`ends`: the energy ends a trip commands, which its label opens). A group with ends leads the trip line with its
   * first-out; the others it lists as actuated.
   */
  groups: z.array(z.object({
    id: groupIdSchema,
    label: z.string().min(1).max(24),
    ends: z.array(z.string().min(1).max(200)).min(1).max(8).optional(),
  }).strict()).max(32),
  /** The categories (annunciator systems) alerts are listed under, in their declared order. */
  categories: z.array(z.object({ id: categoryIdSchema, label: z.string().min(1).max(80) }).strict()).max(32),
  /**
   * Each alert the object can raise, by its alert id: its tag ("LO-LO · RX TRIP", "L LO & F LO · ALM"), its group,
   * its category, and the first-out group whose actuation brings it in as expected, within how long (`withinMs`, from
   * the group's first-out, past which it is news again).
   */
  alerts: z.array(z.object({
    id: z.string().min(1).max(200),
    tag: z.string().min(1).max(48).optional(),
    group: groupIdSchema.optional(),
    category: categoryIdSchema.optional(),
    expectedAfter: z.object({ group: groupIdSchema, withinMs: z.number().int().positive() }).strict().optional(),
  }).strict()).max(2048),
}).strict().superRefine((annunciation, context) => {
  const groups = new Set(annunciation.groups.map(group => group.id))
  const categories = new Set(annunciation.categories.map(category => category.id))
  if (groups.size !== annunciation.groups.length) context.addIssue({ code: 'custom', message: 'duplicate first-out group' })
  if (categories.size !== annunciation.categories.length) context.addIssue({ code: 'custom', message: 'duplicate category' })
  if (new Set(annunciation.alerts.map(alert => alert.id)).size !== annunciation.alerts.length) context.addIssue({ code: 'custom', message: 'duplicate alert id' })
  for (const alert of annunciation.alerts) {
    for (const group of [alert.group, alert.expectedAfter?.group]) if (group !== undefined && !groups.has(group)) context.addIssue({ code: 'custom', message: `${alert.id} names an undeclared group ${group}` })
    if (alert.category !== undefined && !categories.has(alert.category)) context.addIssue({ code: 'custom', message: `${alert.id} names an undeclared category ${alert.category}` })
  }
})

export type Annunciation = z.output<typeof annunciationSchema>
