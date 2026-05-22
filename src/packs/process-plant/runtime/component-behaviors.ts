import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import {
  componentVariablePath,
  createBehaviorContext,
} from './behavior-contract.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export { initialComponentValueFor } from './component-initial-values.ts'
export {
  approach,
  averageFor,
  clamp,
  parameterNumber,
  relaxToward,
} from './component-helpers.ts'
export {
  componentBehaviorDefinitions,
  componentInitialReconciliationDefinitions,
} from './behaviors/index.ts'
import { componentBehaviorDefinitions } from './behaviors/index.ts'

export const runComponentBehaviors = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  phase: ProcessPlantSolverPhase,
  dtSeconds: number,
): void => {
  for (const behavior of componentBehaviorDefinitions) {
    if (behavior.phase !== phase) continue
    for (const component of system.graph.components) {
      if (String(component.kind) !== behavior.componentKind) continue
      const writablePaths = new Set(behavior.writes.map(localPath => componentVariablePath(component, localPath)))
      behavior.update({
        system,
        component,
        context: createBehaviorContext({
          behaviorId: behavior.id,
          phase,
          dtSeconds,
          table,
          writablePaths,
        }),
      })
    }
  }
}
