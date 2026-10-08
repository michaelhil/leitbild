// Server-side completion of Module view publications (uses the contract's
// schema runtime; keep out of browser bundles).
import { embeddedViewEnvelopeSchema, embeddedViewPublicationSchema, type EmbeddedViewEnvelope, type WorkspaceResourceReference } from '@leitbild/contracts'

export type EmbeddedViewCompletion =
  | { readonly kind: 'none' }
  | { readonly kind: 'view'; readonly envelope: EmbeddedViewEnvelope }
  | { readonly kind: 'invalid'; readonly error: string }

/** Completes a Module's view publication with the exact Resource the call targeted. */
export const embeddedViewFor = (data: unknown, target: WorkspaceResourceReference): EmbeddedViewCompletion => {
  if (typeof data !== 'object' || data === null || !('view' in data)) return { kind: 'none' }
  const publication = embeddedViewPublicationSchema.safeParse((data as { view: unknown }).view)
  if (!publication.success) return { kind: 'invalid', error: `view publication is invalid: ${publication.error.issues.map(issue => issue.message).join('; ')}` }
  const envelope = embeddedViewEnvelopeSchema.safeParse({ ...publication.data, moduleId: target.moduleId, subject: target })
  if (!envelope.success) return { kind: 'invalid', error: `view cannot be embedded for this target: ${envelope.error.issues.map(issue => issue.message).join('; ')}` }
  return { kind: 'view', envelope: envelope.data }
}
