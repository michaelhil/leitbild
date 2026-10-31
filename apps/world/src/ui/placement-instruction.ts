import type { PackCreateObjectType } from '../core/packs/protocol.ts'

/** Transient guidance belongs to the active placement, never to command history. */
export const placementInstruction = (mode: PackCreateObjectType | null, pointCount: number): string => {
  if (mode === null) return ''
  const label = mode.label.toLowerCase(), kind = mode.placementKind ?? 'point'
  if (kind === 'route') return `Click ${pointCount === 0 ? 'start' : 'end'} point for new ${label}`
  if (kind === 'polygon') return pointCount < 3
    ? `Click ${3 - pointCount} more point${3 - pointCount === 1 ? '' : 's'} for new ${label}`
    : `Press Enter to finish ${label} polygon`
  return `Click map to place new ${label}`
}
