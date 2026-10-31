import { referenceLayerIdPrefix } from '../reference-layer-factory.ts'
import type { StyleForOrder } from '../../map-runtime/reference-layer-order.ts'

export const physicalSceneLayerId = 'physical-scenes:solids'
export const physicalSceneOverviewLayerId = 'physical-scenes:overview'
export const physicalSceneOverviewSourceId = 'physical-scenes:overview-buildings'

/** Base/reference ground → physical scene → operational native overlays → labels. */
export const physicalSceneLayerAnchorId = (style: StyleForOrder): string | undefined => {
  const sources = (style.metadata as Record<string, unknown> | undefined)?.['leitbild:baseSources']
  if (!Array.isArray(sources) || !sources.length || !sources.every(value => typeof value === 'string')) throw new Error('Physical scene ordering requires base map source metadata')
  const base = new Set(sources)
  return style.layers.find(layer => layer.id !== physicalSceneLayerId && layer.id !== physicalSceneOverviewLayerId && !layer.id.startsWith(referenceLayerIdPrefix) && (layer.type === 'symbol' || typeof layer.source === 'string' && !base.has(layer.source)))?.id
}
