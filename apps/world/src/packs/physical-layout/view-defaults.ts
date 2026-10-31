import { physicalSceneInitialVisibleLayers, type PhysicalSceneViewDefaults, type PackPhysicalSceneDescriptor } from '../../core/packs/scene.ts'

interface Source {
  readonly elements: ReadonlyArray<{ readonly kind: string; readonly layerId?: string | undefined }>
  readonly routing?: { readonly connections: ReadonlyArray<{ readonly layerId: string }> } | undefined
}
/** Pack presentation policy follows actual declared conduit-layer references.
 * No plant name, layer caption or globally meaningful layer id is required. */
export const physicalLayoutViewDefaults = (source: Source, layers: PackPhysicalSceneDescriptor['layers']): PhysicalSceneViewDefaults => {
  const visibleLayerIds = [...new Set([
    ...source.elements.flatMap(element => (element.kind === 'pipe' || element.kind === 'conductor') && element.layerId !== undefined ? [element.layerId] : []),
    ...(source.routing?.connections.map(connection => connection.layerId) ?? []),
  ])].sort()
  const viewDefaults = { visibleLayerIds }
  physicalSceneInitialVisibleLayers({ layers, viewDefaults })
  return viewDefaults
}
