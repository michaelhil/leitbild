/** Remove only explicit styling slots. Unknown/new source facts remain physical, fail closed. */
export const physicalSourceFacts = (value: unknown): unknown => Array.isArray(value) ? value.map(physicalSourceFacts)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'material').map(([key, child]) => [key, physicalSourceFacts(child)])) : value

// Cross-engine trigonometry may differ below a micrometre. This is an explicit
// fingerprint precision, not a checking tolerance or a claim of surveyed accuracy.
const shapeCoordinateResolutionMetres = 1e-6
/** Compiled positions catch a recipe changing physical form under unchanged dimensions. */
export const physicalShapeFacts = (objects: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly levelId: string; readonly positions: ReadonlyArray<number> }>) =>
  ({ coordinateResolutionMetres: shapeCoordinateResolutionMetres, objects: objects.map(({ id, kind, levelId, positions }) => ({ id, kind, levelId,
    positions: positions.map(value => Math.round(value / shapeCoordinateResolutionMetres) * shapeCoordinateResolutionMetres) })) })

export const physicalApplicabilityContent = (input: {
  readonly physicalApplicability: { readonly sourceDigest: string; readonly geometryDigest: string }
  readonly bindingDigest: string
  readonly modelRequirement: { readonly modelRef: string; readonly modelDigest: string }
  readonly coverageDigest: string
  readonly requirements: unknown
}) => ({ physicalSourceDigest: input.physicalApplicability.sourceDigest, physicalGeometryDigest: input.physicalApplicability.geometryDigest,
  bindingDigest: input.bindingDigest, modelRequirement: input.modelRequirement, coverageDigest: input.coverageDigest, requirements: input.requirements })
