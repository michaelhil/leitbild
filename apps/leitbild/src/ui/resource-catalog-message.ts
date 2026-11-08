import { resourceCatalogChangedMessageSchema, type WorkspaceResourceReference } from '@leitbild/contracts'
import { sameResource } from './run-room-scope.ts'

export const isCurrentResourceCatalogChange = (
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  current: { origin: string; source: Window | null; resource: WorkspaceResourceReference | null },
): boolean => {
  if (!current.source || !current.resource || event.origin !== current.origin || event.source !== current.source) return false
  const parsed = resourceCatalogChangedMessageSchema.safeParse(event.data)
  return parsed.success && sameResource(parsed.data.resource, current.resource)
}
