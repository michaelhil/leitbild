import type { ProcessQuantity, ProcessUnit, ProcessVariableValue, VariableKind, VariablePath } from '../graph/index.ts'

export type ProcessPlantValue = ProcessVariableValue

export const processPlantSolverPhases = [
  'applyCommands',
  'updateControlLogic',
  'solveElectrical',
  'solveFluidFlow',
  'solveThermalTransfer',
  'updateComponentState',
  'publishOutputs',
] as const
export type ProcessPlantSolverPhase = typeof processPlantSolverPhases[number]

export interface ProcessPlantCommand {
  readonly type: 'setVariable'
  readonly path: VariablePath
  readonly value: ProcessPlantValue
}

export interface ProcessPlantVariableSnapshot {
  readonly path: VariablePath
  readonly value: ProcessPlantValue
  readonly canonicalValue: ProcessPlantValue
  readonly quantity: ProcessQuantity
  readonly unit: ProcessUnit
  readonly kind: VariableKind
  readonly writable: boolean
  readonly published: boolean
}

export interface ProcessPlantTickResult {
  readonly elapsedMs: number
  readonly simulatedMs: number
  readonly phases: ReadonlyArray<ProcessPlantSolverPhase>
  readonly publishedVariables: ReadonlyArray<ProcessPlantVariableSnapshot>
}

export interface ProcessPlantRuntimeSnapshot {
  readonly elapsedMs: number
  readonly variables: ReadonlyArray<ProcessPlantVariableSnapshot>
}

export interface ProcessPlantRuntime {
  readonly tick: (elapsedMs: number) => ProcessPlantTickResult
  readonly readVariable: (path: VariablePath) => ProcessPlantValue
  readonly writeCommand: (command: ProcessPlantCommand) => void
  readonly snapshot: () => ProcessPlantRuntimeSnapshot
}
