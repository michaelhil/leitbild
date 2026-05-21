import { z } from 'zod'
import { componentIdSchema, processVariableValueSchema, variablePathSchema, type ComponentId, type VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantRuntime } from './model.ts'

export type ProcessPlantScheduledAction =
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'setVariable'
      readonly path: VariablePath
      readonly value: number | boolean
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'tripComponent'
      readonly componentId: ComponentId
    }

export interface ProcessPlantScheduleConfig {
  readonly actions: ReadonlyArray<ProcessPlantScheduledAction>
}

export interface ProcessPlantScheduleSnapshot {
  readonly schemaVersion: 1
  readonly firedActionIds: ReadonlyArray<string>
}

export interface ProcessPlantScheduleRunner {
  readonly applyDueActions: (runtime: ProcessPlantRuntime, nextElapsedMs: number) => void
  readonly snapshot: () => ProcessPlantScheduleSnapshot
}

const scheduledActionBaseSchema = {
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  atMs: z.number().int().nonnegative(),
}

export const processPlantScheduledActionSchema = z.discriminatedUnion('type', [
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('tripComponent'),
    componentId: componentIdSchema,
  }).strict(),
])

export const processPlantScheduleConfigSchema = z.object({
  actions: z.array(processPlantScheduledActionSchema).default([]),
}).strict()

export const processPlantScheduleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  firedActionIds: z.array(z.string().min(1)),
}).strict()

export const createProcessPlantScheduleRunner = (config: {
  readonly system?: CompiledProcessPlantSystem
  readonly schedule?: ProcessPlantScheduleConfig
  readonly restoredSnapshot?: ProcessPlantScheduleSnapshot
}): ProcessPlantScheduleRunner => {
  const schedule = processPlantScheduleConfigSchema.parse(config.schedule ?? { actions: [] })
  const restored = config.restoredSnapshot === undefined
    ? undefined
    : processPlantScheduleSnapshotSchema.parse(config.restoredSnapshot)
  const actionIds = new Set<string>()
  for (const action of schedule.actions) {
    if (actionIds.has(action.id)) throw new Error(`duplicate process plant scheduled action id: ${action.id}`)
    actionIds.add(action.id)
  }
  const firedActionIds = new Set(restored?.firedActionIds ?? [])
  for (const firedActionId of firedActionIds) {
    if (!actionIds.has(firedActionId)) throw new Error(`restored process plant schedule fired unknown action: ${firedActionId}`)
  }

  const actions = [...schedule.actions].sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id))

  const pathForAction = (action: ProcessPlantScheduledAction): VariablePath => {
    if (action.type === 'setVariable') return action.path
    const path = `${action.componentId}.running` as VariablePath
    const variable = config.system?.graph.variables.find(candidate => candidate.path === path)
    if (!variable) throw new Error(`process plant tripComponent action references component without running variable: ${action.componentId}`)
    if (variable.descriptor.quantity !== 'boolean') throw new Error(`process plant tripComponent action requires boolean running variable: ${path}`)
    return path
  }

  if (config.system !== undefined) {
    for (const action of actions) {
      const path = pathForAction(action)
      const variable = config.system.graph.variables.find(candidate => candidate.path === path)
      if (!variable) throw new Error(`process plant scheduled action ${action.id} references unknown variable: ${path}`)
      if (!variable.descriptor.writable) throw new Error(`process plant scheduled action ${action.id} targets non-writable variable: ${path}`)
      if (action.type === 'setVariable') {
        const expectedType = variable.descriptor.quantity === 'boolean' ? 'boolean' : 'number'
        if (typeof action.value !== expectedType) throw new Error(`process plant scheduled action ${action.id} value for ${path} must be ${expectedType}`)
      }
    }
  }

  return {
    applyDueActions: (runtime: ProcessPlantRuntime, nextElapsedMs: number): void => {
      for (const action of actions) {
        if (firedActionIds.has(action.id)) continue
        if (action.atMs > nextElapsedMs) continue
        runtime.writeCommand(action.type === 'setVariable'
          ? { type: 'setVariable', path: action.path, value: action.value }
          : { type: 'setVariable', path: pathForAction(action), value: false })
        firedActionIds.add(action.id)
      }
    },
    snapshot: (): ProcessPlantScheduleSnapshot => ({
      schemaVersion: 1,
      firedActionIds: [...firedActionIds],
    }),
  }
}
