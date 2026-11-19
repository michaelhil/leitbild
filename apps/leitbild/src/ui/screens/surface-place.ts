// "Open on another screen…" on a World surface: the World page asks the Host
// to offer its screens (`leitbild:surface-place`, packages/contracts
// surfaces.ts). The Host is the only validator on that path: the message is
// parsed with its contract schema, must come from the World frame, and must be
// about the Run that frame shows in this page's Workspace. A refusal is told
// to the person. The surface string itself is never read.

import { workspaceSurfacePlaceMessageSchema, type WorkspaceSurface } from '@leitbild/contracts'
import { firstIssue } from '../view-relay.ts'

const PLACE_MESSAGE_TYPE = 'leitbild:surface-place'

export type SurfacePlaceReading =
  /** Not this protocol's message. */
  | { readonly kind: 'other' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'place'; readonly surface: WorkspaceSurface }

export const readSurfacePlace = (data: unknown, page: {
  /** Whether the message's source is the World frame's window. */
  readonly fromWorld: boolean
  readonly workspaceId: string
  /** The Run the World frame shows, or null without one. */
  readonly runId: string | null
}): SurfacePlaceReading => {
  if (typeof data !== 'object' || data === null || (data as { readonly type?: unknown }).type !== PLACE_MESSAGE_TYPE) return { kind: 'other' }
  if (!page.fromWorld) return { kind: 'refused', message: `Screen placement refused: only the World page sends ${PLACE_MESSAGE_TYPE}` }
  const parsed = workspaceSurfacePlaceMessageSchema.safeParse(data)
  if (!parsed.success) return { kind: 'refused', message: `Screen placement refused: ${firstIssue(parsed.error)}` }
  const { surface } = parsed.data
  if (surface.subject.workspaceId !== page.workspaceId) return { kind: 'refused', message: 'Screen placement refused: it belongs to another Workspace' }
  if (surface.moduleId !== 'world' || surface.subject.type !== 'world.simulation-run' || surface.subject.id !== page.runId) {
    return { kind: 'refused', message: 'Screen placement refused: it is not about the Run shown here' }
  }
  return { kind: 'place', surface }
}
