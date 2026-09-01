import type { CompiledComponent, CompiledVariable, VariablePath } from '../graph/index.ts'
import { deriveProcessVariableCapabilities } from '../graph/index.ts'
import type { CompiledProcessPlant, ProcessPlantInitialVariableValue } from '../plant-compiler.ts'
import type { ProcessPlantCommand, ProcessPlantValue, ProcessPlantVariableSnapshot } from './model.ts'
import { toCanonicalProcessValue } from './units.ts'
import {
  assertProcessPlantVariableValueValid,
} from './variable-validation.ts'

export interface ProcessPlantVariableTable {
  readonly queueCommand: (command: ProcessPlantCommand) => void
  readonly applyQueuedCommands: () => void
  readonly resolve: (path: VariablePath) => ProcessPlantVariableHandle
  readonly has: (path: VariablePath) => boolean
  readonly read: (path: VariablePath) => ProcessPlantValue
  readonly readHandle: (handle: ProcessPlantVariableHandle) => ProcessPlantValue
  readonly readNumber: (path: VariablePath) => number
  readonly readNumberHandle: (handle: ProcessPlantVariableHandle) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readBooleanHandle: (handle: ProcessPlantVariableHandle) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
  readonly write: (path: VariablePath, value: ProcessPlantValue) => void
  readonly queuedCommands: () => ReadonlyArray<ProcessPlantCommand>
  readonly snapshotVariable: (path: VariablePath) => ProcessPlantVariableSnapshot
  readonly snapshotHandle: (handle: ProcessPlantVariableHandle) => ProcessPlantVariableSnapshot
  readonly snapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
  readonly snapshotValues: () => ReadonlyArray<ProcessPlantValue>
  readonly publishedSnapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
  readonly assertInvariants: () => void
}

export interface ProcessPlantVariableHandle {
  readonly path: VariablePath
  readonly variable: CompiledVariable
  readonly slot: number
}

const snapshotVariable = (
  values: ReadonlyArray<ProcessPlantValue>,
  variable: CompiledVariable,
  slot: number,
): ProcessPlantVariableSnapshot => {
  const value = values[slot]
  if (value === undefined) throw new Error(`variable ${variable.path} has no runtime value`)
  return {
    path: variable.path,
    label: variable.descriptor.label,
    value,
    canonicalValue: toCanonicalProcessValue(value, variable.descriptor.unit),
    quantity: variable.descriptor.quantity,
    unit: variable.descriptor.unit,
    discipline: variable.descriptor.discipline,
    kind: variable.descriptor.kind,
    writable: variable.descriptor.writable,
    published: variable.published,
    ...(variable.descriptor.tagId === undefined ? {} : { tagId: variable.descriptor.tagId }),
    ...(variable.descriptor.equipmentId === undefined ? {} : { equipmentId: variable.descriptor.equipmentId }),
    ...(variable.descriptor.description === undefined ? {} : { description: variable.descriptor.description }),
    ...(variable.descriptor.externalRefs === undefined ? {} : { externalRefs: variable.descriptor.externalRefs }),
    capabilities: deriveProcessVariableCapabilities({ descriptor: variable.descriptor, published: variable.published }),
    ...(variable.descriptor.limits === undefined ? {} : { limits: variable.descriptor.limits }),
  }
}

export const createProcessPlantVariableTable = (
  system: CompiledProcessPlant,
  initialComponentValueFor: (component: CompiledComponent, path: VariablePath) => ProcessPlantValue,
  restoredValues?: ReadonlyArray<ProcessPlantValue>,
  restoredCommands?: ReadonlyArray<ProcessPlantCommand>,
  initialVariables?: ReadonlyArray<ProcessPlantInitialVariableValue>,
): ProcessPlantVariableTable => {
  const variables = system.graph.variables
  const variableByPath = new Map(variables.map((variable, slot) => [variable.path, { path: variable.path, variable, slot } satisfies ProcessPlantVariableHandle]))
  const publishedHandles = variables.flatMap((variable, slot) =>
    variable.published ? [{ path: variable.path, variable, slot } satisfies ProcessPlantVariableHandle] : []
  )
  const values: ProcessPlantValue[] = new Array(variables.length)
  const commands: ProcessPlantCommand[] = []
  if (restoredValues !== undefined && restoredValues.length !== variables.length) {
    throw new Error(`restored process plant value count ${restoredValues.length} does not match model variable count ${variables.length}`)
  }

  for (let slot = 0; slot < variables.length; slot += 1) {
    const variable = variables[slot]
    if (!variable) throw new Error(`compiled process plant graph has missing variable slot: ${slot}`)
    const restoredValue = restoredValues?.[slot]
    if (restoredValue !== undefined) {
      assertProcessPlantVariableValueValid(variable, restoredValue)
      values[slot] = restoredValue
      continue
    }
    if (variable.owner.type === 'component') {
      const component = system.graph.components[variable.owner.componentIndex]
      if (!component) throw new Error(`variable ${variable.path} references missing component index ${variable.owner.componentIndex}`)
      values[slot] = initialComponentValueFor(component, variable.path)
      continue
    }
    if (variable.initialValue === undefined) throw new Error(`process link variable ${variable.path} has no initial value`)
    values[slot] = variable.initialValue
  }

  if (restoredValues === undefined) {
    for (const initial of initialVariables ?? []) {
      const entry = variableByPath.get(initial.path)
      if (!entry) throw new Error(`process plant initialState references unknown variable: ${initial.path}`)
      assertProcessPlantVariableValueValid(entry.variable, initial.value)
      values[entry.slot] = initial.value
    }
  }

  const assertHandleMatchesTable = (handle: ProcessPlantVariableHandle): void => {
    if (variables[handle.slot] !== handle.variable) {
      throw new Error(`process plant variable handle does not match this runtime table: ${handle.path}`)
    }
  }

  const resolve = (path: VariablePath): ProcessPlantVariableHandle => {
    const entry = variableByPath.get(path)
    if (!entry) throw new Error(`unknown process plant variable: ${path}`)
    return entry
  }

  const readResolved = (handle: ProcessPlantVariableHandle): ProcessPlantValue => {
    const value = values[handle.slot]
    if (value === undefined) throw new Error(`variable ${handle.path} has no runtime value`)
    return value
  }

  const readHandle = (handle: ProcessPlantVariableHandle): ProcessPlantValue => {
    assertHandleMatchesTable(handle)
    return readResolved(handle)
  }

  const read = (path: VariablePath): ProcessPlantValue => readResolved(resolve(path))

  const readResolvedNumber = (handle: ProcessPlantVariableHandle): number => {
    const value = readResolved(handle)
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`variable ${handle.path} is not numeric`)
    return value
  }

  const readResolvedBoolean = (handle: ProcessPlantVariableHandle): boolean => {
    const value = readResolved(handle)
    if (typeof value !== 'boolean') throw new Error(`variable ${handle.path} is not boolean`)
    return value
  }

  const readNumberHandle = (handle: ProcessPlantVariableHandle): number => {
    assertHandleMatchesTable(handle)
    return readResolvedNumber(handle)
  }

  const readBooleanHandle = (handle: ProcessPlantVariableHandle): boolean => {
    assertHandleMatchesTable(handle)
    return readResolvedBoolean(handle)
  }

  const write = (path: VariablePath, value: ProcessPlantValue): void => {
    const entry = resolve(path)
    assertProcessPlantVariableValueValid(entry.variable, value)
    values[entry.slot] = value
  }

  const queueCommand = (command: ProcessPlantCommand): void => {
    const entry = variableByPath.get(command.path)
    if (!entry) throw new Error(`unknown process plant variable: ${command.path}`)
    if (!entry.variable.descriptor.writable) throw new Error(`process plant variable is not writable: ${command.path}`)
    assertProcessPlantVariableValueValid(entry.variable, command.value)
    commands.push(command)
  }

  for (const command of restoredCommands ?? []) queueCommand(command)

  return {
    queueCommand,
    applyQueuedCommands: (): void => {
      for (const command of commands.splice(0)) {
        write(command.path, command.value)
      }
    },
    resolve,
    has: (path: VariablePath): boolean => variableByPath.has(path),
    read,
    readHandle,
    readNumber: (path: VariablePath): number => readResolvedNumber(resolve(path)),
    readNumberHandle,
    readBoolean: (path: VariablePath): boolean => readResolvedBoolean(resolve(path)),
    readBooleanHandle,
    readOptionalNumber: (path: VariablePath, defaultValue: number): number => {
      if (!variableByPath.has(path)) return defaultValue
      const value = read(path)
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`variable ${path} is not numeric`)
      return value
    },
    write,
    queuedCommands: (): ReadonlyArray<ProcessPlantCommand> => [...commands],
    snapshotVariable: (path: VariablePath): ProcessPlantVariableSnapshot => {
      const handle = resolve(path)
      return snapshotVariable(values, handle.variable, handle.slot)
    },
    snapshotHandle: (handle: ProcessPlantVariableHandle): ProcessPlantVariableSnapshot => {
      assertHandleMatchesTable(handle)
      return snapshotVariable(values, handle.variable, handle.slot)
    },
    snapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> =>
      variables.map((variable, slot) => snapshotVariable(values, variable, slot)),
    snapshotValues: (): ReadonlyArray<ProcessPlantValue> => [...values],
    publishedSnapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> =>
      publishedHandles.map(handle => snapshotVariable(values, handle.variable, handle.slot)),
    assertInvariants: (): void => {
      for (let slot = 0; slot < variables.length; slot += 1) {
        const variable = variables[slot]
        if (!variable) throw new Error(`compiled process plant graph has missing variable slot: ${slot}`)
        const value = values[slot]
        if (value === undefined) throw new Error(`process plant invariant failed: ${variable.path} has no runtime value`)
        try {
          assertProcessPlantVariableValueValid(variable, value)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(message.replace(`process plant variable ${variable.path}`, `process plant invariant failed: ${variable.path}`))
        }
        const canonicalValue = toCanonicalProcessValue(value, variable.descriptor.unit)
        if (typeof canonicalValue === 'number' && !Number.isFinite(canonicalValue)) {
          throw new Error(`process plant invariant failed: ${variable.path} has non-finite canonical value`)
        }
      }
    },
  }
}
