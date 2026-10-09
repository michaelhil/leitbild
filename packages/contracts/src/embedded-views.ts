import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'
import { EMBEDDED_VIEW_FRAGMENT_KEY } from './embedded-view-route.ts'

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

// The envelope travels in a URL fragment; 4 KiB keeps it far below browser
// URL limits while leaving room for a compact display composition.
export const EMBEDDED_VIEW_STATE_MAX_LENGTH = 4096

// What a Module operation returns when its result can be shown as a view. The
// caller completes the envelope with the exact Resource it invoked, so the
// publishing runtime need not know its own Workspace identity.
// Views up to 960 px tall: a live equipment mimic with its trend and alarms needs about 900.
export const EMBEDDED_VIEW_MAX_HEIGHT = 960
const embeddedViewPublicationShape = {
  viewType: embeddedViewTypeSchema,
  title: z.string().min(1).max(120),
  height: z.number().int().min(120).max(EMBEDDED_VIEW_MAX_HEIGHT),
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

export const parseEmbeddedViewFragment = (hash: string): EmbeddedViewEnvelope => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (!body.startsWith(EMBEDDED_VIEW_FRAGMENT_KEY)) throw new Error('Embedded view fragment must start with view=')
  return embeddedViewEnvelopeSchema.parse(JSON.parse(decodeURIComponent(body.slice(EMBEDDED_VIEW_FRAGMENT_KEY.length))))
}

export { embeddedViewFragment, embeddedViewPath } from './embedded-view-route.ts'
