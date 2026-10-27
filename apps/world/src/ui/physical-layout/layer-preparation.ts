interface SceneLayers {
  readonly descriptor: { readonly layers?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined }
  readonly layerPreparation?: { readonly status: 'loading' | 'unavailable'; readonly layerIds: ReadonlyArray<string>; readonly reason?: string }
}
/** A requested representation can remain usable while additional layers prepare. */
export const physicalLayerPreparationText = (scene: SceneLayers): string | null => {
  const pending = scene.layerPreparation
  if (!pending) return null
  const labels = pending.layerIds.map(id => scene.descriptor.layers?.find(layer => layer.id === id)?.label ?? id).join(', ')
  return pending.status === 'loading'
    ? `Preparing additional layers: ${labels}`
    : `Additional layers unavailable: ${labels}${pending.reason ? ` · ${pending.reason}` : ''}`
}
