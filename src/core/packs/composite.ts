import type { OperationalObject } from '../model/index.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectPresentation } from './protocol.ts'

const packForObject = (
  packs: ReadonlyArray<LeitbildPack>,
  object: OperationalObject,
): LeitbildPack | null =>
  packs.find(pack => pack.categories.some(category => category.matches(object))) ?? null

export const createCompositePack = (config: {
  readonly id: string
  readonly name: string
  readonly packs: ReadonlyArray<LeitbildPack>
}): LeitbildPack => {
  if (config.packs.length === 0) throw new Error('composite pack requires at least one pack')
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
      if (pack) return pack.presentObject(object, context)
      return primaryPack.presentObject(object, context)
    },
    defaultObjectLabel: (typeId, context): string => {
      const pack = config.packs.find(candidate => candidate.createObjectTypes.some(type => type.id === typeId))
      if (!pack) throw new Error(`unknown create object type: ${typeId}`)
      return pack.defaultObjectLabel(typeId, context)
    },
    buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest => {
      const pack = config.packs.find(candidate => candidate.createObjectTypes.some(type => type.id === typeId))
      if (!pack) throw new Error(`unknown create object type: ${typeId}`)
      return pack.buildCreateObjectCommand(typeId, label, geometry, parameters)
    },
    isController: (object): boolean =>
      config.packs.some(pack => pack.isController(object)),
    isTarget: (controller, candidate, context): boolean =>
      config.packs.some(pack => pack.isController(controller) && pack.isTarget(controller, candidate, context)),
    buildSetTargetCommand: (controller, target, context): PackCommandRequest => {
      const pack = config.packs.find(candidate => candidate.isController(controller) && candidate.isTarget(controller, target, context))
      if (!pack) throw new Error(`no pack can target ${target.id} from ${controller.id}`)
      return pack.buildSetTargetCommand(controller, target, context)
    },
    buildCancelTargetCommand: (controller, context): PackCommandRequest => {
      const pack = config.packs.find(candidate => candidate.isController(controller))
      if (!pack) throw new Error(`no pack can cancel target for ${controller.id}`)
      return pack.buildCancelTargetCommand(controller, context)
    },
  }
}
