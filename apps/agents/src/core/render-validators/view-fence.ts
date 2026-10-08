// ```leitbild-view fences place a Module-published live view below an answer.
// The fence never carries a URL or the view itself: it names the exact tool
// call result (`view <callId>/<batch key>`) whose validated envelope Agents
// already holds as execution evidence. Shared by the evaluation loop (which
// rejects fences without evidence in the same turn) and the browser renderer
// (which resolves the evidence and builds the same-origin frame).
import { embeddedViewEnvelopeSchema, embeddedViewPublicationSchema, type EmbeddedViewEnvelope, type WorkspaceResourceReference } from '@leitbild/contracts'

export const VIEW_FENCE_LANGUAGE = 'leitbild-view'

// Modules whose views may be embedded below an answer. Agents never embeds
// its own pages, and a new Module must be added deliberately.
export const EMBEDDABLE_VIEW_MODULES: ReadonlySet<string> = new Set(['world'])

export interface ViewReference {
  readonly callId: string
  readonly key: string
}

const VIEW_BODY = /^view (call_\d+_\d+)\/(\S{1,200})$/

export const viewRefFor = (callId: string, key: string): string => `${callId}/${encodeURIComponent(key)}`

export type ViewBodyParse =
  | { readonly ok: true; readonly ref: ViewReference }
  | { readonly ok: false; readonly error: string }

export const parseViewFenceBody = (body: string): ViewBodyParse => {
  const match = body.trim().match(VIEW_BODY)
  if (!match) return { ok: false, error: 'the block must contain exactly one line: view <viewRef> (copy viewRef from the display.compose result)' }
  try {
    return { ok: true, ref: { callId: match[1]!, key: decodeURIComponent(match[2]!) } }
  } catch (error) {
    if (error instanceof URIError) return { ok: false, error: `viewRef is not correctly encoded: ${match[2]}` }
    throw error
  }
}

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

export type ViewEnvelopeCheck =
  | { readonly ok: true; readonly envelope: EmbeddedViewEnvelope }
  | { readonly ok: false; readonly code: 'view_envelope_invalid' | 'view_module_not_embeddable' | 'view_workspace_mismatch'; readonly error: string }

/** Every gate has its own code so a refused view says which rule refused it. */
export const checkViewEnvelope = (value: unknown, workspaceId: string): ViewEnvelopeCheck => {
  const parsed = embeddedViewEnvelopeSchema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'view_envelope_invalid', error: parsed.error.issues.map(issue => issue.message).join('; ') }
  if (!EMBEDDABLE_VIEW_MODULES.has(parsed.data.moduleId)) return { ok: false, code: 'view_module_not_embeddable', error: `views of Module ${parsed.data.moduleId} cannot be embedded` }
  if (parsed.data.subject.workspaceId !== workspaceId) return { ok: false, code: 'view_workspace_mismatch', error: 'the view belongs to another Workspace' }
  return { ok: true, envelope: parsed.data }
}
