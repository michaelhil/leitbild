import { z } from 'zod'
import { processVariableValueSchema, variablePathSchema, type VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntime } from './model.ts'

export interface ProcessPlantScheduledAction {
  readonly id: string
  readonly atMs: number
  readonly type: 'setVariable'
  readonly path: VariablePath
  readonly value: number | boolean
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

export const processPlantScheduledActionSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  atMs: z.number().int().nonnegative(),
  type: z.literal('setVariable'),
  path: variablePathSchema,
  value: processVariableValueSchema,
}).strict()

export const processPlantScheduleConfigSchema = z.object({
  actions: z.array(processPlantScheduledActionSchema).default([]),
}).strict()

export const processPlantScheduleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  firedActionIds: z.array(z.string().min(1)),
}).strict()

export const createProcessPlantScheduleRunner = (config: {
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

  return {
    applyDueActions: (runtime: ProcessPlantRuntime, nextElapsedMs: number): void => {
      for (const action of actions) {
        if (firedActionIds.has(action.id)) continue
        if (action.atMs > nextElapsedMs) continue
        runtime.writeCommand({
          type: 'setVariable',
          path: action.path,
          value: action.value,
        })
        firedActionIds.add(action.id)
      }
    },
    snapshot: (): ProcessPlantScheduleSnapshot => ({
      schemaVersion: 1,
      firedActionIds: [...firedActionIds],
    }),
  }
}
