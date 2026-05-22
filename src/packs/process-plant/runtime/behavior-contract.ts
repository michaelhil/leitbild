import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'
import { assertProcessPlantValueIsFinite } from './variable-validation.ts'

const componentVariablePathCache = new WeakMap<CompiledComponent, Map<string, VariablePath>>()
const processLinkVariablePathCache = new WeakMap<CompiledProcessLink, Map<string, VariablePath>>()

export const componentVariablePath = (component: CompiledComponent, localPath: string): VariablePath =>
  cachedVariablePath(componentVariablePathCache, component, String(component.id), localPath)

export const processLinkVariablePath = (link: CompiledProcessLink, localPath: string): VariablePath =>
  cachedVariablePath(processLinkVariablePathCache, link, String(link.id), localPath)

const cachedVariablePath = <T extends object>(
  cache: WeakMap<T, Map<string, VariablePath>>,
  owner: T,
  ownerId: string,
  localPath: string,
): VariablePath => {
  const existingOwnerCache = cache.get(owner)
  if (existingOwnerCache) {
    const existing = existingOwnerCache.get(localPath)
    if (existing) return existing
    const created = `${ownerId}.${localPath}` as VariablePath
    existingOwnerCache.set(localPath, created)
    return created
  }
  const created = `${ownerId}.${localPath}` as VariablePath
  cache.set(owner, new Map([[localPath, created]]))
  return created
}

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
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly update: (input: {
    readonly system: CompiledProcessPlantSystem
    readonly component: CompiledComponent
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export interface ComponentInitialReconciliationDefinition {
  readonly id: string
  readonly componentKind: string
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly reconcile: (input: {
    readonly system: CompiledProcessPlantSystem
    readonly component: CompiledComponent
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export interface ProcessLinkBehaviorDefinition {
  readonly id: string
  readonly phase: ProcessPlantSolverPhase
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly appliesTo: (link: CompiledProcessLink) => boolean
  readonly update: (input: {
    readonly system: CompiledProcessPlantSystem
    readonly link: CompiledProcessLink
    readonly context: ProcessPlantBehaviorContext
  }) => void
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
    assertProcessPlantValueIsFinite(path, value)
    config.table.write(path, value)
  },
})

export const assertProcessPlantRuntimeInvariants = (table: ProcessPlantVariableTable): void => {
  table.assertInvariants()
}
