import type { ProcessQuantity, ProcessUnit, ProcessVariableValue, VariableDomain, VariableKind, VariablePath } from '../graph/index.ts'

export type ProcessPlantValue = ProcessVariableValue

export const processPlantSolverPhases = [
  'applyCommands',
  'updateControlLogic',
  'solveFluidFlowComponents',
  'solveFluidFlowLinks',
  'solveThermalTransfer',
  'solveElectrical',
  'updateComponentState',
  'updateProcessLinkState',
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
  readonly domain: VariableDomain
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
  readonly graphSpecId: string
  readonly variablePaths: ReadonlyArray<VariablePath>
  readonly elapsedMs: number
  readonly remainderMs: number
  readonly queuedCommands: ReadonlyArray<ProcessPlantCommand>
  readonly variables: ReadonlyArray<ProcessPlantVariableSnapshot>
}

export interface ProcessPlantRuntime {
  readonly tick: (elapsedMs: number) => ProcessPlantTickResult
  readonly elapsedMs: () => number
  readonly readVariable: (path: VariablePath) => ProcessPlantValue
  readonly readVariableSnapshot: (path: VariablePath) => ProcessPlantVariableSnapshot
  readonly writeCommand: (command: ProcessPlantCommand) => void
  readonly snapshot: () => ProcessPlantRuntimeSnapshot
}
