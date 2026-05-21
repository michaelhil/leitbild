import type { CompiledComponent, CompiledVariable, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantCommand, ProcessPlantValue, ProcessPlantVariableSnapshot } from './model.ts'
import { toCanonicalProcessValue } from './units.ts'

export interface ProcessPlantVariableTable {
  readonly queueCommand: (command: ProcessPlantCommand) => void
  readonly applyQueuedCommands: () => void
  readonly has: (path: VariablePath) => boolean
  readonly read: (path: VariablePath) => ProcessPlantValue
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
  readonly write: (path: VariablePath, value: ProcessPlantValue) => void
  readonly snapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
  readonly publishedSnapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
}

const assertValueMatchesCurrentType = (
  path: VariablePath,
  current: ProcessPlantValue,
  next: ProcessPlantValue,
): void => {
  if (typeof current !== typeof next) throw new Error(`process plant variable ${path} expects ${typeof current} value`)
}

const snapshotVariable = (
  values: ReadonlyMap<VariablePath, ProcessPlantValue>,
  variable: CompiledVariable,
): ProcessPlantVariableSnapshot => {
  const value = values.get(variable.path)
  if (value === undefined) throw new Error(`variable ${variable.path} has no runtime value`)
  return {
    path: variable.path,
    value,
    canonicalValue: toCanonicalProcessValue(value, variable.descriptor.unit),
    quantity: variable.descriptor.quantity,
    unit: variable.descriptor.unit,
    kind: variable.descriptor.kind,
    writable: variable.descriptor.writable,
    published: variable.published,
  }
}

export const createProcessPlantVariableTable = (
  system: CompiledProcessPlantSystem,
  initialComponentValueFor: (component: CompiledComponent, path: VariablePath) => ProcessPlantValue,
): ProcessPlantVariableTable => {
  const variables = system.graph.variables
  const variableByPath = new Map(variables.map(variable => [variable.path, variable]))
  const values = new Map<VariablePath, ProcessPlantValue>()
  const commands: ProcessPlantCommand[] = []

  for (const variable of variables) {
    if (variable.owner.type === 'component') {
      const component = system.graph.components[variable.owner.componentIndex]
      if (!component) throw new Error(`variable ${variable.path} references missing component index ${variable.owner.componentIndex}`)
      values.set(variable.path, initialComponentValueFor(component, variable.path))
      continue
    }
    if (variable.initialValue === undefined) throw new Error(`process link variable ${variable.path} has no initial value`)
    values.set(variable.path, variable.initialValue)
  }

  const read = (path: VariablePath): ProcessPlantValue => {
    if (!variableByPath.has(path)) throw new Error(`unknown process plant variable: ${path}`)
    const value = values.get(path)
    if (value === undefined) throw new Error(`variable ${path} has no runtime value`)
    return value
  }

  const write = (path: VariablePath, value: ProcessPlantValue): void => {
    const current = read(path)
    assertValueMatchesCurrentType(path, current, value)
    values.set(path, value)
  }

  return {
    queueCommand: (command: ProcessPlantCommand): void => {
      const variable = variableByPath.get(command.path)
      if (!variable) throw new Error(`unknown process plant variable: ${command.path}`)
      if (!variable.descriptor.writable) throw new Error(`process plant variable is not writable: ${command.path}`)
      assertValueMatchesCurrentType(command.path, read(command.path), command.value)
      commands.push(command)
    },
    applyQueuedCommands: (): void => {
      for (const command of commands.splice(0)) {
        write(command.path, command.value)
      }
    },
    has: (path: VariablePath): boolean => variableByPath.has(path),
    read,
    readNumber: (path: VariablePath): number => {
      const value = read(path)
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`variable ${path} is not numeric`)
      return value
    },
    readBoolean: (path: VariablePath): boolean => {
      const value = read(path)
      if (typeof value !== 'boolean') throw new Error(`variable ${path} is not boolean`)
      return value
    },
    readOptionalNumber: (path: VariablePath, defaultValue: number): number => {
      if (!variableByPath.has(path)) return defaultValue
      const value = read(path)
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`variable ${path} is not numeric`)
      return value
    },
    write,
    snapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> => variables.map(variable => snapshotVariable(values, variable)),
    publishedSnapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> =>
      variables.filter(variable => variable.published).map(variable => snapshotVariable(values, variable)),
  }
}
