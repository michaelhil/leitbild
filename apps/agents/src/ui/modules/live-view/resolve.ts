// Resolves a ```leitbild-view fence to the validated envelope kept as
// execution evidence of the answer's own turn. Nothing in the fence is used as
// a URL; the frame route is built later from the checked envelope alone.
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { checkViewEnvelope, parseViewFenceBody } from '../../../core/render-validators/view-fence.ts'

export interface ViewFenceOrigin {
  readonly roomId: string
  readonly turnId: string
  readonly workspaceId: string
}

export type ViewResolution =
  | { readonly kind: 'view'; readonly envelope: EmbeddedViewEnvelope }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }

type FetchJson = (path: string) => Promise<{ readonly status: number; readonly body: unknown }>

interface EvidenceCall {
  readonly tool?: unknown
  readonly result?: { readonly success?: unknown; readonly data?: { readonly results?: unknown } }
}

export const resolveViewFence = async (body: string, origin: ViewFenceOrigin, fetchJson: FetchJson): Promise<ViewResolution> => {
  const parsed = parseViewFenceBody(body)
  if (parsed.kind === 'invalid') return { kind: 'refused', code: 'view_reference_invalid', message: parsed.error }
  const path = `/rooms/${encodeURIComponent(origin.roomId)}/executions/${encodeURIComponent(origin.turnId)}/calls/${encodeURIComponent(parsed.ref.callId)}`
  const response = await fetchJson(path)
  if (response.status === 404) return { kind: 'refused', code: 'view_evidence_unavailable', message: 'the tool result behind this display is no longer retained' }
  if (response.status !== 200) return { kind: 'refused', code: 'view_evidence_unreadable', message: `reading the display evidence failed with HTTP ${response.status}` }
  const call = response.body as EvidenceCall
  if (call.tool !== 'workspace_call' || call.result?.success !== true || !Array.isArray(call.result.data?.results)) {
    return { kind: 'refused', code: 'view_evidence_mismatch', message: 'the referenced call did not produce a display' }
  }
  const entry = (call.result.data.results as ReadonlyArray<{ readonly key?: unknown; readonly embeddedView?: unknown }>)
    .find(candidate => candidate.key === parsed.ref.key)
  if (entry?.embeddedView === undefined) return { kind: 'refused', code: 'view_evidence_mismatch', message: `no display was composed under "${parsed.ref.key}"` }
  const checked = checkViewEnvelope(entry.embeddedView, origin.workspaceId)
  return checked.kind === 'view' ? checked : { kind: 'refused', code: checked.code, message: checked.error }
}
