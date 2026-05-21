import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import {
  initialComponentValueFor,
  solveElectrical,
  solveFluidFlowComponents,
  solveThermalTransfer,
  updateComponentState,
  updateControlLogic,
} from './component-behaviors.ts'
import { processPlantSolverPhases, type ProcessPlantCommand, type ProcessPlantRuntime, type ProcessPlantRuntimeSnapshot, type ProcessPlantTickResult, type ProcessPlantValue } from './model.ts'
import { solveFluidFlowLinks, updateProcessLinkState } from './process-link-behaviors.ts'
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
  updateControlLogic(system, table, dtSeconds)
  solveElectrical(system, table, dtSeconds)
  solveFluidFlowComponents(system, table)
  solveFluidFlowLinks(system, table)
  solveThermalTransfer(system, table)
  updateComponentState(system, table, dtSeconds)
  updateProcessLinkState(system, table, dtSeconds)
  clock.elapsedMs += stepMs
}

export const createProcessPlantRuntime = (system: CompiledProcessPlantSystem): ProcessPlantRuntime => {
  const table = createProcessPlantVariableTable(system, initialComponentValueFor)
  const fixedStepMs = system.graph.timestep.fixedStepMs
  const clock: RuntimeClock = {
    elapsedMs: 0,
    remainderMs: 0,
  }

  const snapshot = (): ProcessPlantRuntimeSnapshot => ({
    elapsedMs: clock.elapsedMs,
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
