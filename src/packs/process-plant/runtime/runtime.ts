import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import {
  initialComponentValueFor,
  runComponentBehaviors,
} from './component-behaviors.ts'
import { assertProcessPlantRuntimeInvariants } from './behavior-contract.ts'
import { processPlantSolverPhases, type ProcessPlantCommand, type ProcessPlantRuntime, type ProcessPlantRuntimeSnapshot, type ProcessPlantTickResult, type ProcessPlantValue } from './model.ts'
import { runProcessLinkBehaviors } from './process-link-behaviors.ts'
import { createProcessPlantVariableTable, type ProcessPlantVariableTable } from './variable-table.ts'

interface RuntimeClock {
  elapsedMs: number
  remainderMs: number
}

const step = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  clock: RuntimeClock,
  stepMs: number,
): void => {
  const dtSeconds = stepMs / 1_000
  table.applyQueuedCommands()
  runComponentBehaviors(system, table, 'updateControlLogic', dtSeconds)
  runComponentBehaviors(system, table, 'solveFluidFlowComponents', dtSeconds)
  runProcessLinkBehaviors(system, table, 'solveFluidFlowLinks', dtSeconds)
  runComponentBehaviors(system, table, 'solveThermalTransfer', dtSeconds)
  runComponentBehaviors(system, table, 'solveElectrical', dtSeconds)
  runComponentBehaviors(system, table, 'updateComponentState', dtSeconds)
  runProcessLinkBehaviors(system, table, 'updateProcessLinkState', dtSeconds)
  assertProcessPlantRuntimeInvariants(table)
  clock.elapsedMs += stepMs
}

export const createProcessPlantRuntime = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly restoredSnapshot?: ProcessPlantRuntimeSnapshot
}): ProcessPlantRuntime => {
  const system = config.system
  const table = createProcessPlantVariableTable(
    system,
    initialComponentValueFor,
    config.restoredSnapshot?.variables,
    config.restoredSnapshot?.queuedCommands,
  )
  const fixedStepMs = system.graph.timestep.fixedStepMs
  const clock: RuntimeClock = {
    elapsedMs: config.restoredSnapshot?.elapsedMs ?? 0,
    remainderMs: config.restoredSnapshot?.remainderMs ?? 0,
  }

  const snapshot = (): ProcessPlantRuntimeSnapshot => ({
    elapsedMs: clock.elapsedMs,
    remainderMs: clock.remainderMs,
    queuedCommands: table.queuedCommands(),
    variables: table.snapshot(),
  })

  return {
    tick: (elapsedMs: number): ProcessPlantTickResult => {
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error(`process plant tick elapsedMs must be positive, got ${elapsedMs}`)
      clock.remainderMs += elapsedMs
      let simulatedMs = 0
      while (clock.remainderMs >= fixedStepMs) {
        step(system, table, clock, fixedStepMs)
        clock.remainderMs -= fixedStepMs
        simulatedMs += fixedStepMs
      }
      return {
        elapsedMs,
        simulatedMs,
        phases: processPlantSolverPhases,
        publishedVariables: table.publishedSnapshot(),
      }
    },
    readVariable: (path: VariablePath): ProcessPlantValue => table.read(path),
    writeCommand: (command: ProcessPlantCommand): void => {
      table.queueCommand(command)
    },
    snapshot,
  }
}
