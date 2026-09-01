import type { PackRuntimeOperationDescriptor, PackRuntimeOperationType } from './protocol.ts'

const titleFor = (id: string): string => {
  const leaf = id.split('.').at(-1) ?? id
  const words = leaf.replaceAll('_', ' ').replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const descriptors = (
  type: PackRuntimeOperationType,
  ids: ReadonlyArray<string>,
): ReadonlyArray<PackRuntimeOperationDescriptor> => ids.map(id => ({
  id,
  type,
  title: titleFor(id),
  description: `${type === 'realtime-input' ? 'Realtime input' : titleFor(type)} ${id}`,
}))

export const definePackRuntimeOperations = (config: {
  readonly commands?: ReadonlyArray<string>
  readonly queries?: ReadonlyArray<string>
  readonly realtimeInputs?: ReadonlyArray<string>
}): ReadonlyArray<PackRuntimeOperationDescriptor> => [
  ...descriptors('command', config.commands ?? []),
  ...descriptors('query', config.queries ?? []),
  ...descriptors('realtime-input', config.realtimeInputs ?? []),
]

export const operationIds = (
  operations: ReadonlyArray<PackRuntimeOperationDescriptor>,
  type: PackRuntimeOperationType,
): ReadonlyArray<string> => operations.filter(operation => operation.type === type).map(operation => operation.id)
