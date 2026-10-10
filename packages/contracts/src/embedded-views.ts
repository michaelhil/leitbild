import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'
import {
  EMBEDDED_VIEW_FRAGMENT_KEY,
  EMBEDDED_VIEW_MAX_HEIGHT,
  EMBEDDED_VIEW_MIN_HEIGHT,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from './embedded-view-route.ts'

// A view that its owning Module publishes for another Module to embed, e.g. a
// World display shown below an Agents message. The owning Module defines,
// validates and renders `state`; an embedder only reserves space, builds the
// route from these fields and treats `state` as opaque.
export const embeddedViewTypeSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .brand<'EmbeddedViewType'>()
export type EmbeddedViewType = z.infer<typeof embeddedViewTypeSchema>

// What a Module operation returns when its result can be shown as a view. The
// caller completes the envelope with the exact Resource it invoked, so the
// publishing runtime need not know its own Workspace identity.
const embeddedViewPublicationShape = {
  viewType: embeddedViewTypeSchema,
  title: z.string().min(1).max(120),
  height: z.number().int().min(EMBEDDED_VIEW_MIN_HEIGHT).max(EMBEDDED_VIEW_MAX_HEIGHT),
  state: z.string().min(2).max(EMBEDDED_VIEW_STATE_MAX_LENGTH),
}
export const embeddedViewPublicationSchema = z.object(embeddedViewPublicationShape).strict()
export type EmbeddedViewPublication = z.infer<typeof embeddedViewPublicationSchema>

export const embeddedViewEnvelopeSchema = z.object({
  moduleId: moduleIdSchema,
  subject: workspaceResourceReferenceSchema,
  ...embeddedViewPublicationShape,
}).strict().superRefine((envelope, ctx) => {
  if (envelope.subject.moduleId !== envelope.moduleId) {
    ctx.addIssue({ code: 'custom', path: ['subject', 'moduleId'], message: 'An embedded view subject must belong to the publishing Module' })
  }
})
export type EmbeddedViewEnvelope = z.infer<typeof embeddedViewEnvelopeSchema>

// What a published view shows, in the terms a text presenting it may cite.
// The owning Module returns it beside the view publication (`viewContent`);
// an embedder checks that an answer cites only what its view shows, or says
// that something is not shown. Values are in the units the view shows them in.
const viewQuantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1).max(16),
}).strict()
export const embeddedViewContentSchema = z.object({
  items: z.array(z.object({
    /** Every name the view or its publisher gives the item: tag, path, label, equipment id. */
    names: z.array(z.string().min(1).max(200)).min(1).max(8),
    /** What the view reads for it now. */
    values: z.array(viewQuantitySchema).max(8),
    /** The alarm, trip and control limits the view marks for it. */
    limits: z.array(viewQuantitySchema).max(16),
    /** Whether the view shows its recent history, so earlier values of it may be cited too. */
    history: z.boolean(),
    /** Its state as the view draws it, in words ("running", "level 29.6 %"). */
    state: z.string().min(1).max(200).optional(),
    /** Which way the view shows it going: its rate per minute in `unit` per minute, where the view shows a rate. */
    trend: z.object({
      rate: z.number().finite(),
      unit: z.string().min(1).max(16),
      direction: z.enum(['rising', 'falling', 'steady']),
    }).strict().optional(),
    /** The limit the view names ahead of it in its direction of travel, not yet passed ("LO ALM 14.8 MPa"). */
    limitAhead: viewQuantitySchema.extend({ name: z.string().min(1).max(64) }).strict().optional(),
    /** The time to the limit ahead at the current rate, where the view projects one. */
    timeToLimitMs: z.number().int().positive().optional(),
  }).strict().superRefine((item, ctx) => {
    if (item.timeToLimitMs !== undefined && item.limitAhead === undefined) {
      ctx.addIssue({ code: 'custom', path: ['timeToLimitMs'], message: 'A time to a limit needs the limit ahead' })
    }
  })).max(64),
  /** How far back the view's time axis reaches now, and the horizon it widens to; null without one. */
  span: z.object({
    shownMs: z.number().int().positive(),
    horizonMs: z.number().int().positive(),
  }).strict().nullable(),
  /**
   * The item the view leads with (an index in items): the shortest projected
   * time to a limit, else past or nearest a limit; and why in its words.
   */
  lead: z.object({
    item: z.number().int().nonnegative(),
    reason: z.string().min(1).max(300),
  }).strict().nullable(),
}).strict().superRefine((content, ctx) => {
  if (content.lead !== null && content.lead.item >= content.items.length) {
    ctx.addIssue({ code: 'custom', path: ['lead', 'item'], message: 'The lead must be one of the items' })
  }
})
export type EmbeddedViewContent = z.infer<typeof embeddedViewContentSchema>

export const parseEmbeddedViewFragment = (hash: string): EmbeddedViewEnvelope => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (!body.startsWith(EMBEDDED_VIEW_FRAGMENT_KEY)) throw new Error('Embedded view fragment must start with view=')
  return embeddedViewEnvelopeSchema.parse(JSON.parse(decodeURIComponent(body.slice(EMBEDDED_VIEW_FRAGMENT_KEY.length))))
}

export {
  embeddedViewFragment,
  embeddedViewPath,
  EMBEDDED_VIEW_MAX_HEIGHT,
  EMBEDDED_VIEW_MIN_HEIGHT,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from './embedded-view-route.ts'
