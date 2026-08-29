import type { PackCreateObjectType } from '../../core/packs/protocol.ts'

export interface PlacementGlobalEventConfig {
  readonly placementMode: () => PackCreateObjectType | null
  readonly cancel: () => void
  readonly finishPolygon: () => void
}

export const installPlacementGlobalEvents = (config: PlacementGlobalEventConfig): (() => void) => {
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') config.cancel()
    const placementMode = config.placementMode()
    if (event.key === 'Enter' && placementMode && (placementMode.placementKind ?? 'point') === 'polygon') {
      event.preventDefault()
      config.finishPolygon()
    }
  }

  const handleClick = (event: MouseEvent): void => {
    if (!config.placementMode()) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.map-region')) return
    config.cancel()
    event.stopImmediatePropagation()
    event.stopPropagation()
    event.preventDefault()
  }

  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('click', handleClick, { capture: true })
  return () => {
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('click', handleClick, { capture: true })
  }
}
