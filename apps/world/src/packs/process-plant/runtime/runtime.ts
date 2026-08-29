import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { initialComponentValueFor } from './component-behaviors.ts'
import { assertProcessPlantRuntimeInvariants } from './behavior-contract.ts'
import { compileProcessPlantExecutionPlan, runProcessPlantExecutionPhase, runProcessPlantInitialReconciliation, type ProcessPlantExecutionPlan } from './execution-plan.ts'
import { processPlantSolverPhases, type ProcessPlantCommand, type ProcessPlantRuntime, type ProcessPlantRuntimeSnapshot, type ProcessPlantTickResult, type ProcessPlantValue } from './model.ts'
import { createProcessPlantVariableTable, type ProcessPlantVariableTable } from './variable-table.ts'
import { compilePwrTransientKernel, evaluatePwrTransientKernel, type PwrTransientDiagnostics, type PwrTransientKernel } from './pwr-transient-kernel.ts'

interface RuntimeClock {
  elapsedMs: number
  remainderMs: number
}

const assertRestoredSnapshotMatchesSystem = (
  system: CompiledProcessPlantSystem,
  restoredSnapshot: ProcessPlantRuntimeSnapshot | undefined,
): void => {
  if (!restoredSnapshot) return
  if (restoredSnapshot.graphSpecId !== String(system.graph.specId)) {
    throw new Error(`restored process plant graph ${restoredSnapshot.graphSpecId} does not match system graph ${system.graph.specId}`)
  }
  const expectedVariablePaths = system.graph.variables.map(variable => variable.path)
  if (restoredSnapshot.variablePaths.length !== expectedVariablePaths.length) {
    throw new Error(`restored process plant variable path count ${restoredSnapshot.variablePaths.length} does not match system graph ${expectedVariablePaths.length}`)
  }
  for (let index = 0; index < expectedVariablePaths.length; index += 1) {
    if (restoredSnapshot.variablePaths[index] !== expectedVariablePaths[index]) {
      throw new Error(`restored process plant variable path ${restoredSnapshot.variablePaths[index]} does not match system graph path ${expectedVariablePaths[index]} at slot ${index}`)
    }
  }
}

const step = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  plan: ProcessPlantExecutionPlan,
  clock: RuntimeClock,
  stepMs: number,
  assertInvariants: boolean,
): void => {
  const dtSeconds = stepMs / 1_000
  table.applyQueuedCommands()
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'updateControlLogic', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'solveFluidFlowComponents', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'solveFluidFlowLinks', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'solveThermalTransfer', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'solveElectrical', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'updateComponentState', dtSeconds })
  runProcessPlantExecutionPhase({ system, table, plan, phase: 'updateProcessLinkState', dtSeconds })
  if (assertInvariants) assertProcessPlantRuntimeInvariants(table)
  clock.elapsedMs += stepMs
}

export const createProcessPlantRuntime = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly restoredSnapshot?: ProcessPlantRuntimeSnapshot
  readonly assertInvariants?: boolean
}): ProcessPlantRuntime => {
  const system = config.system
  assertRestoredSnapshotMatchesSystem(system, config.restoredSnapshot)
  const table = createProcessPlantVariableTable(
    system,
    initialComponentValueFor,
    config.restoredSnapshot?.variables,
    config.restoredSnapshot?.queuedCommands,
    system.initialState,
  )
  const fixedStepMs = system.graph.timestep.fixedStepMs
  const plan = compileProcessPlantExecutionPlan(system)
  if (!config.restoredSnapshot) {
    runProcessPlantInitialReconciliation({ system, table, plan })
  }
  const assertInvariants = config.assertInvariants ?? false
  const clock: RuntimeClock = {
    elapsedMs: config.restoredSnapshot?.elapsedMs ?? 0,
    remainderMs: config.restoredSnapshot?.remainderMs ?? 0,
  }
  let pwrKernel: PwrTransientKernel | null = null
  let lastPwrTransientDiagnostics: PwrTransientDiagnostics | null = null
  let pwrTransientDiagnosticsDirty = true

  const pwrTransientDiagnostics = (): PwrTransientDiagnostics => {
    pwrKernel ??= compilePwrTransientKernel(system, table)
    if (lastPwrTransientDiagnostics === null || pwrTransientDiagnosticsDirty) {
      lastPwrTransientDiagnostics = evaluatePwrTransientKernel(pwrKernel, table)
      pwrTransientDiagnosticsDirty = false
    }
    return lastPwrTransientDiagnostics
  }

  const snapshot = (): ProcessPlantRuntimeSnapshot => ({
    graphSpecId: String(system.graph.specId),
    variablePaths: system.graph.variables.map(variable => variable.path),
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
        step(system, table, plan, clock, fixedStepMs, assertInvariants)
        pwrTransientDiagnosticsDirty = true
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
    elapsedMs: (): number => clock.elapsedMs,
    resolveVariableHandle: (path: VariablePath) => table.resolve(path),
    readVariable: (path: VariablePath): ProcessPlantValue => table.read(path),
    readVariableHandle: (handle) => table.readHandle(handle),
    readVariableSnapshot: (path: VariablePath) => table.snapshotVariable(path),
    readVariableSnapshotHandle: (handle) => table.snapshotHandle(handle),
    writeCommand: (command: ProcessPlantCommand): void => {
      table.queueCommand(command)
    },
    pwrTransientDiagnostics,
    snapshot,
  }
}
