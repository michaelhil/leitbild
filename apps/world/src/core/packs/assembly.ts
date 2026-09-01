import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { operationIds } from '../../simulation/operations.ts'
import type { WorldPack } from './protocol.ts'

export interface ValidatedWorldAssembly {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}

const assertUnique = (ids: ReadonlyArray<string>, kind: string): void => {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate ${kind}: ${id}`)
    seen.add(id)
  }
}

const declaredContributionIds = (pack: WorldPack): ReadonlyArray<string> => [
  ...(pack.runtime ? ['runtime'] : []),
  ...(pack.knowledge ? ['knowledge'] : []),
  ...(pack.referenceData ? ['reference-data'] : []),
  ...(pack.scenario || pack.authoring ? ['scenario'] : []),
  'presentation',
  ...(pack.creation ? ['creation'] : []),
  ...(pack.targeting ? ['targeting'] : []),
  ...(pack.interactions ? ['interactions'] : []),
]

const assertContributionDescriptor = (pack: WorldPack): void => {
  const declared = pack.descriptor.contributions.map(contribution => contribution.kind).sort()
  const actual = [...declaredContributionIds(pack)].sort()
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error(`Pack ${pack.descriptor.id} contribution descriptor mismatch: declared ${declared.join(', ')}, actual ${actual.join(', ')}`)
  }
}

export const validateWorldAssembly = (config: {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}): ValidatedWorldAssembly => {
  assertUnique(config.packs.map(pack => pack.descriptor.id), 'Pack id')
  assertUnique(config.runtimeAdapters.map(adapter => adapter.id), 'Pack Runtime id')

  const adaptersById = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
  const packsById = new Map(config.packs.map(pack => [pack.descriptor.id, pack]))
  for (const adapter of config.runtimeAdapters) {
    const pack = packsById.get(adapter.packId)
    if (!pack) throw new Error(`Pack Runtime ${adapter.id} references unknown Pack ${adapter.packId}`)
    if (!pack.runtime?.runtimes.some(runtime => runtime.id === adapter.id)) {
      throw new Error(`Pack Runtime ${adapter.id} is not declared by Pack ${adapter.packId}`)
    }
    assertUnique(adapter.operations.map(operation => `${operation.type}:${operation.id}`), `operation in Pack Runtime ${adapter.id}`)
    for (const operation of adapter.operations) {
      if (operation.id.trim() === '' || operation.title.trim() === '' || operation.description.trim() === '') {
        throw new Error(`Pack Runtime ${adapter.id} has incomplete ${operation.type} operation metadata`)
      }
    }
    const commandIds = new Set(operationIds(adapter.operations, 'command'))
    for (const commandId of Object.keys(adapter.commandEventHistory ?? {})) {
      if (!commandIds.has(commandId)) {
        throw new Error(`Pack Runtime ${adapter.id} configures history for undeclared command ${commandId}`)
      }
    }
  }

  const packs = config.packs.map(pack => {
    if (pack.runtime && !pack.runtime.runtimes.some(runtime => runtime.id === pack.runtime!.defaultRuntimeId)) {
      throw new Error(`Pack ${pack.descriptor.id} default runtime is not declared: ${pack.runtime.defaultRuntimeId}`)
    }
    const availableRuntimes = (pack.runtime?.runtimes ?? []).filter(runtime => adaptersById.has(runtime.id))
    for (const runtime of availableRuntimes) {
      const adapter = adaptersById.get(runtime.id)!
      if (adapter.packId !== pack.descriptor.id) {
        throw new Error(`Pack Runtime ${runtime.id} belongs to ${adapter.packId}, not ${pack.descriptor.id}`)
      }
      if (adapter.version !== runtime.version) {
        throw new Error(`Pack Runtime ${runtime.id} version mismatch: catalog ${runtime.version}, adapter ${adapter.version}`)
      }
      if (adapter.clock !== runtime.clock) {
        throw new Error(`Pack Runtime ${runtime.id} clock mismatch: catalog ${runtime.clock}, adapter ${adapter.clock}`)
      }
    }
    if (!pack.runtime || availableRuntimes.length === pack.runtime.runtimes.length) return pack
    const { runtime: _runtime, ...withoutRuntime } = pack
    if (availableRuntimes.length === 0) return withoutRuntime as WorldPack
    if (!availableRuntimes.some(runtime => runtime.id === pack.runtime!.defaultRuntimeId)) {
      throw new Error(`Pack ${pack.descriptor.id} default runtime is unavailable: ${pack.runtime.defaultRuntimeId}`)
    }
    return {
      ...withoutRuntime,
      runtime: { runtimes: availableRuntimes, defaultRuntimeId: pack.runtime.defaultRuntimeId },
    } as WorldPack
  })

  for (const pack of packs) assertContributionDescriptor(pack)
  assertUnique(packs.flatMap(pack => pack.presentation.categories.map(category => category.id)), 'object category id')
  assertUnique(packs.flatMap(pack => pack.creation?.createObjectTypes.map(type => type.id) ?? []), 'create object type id')
  assertUnique(packs.flatMap(pack => pack.interactions?.handlers.map(handler => handler.id) ?? []), 'interaction handler id')
  const categoryIds = new Set(packs.flatMap(pack => pack.presentation.categories.map(category => category.id)))
  for (const type of packs.flatMap(pack => pack.creation?.createObjectTypes ?? [])) {
    if (!categoryIds.has(type.categoryId)) {
      throw new Error(`create object type ${type.id} references unknown category ${type.categoryId}`)
    }
  }

  for (const [routeType, routesFor] of [
    ['command', (adapter: PackRuntimeAdapter) => operationIds(adapter.operations, 'command')],
    ['realtime input', (adapter: PackRuntimeAdapter) => operationIds(adapter.operations, 'realtime-input')],
  ] as const) {
    const owners = new Map<string, string>()
    for (const adapter of config.runtimeAdapters) {
      for (const route of routesFor(adapter)) {
        const ownerPackId = owners.get(route)
        if (ownerPackId && ownerPackId !== adapter.packId) {
          throw new Error(`${routeType} route ${route} is claimed by Packs ${ownerPackId} and ${adapter.packId}`)
        }
        owners.set(route, adapter.packId)
      }
    }
  }

  return { packs, runtimeAdapters: config.runtimeAdapters }
}
