import type { OperationalObject } from '../model/index.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectPresentation, PackTargetContext } from './protocol.ts'

const packForObject = (
  packs: ReadonlyArray<LeitbildPack>,
  object: OperationalObject,
): LeitbildPack | null => {
  const matches = packs.filter(pack => pack.categories.some(category => category.matches(object)))
  if (matches.length > 1) {
    throw new Error(`ambiguous pack ownership for object ${object.id}: ${matches.map(pack => pack.id).join(', ')}`)
  }
  return matches[0] ?? null
}

const assertUniquePackIds = (
  values: ReadonlyArray<{ readonly id: string }>,
  kind: string,
): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${kind}: ${value.id}`)
    seen.add(value.id)
  }
}

const packForCreateType = (
  packs: ReadonlyArray<LeitbildPack>,
  typeId: string,
): LeitbildPack => {
  const matches = packs.filter(pack => pack.createObjectTypes.some(type => type.id === typeId))
  if (matches.length === 0) throw new Error(`unknown create object type: ${typeId}`)
  if (matches.length > 1) {
    throw new Error(`ambiguous create object type ${typeId}: ${matches.map(pack => pack.id).join(', ')}`)
  }
  return matches[0]!
}

const packsForTargetCommand = (
  packs: ReadonlyArray<LeitbildPack>,
  controller: OperationalObject,
  target: OperationalObject,
  context: PackTargetContext,
): ReadonlyArray<LeitbildPack> =>
  packs.filter(pack => pack.isController(controller) && pack.isTarget(controller, target, context))

const packForCancelCommand = (
  packs: ReadonlyArray<LeitbildPack>,
  controller: OperationalObject,
): LeitbildPack => {
  const matches = packs.filter(pack => pack.isController(controller))
  if (matches.length === 0) throw new Error(`no pack can cancel target for ${controller.id}`)
  if (matches.length > 1) {
    throw new Error(`ambiguous cancel target command for ${controller.id}: ${matches.map(pack => pack.id).join(', ')}`)
  }
  return matches[0]!
}

export const createCompositePack = (config: {
  readonly id: string
  readonly name: string
  readonly packs: ReadonlyArray<LeitbildPack>
}): LeitbildPack => {
  if (config.packs.length === 0) throw new Error('composite pack requires at least one pack')
  assertUniquePackIds(config.packs.flatMap(pack => pack.categories), 'object category')
  assertUniquePackIds(config.packs.flatMap(pack => pack.createObjectTypes), 'create object type')
  const primaryPack = config.packs[0]!
  return {
    id: config.id,
    name: config.name,
    domain: 'composite',
    categories: config.packs.flatMap(pack => pack.categories),
    createObjectTypes: config.packs.flatMap(pack => pack.createObjectTypes),
    interactionHandlers: config.packs.flatMap(pack => pack.interactionHandlers ?? []),
    presentObject: (object, context): PackObjectPresentation => {
      const pack = packForObject(config.packs, object)
      const presentation = pack ? pack.presentObject(object, context) : primaryPack.presentObject(object, context)
      const contextualFields = config.packs.flatMap(candidate =>
        candidate.contextualFields?.(object, context) ?? []
      )
      if (contextualFields.length === 0) return presentation
      const existingKeys = new Set(presentation.fields.map(field => field.key))
      return {
        ...presentation,
        fields: [
          ...presentation.fields,
          ...contextualFields.filter(field => !existingKeys.has(field.key)),
        ],
      }
    },
    defaultObjectLabel: (typeId, context): string => {
      return packForCreateType(config.packs, typeId).defaultObjectLabel(typeId, context)
    },
    buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest => {
      return packForCreateType(config.packs, typeId).buildCreateObjectCommand(typeId, label, geometry, parameters)
    },
    isController: (object): boolean =>
      config.packs.some(pack => pack.isController(object)),
    isTarget: (controller, candidate, context): boolean =>
      config.packs.some(pack => pack.isController(controller) && pack.isTarget(controller, candidate, context)),
    buildSetTargetCommand: (controller, target, context): PackCommandRequest => {
      const matches = packsForTargetCommand(config.packs, controller, target, context)
      if (matches.length === 0) throw new Error(`no pack can target ${target.id} from ${controller.id}`)
      if (matches.length > 1) {
        throw new Error(`ambiguous target command from ${controller.id} to ${target.id}: ${matches.map(pack => pack.id).join(', ')}`)
      }
      return matches[0]!.buildSetTargetCommand(controller, target, context)
    },
    buildCancelTargetCommand: (controller, context): PackCommandRequest => {
      return packForCancelCommand(config.packs, controller).buildCancelTargetCommand(controller, context)
    },
  }
}
