import type { OperationalObject } from '../model/index.ts'
import type {
  PackCommandRequest,
  PackCreationGeometry,
  PackCreationContribution,
  PackMapAreaFeature,
  PackPresentationContribution,
  PackQueryRequest,
  PackTargetContext,
  PackTargetingContribution,
  PackSurfacePanelContribution,
  WorldPack,
} from './protocol.ts'

export interface ActivePackViews {
  readonly packs: ReadonlyArray<WorldPack>
  readonly packIds: ReadonlyArray<string>
  readonly presentation: PackPresentationContribution
  readonly creation?: PackCreationContribution
  readonly targeting?: PackTargetingContribution
  readonly referenceDatasetIds: ReadonlyArray<string>
  readonly mapAreaFeatureSourcePackIds: ReadonlyArray<string>
  readonly surfacePanels: ReadonlyArray<PackSurfacePanelContribution>
  readonly packForObject: (object: OperationalObject) => WorldPack
  readonly defaultRuntimeIdFor: (packId: string) => string | undefined
}

const assertUniqueIds = (values: ReadonlyArray<{ readonly id: string }>, kind: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${kind}: ${value.id}`)
    seen.add(value.id)
  }
}

export const createActivePackViews = (packs: ReadonlyArray<WorldPack>): ActivePackViews => {
  if (packs.length === 0) throw new Error('active Pack views require at least one Pack')
  const packsById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  if (packsById.size !== packs.length) throw new Error('active Pack views contain duplicate Pack ids')

  const categories = packs.flatMap(pack => pack.presentation.categories)
  const createObjectTypes = packs.flatMap(pack => pack.creation?.createObjectTypes ?? [])
  assertUniqueIds(categories, 'object category')
  assertUniqueIds(createObjectTypes, 'create object type')

  const creationOwners = new Map<string, PackCreationContribution>()
  for (const pack of packs) {
    if (!pack.creation) continue
    for (const type of pack.creation.createObjectTypes) creationOwners.set(type.id, pack.creation)
  }

  const ownerForObject = (object: OperationalObject): WorldPack => {
    const owner = packsById.get(object.packId)
    if (!owner) throw new Error(`object ${object.id} belongs to inactive Pack ${object.packId}`)
    return owner
  }

  const targetingFor = (object: OperationalObject): PackTargetingContribution | null => {
    const targeting = ownerForObject(object).targeting
    return targeting?.isController(object) === true ? targeting : null
  }

  const mapAreaFeatureLayers = [...new Set(packs.flatMap(pack => pack.presentation.mapAreaFeatureLayers ?? []))]
  const mapAreaFeatureSourcePackIds = [...new Set(packs.flatMap(pack => {
    if (!pack.presentation.mapAreaFeatures && !pack.presentation.mapAreaFeatureQueries) return []
    return pack.presentation.mapAreaFeatureSourcePackIds ?? [pack.descriptor.id]
  }))]
  const mapLayerGroups = packs.flatMap(pack => pack.presentation.mapLayerGroups ?? [])
  assertUniqueIds(mapLayerGroups, 'map layer group')
  const surfacePanels = packs.flatMap(pack => pack.ui?.surfacePanels ?? [])
  assertUniqueIds(surfacePanels, 'surface panel')

  const referenceDatasetIds = [...new Set(packs.flatMap(pack => pack.referenceData?.datasetIds.map(String) ?? []))]
  const hasTargeting = packs.some(pack => pack.targeting !== undefined)

  return {
    packs,
    packIds: packs.map(pack => pack.descriptor.id),
    presentation: {
      categories,
      presentObject: (object, context) => {
        const owner = ownerForObject(object)
        const presentation = owner.presentation.presentObject(object, context)
        if (!categories.some(category => category.id === presentation.categoryId)) {
          throw new Error(`Pack ${owner.descriptor.id} presented object ${object.id} in unknown category ${presentation.categoryId}`)
        }
        if (context.tier !== 'detail') return presentation
        const contextualFields = []
        const existingKeys = new Set(presentation.fields.map(field => field.key))
        for (const pack of packs) {
          for (const field of pack.presentation.contextualFields?.(object, context) ?? []) {
            if (existingKeys.has(field.key)) continue
            existingKeys.add(field.key)
            contextualFields.push(field)
          }
        }
        if (contextualFields.length === 0) return presentation
        return {
          ...presentation,
          fields: [...presentation.fields, ...contextualFields],
        }
      },
      mapAreaFeatures: (context): ReadonlyArray<PackMapAreaFeature> =>
        packs.flatMap(pack => pack.presentation.mapAreaFeatures?.(context) ?? []),
      mapAreaFeatureLayers,
      mapAreaFeatureSourcePackIds,
      mapAreaFeatureQueries: (context): ReadonlyArray<PackQueryRequest> => {
        const requests = packs.flatMap(pack => pack.presentation.mapAreaFeatureQueries?.(context) ?? [])
        for (const request of requests) {
          if (!packsById.has(request.packId)) throw new Error(`map feature query targets inactive Pack ${request.packId}`)
        }
        return requests
      },
      mapLayerGroups,
    },
    ...(createObjectTypes.length === 0
      ? {}
      : {
          creation: {
            createObjectTypes,
            defaultObjectLabel: (typeId, context): string => {
              const owner = creationOwners.get(typeId)
              if (!owner) throw new Error(`unknown create object type: ${typeId}`)
              return owner.defaultObjectLabel(typeId, context)
            },
            buildCreateObjectCommand: (
              typeId: string,
              label: string,
              geometry: PackCreationGeometry,
              parameters?: unknown,
            ): PackCommandRequest => {
              const owner = creationOwners.get(typeId)
              if (!owner) throw new Error(`unknown create object type: ${typeId}`)
              return owner.buildCreateObjectCommand(typeId, label, geometry, parameters)
            },
          },
        }),
    ...(hasTargeting
      ? {
          targeting: {
            isController: (object: OperationalObject) => targetingFor(object) !== null,
            isTarget: (controller: OperationalObject, candidate: OperationalObject, context: PackTargetContext) =>
              targetingFor(controller)?.isTarget(controller, candidate, context) ?? false,
            buildSetTargetCommand: (controller: OperationalObject, target: OperationalObject, context: PackTargetContext) => {
              const targeting = targetingFor(controller)
              if (!targeting || !targeting.isTarget(controller, target, context)) {
                throw new Error(`no active Pack can target ${target.id} from ${controller.id}`)
              }
              return targeting.buildSetTargetCommand(controller, target, context)
            },
            buildCancelTargetCommand: (controller: OperationalObject, context: PackTargetContext) => {
              const targeting = targetingFor(controller)
              if (!targeting) throw new Error(`no active Pack can cancel targeting for ${controller.id}`)
              return targeting.buildCancelTargetCommand(controller, context)
            },
          },
        }
      : {}),
    referenceDatasetIds,
    mapAreaFeatureSourcePackIds,
    surfacePanels,
    packForObject: ownerForObject,
    defaultRuntimeIdFor: packId => packsById.get(packId)?.runtime?.defaultRuntimeId,
  }
}
