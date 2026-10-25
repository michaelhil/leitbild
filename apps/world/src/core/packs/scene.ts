import { z } from 'zod'

const vector3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const coordinatesSchema = z.array(z.number().finite()).max(6_000_000)
const identifierSchema = z.string().min(1).max(200)

export const physicalSceneBoundsSchema = z.object({ min: vector3Schema, max: vector3Schema }).strict()
  .refine(({ min, max }) => min.every((value, index) => value <= max[index]!), 'Bounds must be ordered')

export const physicalSceneLevelSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(200),
  elevation: z.number().finite(),
  /** Absolute local Z of the inspection cut, in metres. */
  cutHeight: z.number().finite(),
}).strict().refine(level => level.cutHeight > level.elevation, 'A level cut must be above its floor')

const physicalFeatureStrokeSchema = z.object({
  positions: coordinatesSchema,
  material: identifierSchema.optional(),
}).strict().refine(line => line.positions.length % 6 === 0, 'Feature strokes must contain xyz segment pairs')

/** Source-derived navigation structure, independent of runtime ownership. */
export const physicalSceneScopeSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(300),
  kind: z.enum(['site', 'unit', 'building', 'space', 'assembly']),
  parentId: identifierSchema.optional(),
  bounds: physicalSceneBoundsSchema,
  levelIds: z.array(identifierSchema),
}).strict()

export const physicalSceneObjectSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(300),
  kind: identifierSchema,
  levelId: identifierSchema,
  /** Local right-handed coordinates: X east, Y north, Z up, in metres. */
  positions: coordinatesSchema,
  indices: z.array(z.number().int().nonnegative()).max(6_000_000).optional(),
  normals: coordinatesSchema.optional(),
  subjectIds: z.array(identifierSchema).max(256),
  /** Palette roles, resolved from the active display's tokens. Never literal colours. */
  material: identifierSchema.optional(),
  materials: z.array(identifierSchema).min(1).max(32).optional(),
  materialIndices: z.array(z.number().int().nonnegative()).max(2_000_000).optional(),
  /** Physical membership and vertical applicability, not a duplicated occurrence per floor. */
  scopeIds: z.array(identifierSchema).optional(),
  levelIds: z.array(identifierSchema).optional(),
  bounds: physicalSceneBoundsSchema.optional(),
  /** Intentional 3D illustration features; section contours are derived separately. */
  featureLines: z.array(physicalFeatureStrokeSchema).optional(),
  edgePolicy: z.enum(['authored', 'crease', 'none']).optional(),
  /** Named representation layer, separate from operational status or source disposition. */
  layerId: identifierSchema.optional(),
  /** Complete authored 2D stroke representation; xyz pairs are independent segments.
   * When present it replaces 3D feature strokes in Plan, rather than adding them again. */
  planLines: z.array(z.object({ positions: coordinatesSchema, material: identifierSchema.optional() }).strict()).max(1000).optional(),
}).strict().superRefine((object, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  if (object.positions.length % 3) issue('Positions must contain xyz vertices')
  const vertices = object.positions.length / 3
  if (object.indices) {
    if (object.indices.length % 3 || object.indices.some(index => index >= vertices)) issue('Indices must address complete triangles')
  } else if (vertices % 3) issue('Unindexed geometry must contain complete triangles')
  if (object.normals && object.normals.length !== object.positions.length) issue('Normals must match positions')
  if (object.materialIndices && (!object.materials || object.materialIndices.length !== vertices || object.materialIndices.some(index => index >= object.materials!.length))) issue('Material indices must address one palette role per vertex')
  for (const line of object.planLines ?? []) if (line.positions.length % 6) issue('Plan lines must contain xyz segment pairs')
})

/** Immutable delivery geometry; state is read separately from the owning Run. */
export const packPhysicalSceneSchema = z.object({
  id: identifierSchema,
  revision: identifierSchema,
  targetObjectId: identifierSchema,
  anchor: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)]),
  /** Clockwise geographic bearing of local north, in degrees. */
  bearing: z.number().finite(),
  bounds: physicalSceneBoundsSchema,
  levels: z.array(physicalSceneLevelSchema).min(1).max(128),
  scopes: z.array(physicalSceneScopeSchema).optional(),
  layers: z.array(z.object({ id: identifierSchema, label: z.string().min(1).max(200), defaultVisible: z.boolean() }).strict()).optional(),
  /** Authored placement grouping; a reusable geometry template has no site owner. */
  group: z.object({ id: identifierSchema, label: z.string().min(1).max(300) }).strict().optional(),
  objects: z.array(physicalSceneObjectSchema).max(20_000),
}).strict().superRefine((scene, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const levelIds = new Set(scene.levels.map(level => level.id))
  const scopes = new Map((scene.scopes ?? []).map(scope => [scope.id, scope]))
  const layers = new Set((scene.layers ?? []).map(layer => layer.id))
  if (layers.size !== (scene.layers?.length ?? 0)) issue('Physical representation layer IDs must be unique')
  if (scopes.size !== (scene.scopes?.length ?? 0)) issue('Scope IDs must be unique')
  for (const scope of scopes.values()) {
    if (new Set(scope.levelIds).size !== scope.levelIds.length || scope.levelIds.some(id => !levelIds.has(id))) issue(`Invalid scope levels: ${scope.id}`)
    const ancestors = new Set([scope.id])
    let parent = scope.parentId
    while (parent !== undefined) {
      if (ancestors.has(parent)) { issue(`Cyclic physical scope: ${scope.id}`); break }
      ancestors.add(parent)
      const next = scopes.get(parent)
      if (next === undefined) { issue(`Unknown physical scope parent: ${scope.id}`); break }
      parent = next.parentId
    }
  }
  if (levelIds.size !== scene.levels.length) issue('Level IDs must be unique')
  if (new Set(scene.objects.map(object => object.id)).size !== scene.objects.length) issue('Occurrence IDs must be unique')
  let coordinateCount = 0
  for (const object of scene.objects) {
    if (object.levelId !== 'site' && !levelIds.has(object.levelId)) issue(`Unknown level: ${object.levelId}`)
    coordinateCount += object.positions.length
    if (object.scopeIds && (new Set(object.scopeIds).size !== object.scopeIds.length || object.scopeIds.some(id => !scopes.has(id)))) issue(`Unknown or duplicate occurrence scope: ${object.id}`)
    if (object.layerId !== undefined && !layers.has(object.layerId)) issue(`Unknown physical representation layer: ${object.id}`)
    if (object.levelIds && (new Set(object.levelIds).size !== object.levelIds.length || object.levelIds.some(id => id !== 'site' && !levelIds.has(id)))) issue(`Invalid occurrence levels: ${object.id}`)
    for (const line of object.featureLines ?? []) coordinateCount += line.positions.length
    for (let index = 0; index < object.positions.length; index++) {
      const axis = index % 3
      if (object.positions[index]! < scene.bounds.min[axis]! - 0.001 || object.positions[index]! > scene.bounds.max[axis]! + 0.001) { issue(`Occurrence outside declared bounds: ${object.id}`); break }
    }
  }
  if (coordinateCount > 6_000_000) issue('Scene exceeds the bounded delivery budget')
})

export type PackPhysicalScene = z.infer<typeof packPhysicalSceneSchema>
export type PhysicalSceneObject = z.infer<typeof physicalSceneObjectSchema>
export type PhysicalSceneLevel = z.infer<typeof physicalSceneLevelSchema>
export type PhysicalSceneBounds = z.infer<typeof physicalSceneBoundsSchema>
export type PhysicalSceneScope = z.infer<typeof physicalSceneScopeSchema>

/** Small authored building outlines, available before triangle geometry is loaded. */
export const physicalOverviewFootprintSchema = z.object({
  id: identifierSchema,
  /** Declared hierarchy membership; renderers never infer it from the footprint ID. */
  scopeId: identifierSchema.optional(),
  label: z.string().min(1).max(300),
  ring: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(4).max(1024),
  base: z.number().finite(),
  height: z.number().finite().positive(),
}).strict().refine(value => {
  const first = value.ring[0]!, last = value.ring.at(-1)!
  return first[0] === last[0] && first[1] === last[1]
}, 'Overview footprint rings must be closed')
export type PhysicalOverviewFootprint = z.infer<typeof physicalOverviewFootprintSchema>

/** Cheap placement/LOD/owner metadata; obtaining it never compiles triangle geometry. */
export interface PackPhysicalSceneDescriptor extends Omit<PackPhysicalScene, 'objects'> {
  /** Exact Pack-qualified reusable render identity, separate from placement/owner. */
  readonly geometryKey?: string
  /** Conservative physical error of the overview representation, in metres. */
  readonly overviewGeometricErrorMetres?: number
  /** Authored inspection-feature size for automatic legibility demand, not geometric error.
   * Missing metadata leaves automatic inspection unsupported; explicit focus still works. */
  readonly inspectionFeatureMetres?: number
  readonly locationValid: boolean
  readonly reason?: string
  readonly subjectIds: ReadonlyArray<string>
  readonly modelDigest: string
  /** Additional immutable owner requirements; these do not create another live-state authority. */
  readonly relatedTargets?: ReadonlyArray<{ readonly objectId: string; readonly packId: string; readonly modelDigest: string }>
  /** Exact topology required by authored physical routing; IDs and labels are not endpoint correspondence. */
  readonly requiredConnections?: ReadonlyArray<{
    readonly system: { readonly objectId: string; readonly portId: string }
    readonly network: { readonly objectId: string; readonly portId: string }
  }>
  readonly overviewFootprints?: ReadonlyArray<PhysicalOverviewFootprint>
}
