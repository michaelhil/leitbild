import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createBehaviorContext, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from './behavior-contract.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import { processLinkFlowBehaviorDefinitions } from './process-link-flow-behaviors.ts'
import { processLinkPressureBehaviorDefinitions } from './process-link-pressure-behaviors.ts'
import { processLinkRadiationBehaviorDefinitions } from './process-link-radiation-behaviors.ts'
import { processLinkTemperatureBehaviorDefinitions } from './process-link-temperature-behaviors.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export const processLinkBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  ...processLinkFlowBehaviorDefinitions,
  ...processLinkPressureBehaviorDefinitions,
  ...processLinkTemperatureBehaviorDefinitions,
  ...processLinkRadiationBehaviorDefinitions,
]

export const runProcessLinkBehaviors = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  phase: ProcessPlantSolverPhase,
  dtSeconds: number,
): void => {
  for (const behavior of processLinkBehaviorDefinitions) {
    if (behavior.phase !== phase) continue
    for (const link of system.graph.links) {
      if (!behavior.appliesTo(link)) continue
      const writablePaths = new Set(behavior.writes.map(localPath => processLinkVariablePath(link, localPath)))
      behavior.update({
        system,
        link,
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
