// ```leitbild-view fences present a Module-published live view with an answer.
// The fence never carries a URL or the view itself: it names the exact tool
// call result (`view <callId>/<batch key>`) whose validated envelope Agents
// already holds as execution evidence. Shared by the evaluation loop (which
// rejects fences without evidence in the same turn) and the browser renderer
// (which resolves the evidence and asks the Workspace's display window to
// show it).
//
// Browser-safe: no schema runtime. Server-side completion of envelopes lives in
// view-envelope.ts.
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import {
  EMBEDDED_VIEW_MAX_HEIGHT,
  EMBEDDED_VIEW_MIN_HEIGHT,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from '@leitbild/contracts/embedded-view-route'

export const VIEW_FENCE_LANGUAGE = 'leitbild-view'

// Module-wide publications. Agents has one narrower, Room-owned exception
// below: engineering.result. No other Agents page is embeddable.
export const EMBEDDABLE_VIEW_MODULES: ReadonlySet<string> = new Set(['world'])

export interface EngineeringViewState {
  readonly roomId: string
  readonly turnId: string
  readonly toolCallId: string
}

export const engineeringViewState = (state: string): EngineeringViewState | null => {
  let raw: unknown
  try { raw = JSON.parse(state) } catch (error) { if (error instanceof SyntaxError) return null; throw error }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).sort().join() !== 'roomId,toolCallId,turnId'
    || typeof value.roomId !== 'string' || !IDENTIFIER.test(value.roomId)
    || typeof value.turnId !== 'string' || !IDENTIFIER.test(value.turnId)
    || typeof value.toolCallId !== 'string' || !/^call_\d+_\d+$/.test(value.toolCallId)) return null
  return value as unknown as EngineeringViewState
}

export interface ViewReference {
  readonly callId: string
  readonly key: string
}

const VIEW_BODY = /^view (call_\d+_\d+)\/(\S{1,200})$/

export const viewRefFor = (callId: string, key: string): string => `${callId}/${encodeURIComponent(key)}`

// String discriminants: the browser bundle is checked without strictNullChecks,
// where boolean discriminants do not narrow.
export type ViewBodyParse =
  | { readonly kind: 'reference'; readonly ref: ViewReference }
  | { readonly kind: 'invalid'; readonly error: string }

export const parseViewFenceBody = (body: string): ViewBodyParse => {
  const match = body.trim().match(VIEW_BODY)
  if (!match) return { kind: 'invalid', error: 'the block must contain exactly one line: view <viewRef> (copy viewRef from the display.compose result)' }
  try {
    return { kind: 'reference', ref: { callId: match[1]!, key: decodeURIComponent(match[2]!) } }
  } catch (error) {
    if (error instanceof URIError) return { kind: 'invalid', error: `viewRef is not correctly encoded: ${match[2]}` }
    throw error
  }
}

export type ViewEnvelopeCheck =
  | { readonly kind: 'view'; readonly envelope: EmbeddedViewEnvelope }
  | { readonly kind: 'refused'; readonly code: 'view_envelope_invalid' | 'view_module_not_embeddable' | 'view_workspace_mismatch'; readonly error: string }

// Structural mirror of the contract's envelope schema for the browser, where
// the envelope arrives from this Module's own execution evidence (already
// schema-validated when it was recorded). It checks every field that shapes
// the frame route, with the contract's own limits; view-fence.test.ts keeps it
// in step with the schema.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const DOTTED_TYPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENVELOPE_KEYS = ['height', 'moduleId', 'state', 'subject', 'title', 'viewType']
/** A view only the window shows (a dashboard's board a cited line opens) says so; the key is optional, its value true. */
const WINDOW_ONLY = 'windowOnly'
const SUBJECT_KEYS = ['id', 'moduleId', 'type', 'workspaceId']

const structuralProblem = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return 'not an object'
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).filter(key => key !== WINDOW_ONLY).sort().join() !== ENVELOPE_KEYS.join()) return 'unexpected or missing fields'
  if (Object.hasOwn(envelope, WINDOW_ONLY) && envelope[WINDOW_ONLY] !== true) return 'invalid windowOnly'
  const subject = envelope.subject as Record<string, unknown> | null
  if (typeof subject !== 'object' || subject === null || Object.keys(subject).sort().join() !== SUBJECT_KEYS.join()) return 'invalid subject'
  if (typeof envelope.moduleId !== 'string' || !MODULE_ID.test(envelope.moduleId) || envelope.moduleId.length > 64) return 'invalid moduleId'
  if (typeof envelope.viewType !== 'string' || !DOTTED_TYPE.test(envelope.viewType) || envelope.viewType.length > 128) return 'invalid viewType'
  if (typeof envelope.title !== 'string' || envelope.title.length < 1 || envelope.title.length > 120) return 'invalid title'
  if (typeof envelope.height !== 'number' || !Number.isInteger(envelope.height) || envelope.height < EMBEDDED_VIEW_MIN_HEIGHT || envelope.height > EMBEDDED_VIEW_MAX_HEIGHT) return 'invalid height'
  if (typeof envelope.state !== 'string' || envelope.state.length < 2 || envelope.state.length > EMBEDDED_VIEW_STATE_MAX_LENGTH) return 'invalid state'
  if (typeof subject.workspaceId !== 'string' || !WORKSPACE_ID.test(subject.workspaceId)) return 'invalid subject workspaceId'
  if (subject.moduleId !== envelope.moduleId) return 'subject belongs to another Module'
  if (typeof subject.type !== 'string' || !DOTTED_TYPE.test(subject.type) || !subject.type.startsWith(`${envelope.moduleId}.`)) return 'invalid subject type'
  if (typeof subject.id !== 'string' || !IDENTIFIER.test(subject.id)) return 'invalid subject id'
  return null
}

/** Every gate has its own code so a refused view says which rule refused it. */
export const checkViewEnvelope = (value: unknown, workspaceId: string): ViewEnvelopeCheck => {
  const problem = structuralProblem(value)
  if (problem !== null) return { kind: 'refused', code: 'view_envelope_invalid', error: problem }
  const envelope = value as EmbeddedViewEnvelope
  const engineering = envelope.moduleId === 'agents' && envelope.viewType === 'engineering.result' && envelope.subject.type === 'agents.room'
  if (!EMBEDDABLE_VIEW_MODULES.has(envelope.moduleId) && !engineering) return { kind: 'refused', code: 'view_module_not_embeddable', error: `views of Module ${envelope.moduleId} cannot be embedded` }
  if (engineering) {
    const state = engineeringViewState(envelope.state)
    if (state === null || state.roomId !== envelope.subject.id) return { kind: 'refused', code: 'view_envelope_invalid', error: 'engineering evidence locator does not match its Room' }
  }
  if (envelope.subject.workspaceId !== workspaceId) return { kind: 'refused', code: 'view_workspace_mismatch', error: 'the view belongs to another Workspace' }
  return { kind: 'view', envelope }
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Only these two built-ins publish an Agents calculation. The receipt and
 * exact execution locator must agree; a workspace tool cannot forge one. */
export const trustedEngineeringViewEntry = (value: unknown, expected?: Partial<EngineeringViewState>): {
  readonly key: 'calculation'; readonly success: true; readonly embeddedView: EmbeddedViewEnvelope; readonly viewRef: string; readonly data: Record<string, unknown>
} | null => {
  const call = object(value)
  if (call?.tool !== 'engineering_calculate' && call?.tool !== 'engineering_run') return null
  const result = object(call.result)
  const data = object(result?.data)
  if (result?.success !== true || !Array.isArray(data?.results) || data.results.length !== 1) return null
  const entry = object(data.results[0])
  const receipt = object(entry?.data)
  const envelope = object(entry?.embeddedView)
  const subject = object(envelope?.subject)
  if (entry?.key !== 'calculation' || entry.success !== true || receipt?.kind !== 'engineering-calculation'
    || receipt.qualification !== 'research-only' || receipt.mode !== (call.tool === 'engineering_run' ? 'exploratory-script' : 'reviewed-method')
    || envelope?.moduleId !== 'agents' || envelope.viewType !== 'engineering.result' || subject?.type !== 'agents.room'
    || typeof subject.workspaceId !== 'string' || typeof envelope.state !== 'string') return null
  const checked = checkViewEnvelope(envelope, subject.workspaceId)
  const state = engineeringViewState(envelope.state)
  if (checked.kind !== 'view' || state === null || entry.viewRef !== viewRefFor(state.toolCallId, 'calculation')
    || (typeof call.id === 'string' && call.id !== state.toolCallId)
    || (expected !== undefined && Object.entries(expected).some(([key, item]) => state[key as keyof EngineeringViewState] !== item))) return null
  return entry as unknown as { key: 'calculation'; success: true; embeddedView: EmbeddedViewEnvelope; viewRef: string; data: Record<string, unknown> }
}
