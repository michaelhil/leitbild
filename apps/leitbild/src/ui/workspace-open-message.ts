import { workspaceOpenMessageSchema } from '@leitbild/contracts'

/**
 * The address a Module page asks the Host to show in place (`leitbild:workspace-open`), or null when the Host does
 * not take it: it must come from this page's origin and from the frame the Host shows now, parse, and name this
 * page's Workspace. Anything else is not for this Host and is left alone, never reported.
 */
export const acceptedWorkspaceOpen = (
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  current: { readonly origin: string; readonly source: Window | null; readonly workspaceId: string },
): string | null => {
  if (!current.source || event.origin !== current.origin || event.source !== current.source) return null
  const parsed = workspaceOpenMessageSchema.safeParse(event.data)
  if (!parsed.success) return null
  const encoded = /^\/workspaces\/([^/?#]+)/.exec(parsed.data.address)?.[1]
  if (encoded === undefined) return null
  let workspaceId: string
  try { workspaceId = decodeURIComponent(encoded) } catch { return null }
  return workspaceId === current.workspaceId ? parsed.data.address : null
}
