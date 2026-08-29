import type { OperationalObject } from '../model/index.ts'
import {
  createLeitbildPackDescriptor,
  type LeitbildPack,
  type PackCommandRequest,
  type PackCreationGeometry,
  type PackMapAreaFeature,
  type PackObjectPresentation,
  type PackQueryRequest,
  type PackTargetContext,
} from './protocol.ts'

const packId = (pack: LeitbildPack): string => pack.descriptor.id

const packForObject = (packs: ReadonlyArray<LeitbildPack>, object: OperationalObject): LeitbildPack | null => {
  const matches = packs.filter(pack => pack.presentation.categories.some(category => category.matches(object)))
  if (matches.length > 1) throw new Error(`ambiguous pack ownership for object ${object.id}: ${matches.map(packId).join(', ')}`)
  return matches[0] ?? null
}

const assertUniqueIds = (values: ReadonlyArray<{ readonly id: string }>, kind: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${kind}: ${value.id}`)
    seen.add(value.id)
  }
}

const packForCreateType = (packs: ReadonlyArray<LeitbildPack>, typeId: string): LeitbildPack => {
  const matches = packs.filter(pack => pack.commands.createObjectTypes.some(type => type.id === typeId))
  if (matches.length === 0) throw new Error(`unknown create object type: ${typeId}`)
  if (matches.length > 1) throw new Error(`ambiguous create object type ${typeId}: ${matches.map(packId).join(', ')}`)
  return matches[0]!
}

const packsForTargetCommand = (
  packs: ReadonlyArray<LeitbildPack>,
  controller: OperationalObject,
  target: OperationalObject,
  context: PackTargetContext,
): ReadonlyArray<LeitbildPack> =>
  packs.filter(pack => pack.commands.isController(controller) && pack.commands.isTarget(controller, target, context))

const packForCancelCommand = (packs: ReadonlyArray<LeitbildPack>, controller: OperationalObject): LeitbildPack => {
  const matches = packs.filter(pack => pack.commands.isController(controller))
  if (matches.length === 0) throw new Error(`no pack can cancel target for ${controller.id}`)
  if (matches.length > 1) throw new Error(`ambiguous cancel target command for ${controller.id}: ${matches.map(packId).join(', ')}`)
  return matches[0]!
}

export const createCompositePack = (config: {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly packs: ReadonlyArray<LeitbildPack>
}): LeitbildPack => {
  if (config.packs.length === 0) throw new Error('composite pack requires at least one pack')
  assertUniqueIds(config.packs.flatMap(pack => pack.presentation.categories), 'object category')
  assertUniqueIds(config.packs.flatMap(pack => pack.commands.createObjectTypes), 'create object type')
  const primaryPack = config.packs[0]!

  const mapAreaFeatureLayers = (() => {
    const seen = new Set<string>()
    const output: NonNullable<LeitbildPack['presentation']['mapAreaFeatureLayers']>[number][] = []
    for (const pack of config.packs) {
      for (const layer of pack.presentation.mapAreaFeatureLayers ?? []) {
        if (seen.has(layer)) continue
        seen.add(layer)
        output.push(layer)
      }
    }
    return output
  })()

  const mapAreaFeatureSourcePackIds = (() => {
    const seen = new Set<string>()
    const output: string[] = []
    for (const pack of config.packs) {
      const presentation = pack.presentation
      if (!presentation.mapAreaFeatures && !presentation.mapAreaFeatureQueries) continue
      for (const sourceId of presentation.mapAreaFeatureSourcePackIds ?? [packId(pack)]) {
        if (seen.has(sourceId)) continue
        seen.add(sourceId)
        output.push(sourceId)
      }
    }
    return output
  })()

  const mapLayerGroups = (() => {
    const seen = new Set<string>()
    const output: NonNullable<LeitbildPack['presentation']['mapLayerGroups']>[number][] = []
    for (const pack of config.packs) {
      for (const group of pack.presentation.mapLayerGroups ?? []) {
        if (seen.has(group.id)) throw new Error(`composite pack ${config.id}: duplicate map layer group id "${group.id}"`)
        seen.add(group.id)
        output.push(group)
      }
    }
    return output
  })()

  const referenceBuilders = config.packs.flatMap(pack => pack.referenceData?.builders ?? [])
  const referenceDatasetIds = (() => {
    const seen = new Set<string>()
    return config.packs.flatMap(pack => pack.referenceData?.datasetIds ?? []).filter(id => {
      const key = String(id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()
  const wikiRefs = config.packs.flatMap(pack => pack.knowledge?.wikiRefs ?? [])

  return {
    descriptor: createLeitbildPackDescriptor({
      id: config.id,
      version: config.version,
      name: config.name,
      contributions: ['knowledge', 'reference-data', 'presentation', 'commands', 'interactions'],
    }),
    ...(wikiRefs.length === 0 ? {} : { knowledge: { wikiRefs } }),
    ...(referenceBuilders.length === 0 && referenceDatasetIds.length === 0
      ? {}
      : { referenceData: { builders: referenceBuilders, datasetIds: referenceDatasetIds } }),
    presentation: {
      categories: config.packs.flatMap(pack => pack.presentation.categories),
      presentObject: (object, context): PackObjectPresentation => {
        const owner = packForObject(config.packs, object)
        const presentation = (owner ?? primaryPack).presentation.presentObject(object, context)
        if (context.tier !== 'detail') return presentation
        const contextualFields = config.packs.flatMap(pack => pack.presentation.contextualFields?.(object, context) ?? [])
        if (contextualFields.length === 0) return presentation
        const existingKeys = new Set(presentation.fields.map(field => field.key))
        return {
          ...presentation,
          fields: [...presentation.fields, ...contextualFields.filter(field => !existingKeys.has(field.key))],
        }
      },
      mapAreaFeatures: (context): ReadonlyArray<PackMapAreaFeature> =>
        config.packs.flatMap(pack => pack.presentation.mapAreaFeatures?.(context) ?? []),
      mapAreaFeatureLayers,
      mapAreaFeatureSourcePackIds,
      mapAreaFeatureQueries: (context): ReadonlyArray<PackQueryRequest> =>
        config.packs.flatMap(pack => pack.presentation.mapAreaFeatureQueries?.(context) ?? []),
      mapLayerGroups,
    },
    commands: {
      createObjectTypes: config.packs.flatMap(pack => pack.commands.createObjectTypes),
      defaultObjectLabel: (typeId, context): string =>
        packForCreateType(config.packs, typeId).commands.defaultObjectLabel(typeId, context),
      buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest =>
        packForCreateType(config.packs, typeId).commands.buildCreateObjectCommand(typeId, label, geometry, parameters),
      isController: object => config.packs.some(pack => pack.commands.isController(object)),
      isTarget: (controller, candidate, context) =>
        config.packs.some(pack => pack.commands.isController(controller) && pack.commands.isTarget(controller, candidate, context)),
      buildSetTargetCommand: (controller, target, context): PackCommandRequest => {
        const matches = packsForTargetCommand(config.packs, controller, target, context)
        if (matches.length === 0) throw new Error(`no pack can target ${target.id} from ${controller.id}`)
        if (matches.length > 1) throw new Error(`ambiguous target command from ${controller.id} to ${target.id}: ${matches.map(packId).join(', ')}`)
        return matches[0]!.commands.buildSetTargetCommand(controller, target, context)
      },
      buildCancelTargetCommand: (controller, context): PackCommandRequest =>
        packForCancelCommand(config.packs, controller).commands.buildCancelTargetCommand(controller, context),
    },
    interactions: {
      handlers: config.packs.flatMap(pack => pack.interactions?.handlers ?? []),
    },
  }
}
