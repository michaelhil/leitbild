import type { CompiledComponent, CompiledVariable, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem, ProcessPlantInitialVariableValue } from '../process-systems.ts'
import type { ProcessPlantCommand, ProcessPlantValue, ProcessPlantVariableSnapshot } from './model.ts'
import { toCanonicalProcessValue } from './units.ts'
import {
  assertProcessPlantVariableValueValid,
} from './variable-validation.ts'

export interface ProcessPlantVariableTable {
  readonly queueCommand: (command: ProcessPlantCommand) => void
  readonly applyQueuedCommands: () => void
  readonly has: (path: VariablePath) => boolean
  readonly read: (path: VariablePath) => ProcessPlantValue
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
  readonly write: (path: VariablePath, value: ProcessPlantValue) => void
  readonly queuedCommands: () => ReadonlyArray<ProcessPlantCommand>
  readonly snapshotVariable: (path: VariablePath) => ProcessPlantVariableSnapshot
  readonly snapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
  readonly publishedSnapshot: () => ReadonlyArray<ProcessPlantVariableSnapshot>
  readonly assertInvariants: () => void
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
    value,
    canonicalValue: toCanonicalProcessValue(value, variable.descriptor.unit),
    quantity: variable.descriptor.quantity,
    unit: variable.descriptor.unit,
    domain: variable.descriptor.domain,
    kind: variable.descriptor.kind,
    writable: variable.descriptor.writable,
    published: variable.published,
  }
}

export const createProcessPlantVariableTable = (
  system: CompiledProcessPlantSystem,
  initialComponentValueFor: (component: CompiledComponent, path: VariablePath) => ProcessPlantValue,
  restoredVariables?: ReadonlyArray<ProcessPlantVariableSnapshot>,
  restoredCommands?: ReadonlyArray<ProcessPlantCommand>,
  initialVariables?: ReadonlyArray<ProcessPlantInitialVariableValue>,
): ProcessPlantVariableTable => {
  const variables = system.graph.variables
  const variableByPath = new Map(variables.map((variable, slot) => [variable.path, { variable, slot }]))
  const values: ProcessPlantValue[] = new Array(variables.length)
  const commands: ProcessPlantCommand[] = []
  const restoredValues = restoredVariables === undefined
    ? null
    : new Map(restoredVariables.map(variable => [variable.path, variable.value]))

  if (restoredValues) {
    for (const restoredVariable of restoredVariables ?? []) {
      if (!variableByPath.has(restoredVariable.path)) {
        throw new Error(`restored process plant variable is not declared by graph: ${restoredVariable.path}`)
      }
    }
    for (const variable of variables) {
      if (!restoredValues.has(variable.path)) {
        throw new Error(`restored process plant state is missing variable: ${variable.path}`)
      }
      assertProcessPlantVariableValueValid(variable, restoredValues.get(variable.path)!)
    }
  }

  for (let slot = 0; slot < variables.length; slot += 1) {
    const variable = variables[slot]
    if (!variable) throw new Error(`compiled process plant graph has missing variable slot: ${slot}`)
    const restoredValue = restoredValues?.get(variable.path)
    if (restoredValue !== undefined) {
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

  if (!restoredValues) {
    for (const initial of initialVariables ?? []) {
      const entry = variableByPath.get(initial.path)
      if (!entry) throw new Error(`process plant initialState references unknown variable: ${initial.path}`)
      assertProcessPlantVariableValueValid(entry.variable, initial.value)
      values[entry.slot] = initial.value
    }
  }

  const read = (path: VariablePath): ProcessPlantValue => {
    const entry = variableByPath.get(path)
    if (!entry) throw new Error(`unknown process plant variable: ${path}`)
    const value = values[entry.slot]
    if (value === undefined) throw new Error(`variable ${path} has no runtime value`)
    return value
  }

  const write = (path: VariablePath, value: ProcessPlantValue): void => {
    const entry = variableByPath.get(path)
    if (!entry) throw new Error(`unknown process plant variable: ${path}`)
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
    queuedCommands: (): ReadonlyArray<ProcessPlantCommand> => [...commands],
    snapshotVariable: (path: VariablePath): ProcessPlantVariableSnapshot => {
      const entry = variableByPath.get(path)
      if (!entry) throw new Error(`unknown process plant variable: ${path}`)
      return snapshotVariable(values, entry.variable, entry.slot)
    },
    snapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> =>
      variables.map((variable, slot) => snapshotVariable(values, variable, slot)),
    publishedSnapshot: (): ReadonlyArray<ProcessPlantVariableSnapshot> =>
      variables.flatMap((variable, slot) => variable.published ? [snapshotVariable(values, variable, slot)] : []),
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
