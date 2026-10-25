interface InspectionSource {
  readonly types: ReadonlyArray<{ readonly id: string; readonly parameters: { readonly length: number } }>
  readonly elements: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly disposition?: string | undefined
    readonly fillsId?: string | undefined
    readonly typeId?: string | undefined
    readonly dimensions?: { readonly length: number } | undefined
    readonly override?: { readonly length?: number | undefined } | undefined
  }>
}

/** A source-derived inspection scale: the smallest authored filled access opening.
 * It controls when architectural detail is legible, never engineering clearance or LOD error. */
export const physicalInspectionFeatureMetres = (source: InspectionSource): number | undefined => {
  const elements = new Map(source.elements.map(element => [element.id, element]))
  const types = new Map(source.types.map(type => [type.id, type]))
  let feature: number | undefined
  for (const door of source.elements) {
    if (door.kind !== 'door' || door.disposition === 'removed' || door.fillsId === undefined) continue
    const opening = elements.get(door.fillsId)
    if (opening?.kind !== 'opening' || opening.disposition === 'removed') continue
    const width = opening.override?.length ?? opening.dimensions?.length ?? (opening.typeId === undefined ? undefined : types.get(opening.typeId)?.parameters.length)
    if (width === undefined || !Number.isFinite(width) || width <= 0) throw new Error(`Invalid inspection opening width: ${opening.id}`)
    feature = feature === undefined ? width : Math.min(feature, width)
  }
  return feature
}
