import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import {
  componentVariablePath,
  createReusableBehaviorContext,
  processLinkVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessLinkBehaviorDefinition,
} from './behavior-contract.ts'
import { componentBehaviorDefinitions, componentInitialReconciliationDefinitions } from './component-behaviors.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import { processLinkBehaviorDefinitions } from './links/process-link-behaviors.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

type ProcessPlantExecutionInvocation =
  | {
      readonly kind: 'component'
      readonly behavior: ComponentBehaviorDefinition
      readonly componentIndex: number
      readonly writablePaths: ReadonlySet<VariablePath>
    }
  | {
      readonly kind: 'link'
      readonly behavior: ProcessLinkBehaviorDefinition
      readonly linkIndex: number
      readonly writablePaths: ReadonlySet<VariablePath>
    }

type ProcessPlantInitialReconciliationInvocation = {
  readonly behavior: ComponentInitialReconciliationDefinition
  readonly componentIndex: number
  readonly writablePaths: ReadonlySet<VariablePath>
}

export interface ProcessPlantExecutionPlan {
  readonly invocationsByPhase: ReadonlyMap<ProcessPlantSolverPhase, ReadonlyArray<ProcessPlantExecutionInvocation>>
  readonly initialReconciliationInvocations: ReadonlyArray<ProcessPlantInitialReconciliationInvocation>
  readonly invocationCount: number
}

const phaseInvocations = (
  plan: Map<ProcessPlantSolverPhase, ProcessPlantExecutionInvocation[]>,
  phase: ProcessPlantSolverPhase,
): ProcessPlantExecutionInvocation[] => {
  const existing = plan.get(phase)
  if (existing) return existing
  const created: ProcessPlantExecutionInvocation[] = []
  plan.set(phase, created)
  return created
}

const assertDeclaredWritePathsExist = (
  knownVariablePaths: ReadonlySet<VariablePath>,
  config: {
    readonly behaviorId: string
    readonly writablePaths: ReadonlySet<VariablePath>
  },
): void => {
  for (const path of config.writablePaths) {
    if (!knownVariablePaths.has(path)) {
      throw new Error(`process plant behavior ${config.behaviorId} declares write to unknown variable: ${path}`)
    }
  }
}

const isDynamicReadDeclaration = (localPath: string): boolean =>
  localPath.includes(':')
  || localPath.includes(' ')
  || localPath.includes('.')
  || localPath.endsWith('?')

const assertDeclaredComponentReadPathsExist = (
  knownVariablePaths: ReadonlySet<VariablePath>,
  config: {
    readonly behaviorId: string
    readonly componentId: string
    readonly readablePaths: ReadonlyArray<string>
    readonly pathFor: (localPath: string) => VariablePath
  },
): void => {
  for (const localPath of config.readablePaths) {
    if (isDynamicReadDeclaration(localPath)) continue
    const path = config.pathFor(localPath)
    if (!knownVariablePaths.has(path)) {
      throw new Error(`process plant behavior ${config.behaviorId} declares read from unknown variable on component ${config.componentId}: ${localPath}`)
    }
  }
}

const assertDeclaredLinkReadPathsExist = (
  knownVariablePaths: ReadonlySet<VariablePath>,
  config: {
    readonly behaviorId: string
    readonly linkId: string
    readonly readablePaths: ReadonlyArray<string>
    readonly pathFor: (localPath: string) => VariablePath
  },
): void => {
  for (const localPath of config.readablePaths) {
    if (isDynamicReadDeclaration(localPath)) continue
    const path = config.pathFor(localPath)
    if (!knownVariablePaths.has(path)) {
      throw new Error(`process plant behavior ${config.behaviorId} declares read from unknown variable on link ${config.linkId}: ${localPath}`)
    }
  }
}

export const compileProcessPlantExecutionPlan = (
  system: CompiledProcessPlant,
): ProcessPlantExecutionPlan => {
  const invocationsByPhase = new Map<ProcessPlantSolverPhase, ProcessPlantExecutionInvocation[]>()
  const initialReconciliationInvocations: ProcessPlantInitialReconciliationInvocation[] = []
  const knownVariablePaths = new Set(system.graph.variables.map(variable => variable.path))
  let invocationCount = 0

  for (const behavior of componentInitialReconciliationDefinitions) {
    for (const component of system.graph.components) {
      if (String(component.kind) !== behavior.componentKind) continue
      const writablePaths = new Set(behavior.writes.map(localPath => componentVariablePath(component, localPath)))
      assertDeclaredComponentReadPathsExist(knownVariablePaths, {
        behaviorId: behavior.id,
        componentId: String(component.id),
        readablePaths: behavior.reads,
        pathFor: localPath => componentVariablePath(component, localPath),
      })
      assertDeclaredWritePathsExist(knownVariablePaths, { behaviorId: behavior.id, writablePaths })
      initialReconciliationInvocations.push({
        behavior,
        componentIndex: component.index,
        writablePaths,
      })
      invocationCount += 1
    }
  }

  for (const behavior of componentBehaviorDefinitions) {
    for (const component of system.graph.components) {
      if (String(component.kind) !== behavior.componentKind) continue
      const writablePaths = new Set(behavior.writes.map(localPath => componentVariablePath(component, localPath)))
      assertDeclaredComponentReadPathsExist(knownVariablePaths, {
        behaviorId: behavior.id,
        componentId: String(component.id),
        readablePaths: behavior.reads,
        pathFor: localPath => componentVariablePath(component, localPath),
      })
      assertDeclaredWritePathsExist(knownVariablePaths, { behaviorId: behavior.id, writablePaths })
      phaseInvocations(invocationsByPhase, behavior.phase).push({
        kind: 'component',
        behavior,
        componentIndex: component.index,
        writablePaths,
      })
      invocationCount += 1
    }
  }

  for (const behavior of processLinkBehaviorDefinitions) {
    for (const link of system.graph.links) {
      if (!behavior.appliesTo(link)) continue
      const writablePaths = new Set(behavior.writes.map(localPath => processLinkVariablePath(link, localPath)))
      assertDeclaredLinkReadPathsExist(knownVariablePaths, {
        behaviorId: behavior.id,
        linkId: String(link.id),
        readablePaths: behavior.reads,
        pathFor: localPath => processLinkVariablePath(link, localPath),
      })
      assertDeclaredWritePathsExist(knownVariablePaths, { behaviorId: behavior.id, writablePaths })
      phaseInvocations(invocationsByPhase, behavior.phase).push({
        kind: 'link',
        behavior,
        linkIndex: link.index,
        writablePaths,
      })
      invocationCount += 1
    }
  }

  return {
    invocationsByPhase,
    initialReconciliationInvocations,
    invocationCount,
  }
}

export const runProcessPlantInitialReconciliation = (config: {
  readonly system: CompiledProcessPlant
  readonly table: ProcessPlantVariableTable
  readonly plan: ProcessPlantExecutionPlan
}): void => {
  const context = createReusableBehaviorContext(config.table)
  for (const invocation of config.plan.initialReconciliationInvocations) {
    const component = config.system.graph.components[invocation.componentIndex]
    if (!component) throw new Error(`process plant initial reconciliation references missing component index: ${invocation.componentIndex}`)
    context.configure({
      behaviorId: invocation.behavior.id,
      phase: 'solveFluidFlowComponents',
      dtSeconds: 0,
      writablePaths: invocation.writablePaths,
    })
    invocation.behavior.reconcile({
      system: config.system,
      component,
      context,
    })
  }
  runProcessPlantExecutionPhase({
    system: config.system,
    table: config.table,
    plan: config.plan,
    phase: 'solveFluidFlowLinks',
    dtSeconds: 0,
  })
  runProcessPlantExecutionPhase({
    system: config.system,
    table: config.table,
    plan: config.plan,
    phase: 'updateProcessLinkState',
    dtSeconds: 0,
  })
}

export const runProcessPlantExecutionPhase = (config: {
  readonly system: CompiledProcessPlant
  readonly table: ProcessPlantVariableTable
  readonly plan: ProcessPlantExecutionPlan
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
}): void => {
  const context = createReusableBehaviorContext(config.table)
  for (const invocation of config.plan.invocationsByPhase.get(config.phase) ?? []) {
    context.configure({
      behaviorId: invocation.behavior.id,
      phase: config.phase,
      dtSeconds: config.dtSeconds,
      writablePaths: invocation.writablePaths,
    })
    if (invocation.kind === 'component') {
      const component = config.system.graph.components[invocation.componentIndex]
      if (!component) throw new Error(`process plant execution plan references missing component index: ${invocation.componentIndex}`)
      invocation.behavior.update({
        system: config.system,
        component,
        context,
      })
      continue
    }
    const link = config.system.graph.links[invocation.linkIndex]
    if (!link) throw new Error(`process plant execution plan references missing link index: ${invocation.linkIndex}`)
    invocation.behavior.update({
      system: config.system,
      link,
      context,
    })
  }
}
