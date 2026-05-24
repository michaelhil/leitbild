import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../signals.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'

export type ReferenceIcEffect = ProcessPlantIcRule['effects'][number]
export type SignalRef = { readonly tagId: string } | { readonly path: string }

export const signalReference = (reference: SignalRef): ProcessPlantSignalReference =>
  processPlantSignalReferenceSchema.parse(reference)

export const comparison = (
  signal: SignalRef,
  operator: '<' | '<=' | '>' | '>=' | '==' | '!=',
  value: number | boolean,
): ProcessPlantIcCondition => ({
  type: 'comparison',
  signal: signalReference(signal),
  operator,
  value,
})

export const all = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'all',
  conditions,
})

export const any = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'any',
  conditions,
})

export const alarm = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
}): ReferenceIcEffect => ({
  type: 'alarm.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'warning',
})

export const trip = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
}): ReferenceIcEffect => ({
  type: 'trip.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'critical',
})

export const write = (id: string, signal: SignalRef, value: number | boolean): ReferenceIcEffect => ({
  type: 'writeSignal',
  id,
  signal: signalReference(signal),
  value,
})

export const rule = (config: {
  readonly id: string
  readonly label?: string
  readonly ruleClass?: ProcessPlantIcRule['ruleClass']
  readonly condition: ProcessPlantIcCondition
  readonly delayMs?: number
  readonly latch?: boolean
  readonly resetWhenClear?: boolean
  readonly effects: ReadonlyArray<ReferenceIcEffect>
}): ProcessPlantIcRule => ({
  id: config.id,
  ...(config.label === undefined ? {} : { label: config.label }),
  enabled: true,
  ruleClass: config.ruleClass ?? 'alarm',
  condition: config.condition,
  delayMs: config.delayMs ?? 0,
  latch: config.latch ?? true,
  resetWhenClear: config.resetWhenClear ?? false,
  effects: [...config.effects],
  commandGates: [],
})
