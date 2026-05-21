import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  processLinkVariablePath,
  type ComponentBehaviorDefinition,
  type ProcessLinkBehaviorDefinition,
} from './behavior-contract.ts'
import { componentBehaviorDefinitions } from './component-behaviors.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import { processLinkBehaviorDefinitions } from './process-link-behaviors.ts'
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

export interface ProcessPlantExecutionPlan {
  readonly invocationsByPhase: ReadonlyMap<ProcessPlantSolverPhase, ReadonlyArray<ProcessPlantExecutionInvocation>>
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

export const compileProcessPlantExecutionPlan = (
  system: CompiledProcessPlantSystem,
): ProcessPlantExecutionPlan => {
  const invocationsByPhase = new Map<ProcessPlantSolverPhase, ProcessPlantExecutionInvocation[]>()
  let invocationCount = 0

  for (const behavior of componentBehaviorDefinitions) {
    for (const component of system.graph.components) {
      if (String(component.kind) !== behavior.componentKind) continue
      const writablePaths = new Set(behavior.writes.map(localPath => componentVariablePath(component, localPath)))
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
    invocationCount,
  }
}

export const runProcessPlantExecutionPhase = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly table: ProcessPlantVariableTable
  readonly plan: ProcessPlantExecutionPlan
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
}): void => {
  for (const invocation of config.plan.invocationsByPhase.get(config.phase) ?? []) {
    if (invocation.kind === 'component') {
      const component = config.system.graph.components[invocation.componentIndex]
      if (!component) throw new Error(`process plant execution plan references missing component index: ${invocation.componentIndex}`)
      invocation.behavior.update({
        system: config.system,
        component,
        context: createBehaviorContext({
          behaviorId: invocation.behavior.id,
          phase: config.phase,
          dtSeconds: config.dtSeconds,
          table: config.table,
          writablePaths: invocation.writablePaths,
        }),
      })
      continue
    }
    const link = config.system.graph.links[invocation.linkIndex]
    if (!link) throw new Error(`process plant execution plan references missing link index: ${invocation.linkIndex}`)
    invocation.behavior.update({
      system: config.system,
      link,
      context: createBehaviorContext({
        behaviorId: invocation.behavior.id,
        phase: config.phase,
        dtSeconds: config.dtSeconds,
        table: config.table,
        writablePaths: invocation.writablePaths,
      }),
    })
  }
}
