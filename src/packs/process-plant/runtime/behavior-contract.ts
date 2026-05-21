import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export const componentVariablePath = (component: CompiledComponent, localPath: string): VariablePath =>
  `${component.id}.${localPath}` as VariablePath

export const processLinkVariablePath = (link: CompiledProcessLink, localPath: string): VariablePath =>
  `${link.id}.${localPath}` as VariablePath

export interface ProcessPlantBehaviorContext {
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
  readonly has: (path: VariablePath) => boolean
  readonly read: (path: VariablePath) => ProcessPlantValue
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
  readonly write: (path: VariablePath, value: ProcessPlantValue) => void
}

export interface ComponentBehaviorDefinition {
  readonly id: string
  readonly phase: ProcessPlantSolverPhase
  readonly componentKind: string
  readonly writes: ReadonlyArray<string>
  readonly update: (input: {
    readonly system: CompiledProcessPlantSystem
    readonly component: CompiledComponent
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export interface ProcessLinkBehaviorDefinition {
  readonly id: string
  readonly phase: ProcessPlantSolverPhase
  readonly writes: ReadonlyArray<string>
  readonly appliesTo: (link: CompiledProcessLink) => boolean
  readonly update: (input: {
    readonly system: CompiledProcessPlantSystem
    readonly link: CompiledProcessLink
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

const assertFiniteValue = (path: VariablePath, value: ProcessPlantValue): void => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`process plant behavior attempted to write non-finite value to ${path}`)
  }
}

export const createBehaviorContext = (config: {
  readonly behaviorId: string
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
  readonly table: ProcessPlantVariableTable
  readonly writablePaths: ReadonlySet<VariablePath>
}): ProcessPlantBehaviorContext => ({
  phase: config.phase,
  dtSeconds: config.dtSeconds,
  has: config.table.has,
  read: config.table.read,
  readNumber: config.table.readNumber,
  readBoolean: config.table.readBoolean,
  readOptionalNumber: config.table.readOptionalNumber,
  write: (path, value): void => {
    if (!config.writablePaths.has(path)) {
      throw new Error(`process plant behavior ${config.behaviorId} cannot write undeclared variable: ${path}`)
    }
    assertFiniteValue(path, value)
    config.table.write(path, value)
  },
})

export const assertProcessPlantRuntimeInvariants = (table: ProcessPlantVariableTable): void => {
  for (const variable of table.snapshot()) {
    if (typeof variable.value === 'number' && !Number.isFinite(variable.value)) {
      throw new Error(`process plant invariant failed: ${variable.path} has non-finite value`)
    }
    if (typeof variable.canonicalValue === 'number' && !Number.isFinite(variable.canonicalValue)) {
      throw new Error(`process plant invariant failed: ${variable.path} has non-finite canonical value`)
    }
  }
}

