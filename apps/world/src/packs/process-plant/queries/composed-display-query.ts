import { z } from 'zod'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import { idSchema, type IsoTimestamp, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { rejectCapabilityInput, rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantSignalQuality } from '../signals.ts'
import {
  COMPOSED_DISPLAY_VIEW_TYPE,
  composedDisplayCompositionSchema,
  composedDisplayStateSchema,
} from '../displays/composition.ts'
import {
  compileComposedDisplay,
  composedDisplayShows,
  composedDisplayWarnings,
  formatComposedDisplayIssues,
  formatComposedViewIssues,
} from '../displays/compose.ts'
import { requirePlant } from './common.ts'

export const processPlantComposedDisplayQueryKinds = [
  'world.process-plant.display.compose',
  'world.process-plant.display.view',
  'world.process-plant.display.sample',
] as const

// The compose input is validated by the compiler so every issue is reported
// at once; the capability schema only requires the target Plant.
export const displayComposeQuerySchema = composedDisplayCompositionSchema
export const displayViewQuerySchema = z.object({
  plantId: idSchema,
  state: z.string().min(2),
}).strict()
// One sample serves one view; a trend never has more pens than this.
const SAMPLE_MAX_PATHS = 12
export const displaySampleQuerySchema = z.object({
  plantId: idSchema,
  paths: z.array(variablePathSchema).min(1).max(SAMPLE_MAX_PATHS),
  alarms: z.boolean().default(false),
}).strict()

const compiledOrRejected = (system: ProcessPlantRuntimeInstance, composition: unknown, purpose: 'compose' | 'view') => {
  const result = compileComposedDisplay(system, composition, purpose)
  if (!result.ok) return rejectCapabilityInput(purpose === 'compose' ? formatComposedDisplayIssues(result.issues) : formatComposedViewIssues(result.issues))
  return result.display
}

export const answerProcessPlantComposedDisplayQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly objects: ReadonlyMap<ObjectId, Pick<OperationalObject, 'id' | 'label'>>
  readonly simulationTime?: IsoTimestamp
}): unknown | undefined => {
  if (!processPlantComposedDisplayQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  const simulationTime = config.simulationTime
  if (simulationTime === undefined) throw new Error(`${config.request.capabilityId} requires the Simulation Run time of the answering runtime`)

  if (config.request.capabilityId === 'world.process-plant.display.compose') {
    const plantId = idSchema.parse((config.request.input as { plantId?: unknown } | null)?.plantId)
    const system = requirePlant(config.plants, plantId)
    const display = compiledOrRejected(system, config.request.input, 'compose')
    const state = composedDisplayStateSchema.parse({
      composition: composedDisplayCompositionSchema.parse(config.request.input),
      issuedAt: simulationTime,
      modelDigest: display.modelDigest,
    })
    return {
      plantId: display.plantId,
      issuedAt: simulationTime,
      view: embeddedViewPublicationSchema.parse({
        viewType: COMPOSED_DISPLAY_VIEW_TYPE,
        title: display.title,
        height: display.height,
        state: JSON.stringify(state),
      }),
      shows: composedDisplayShows(display),
      warnings: composedDisplayWarnings(display),
    }
  }

  if (config.request.capabilityId === 'world.process-plant.display.view') {
    const payload = displayViewQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const parsedState = composedDisplayStateSchema.safeParse(JSON.parse(payload.state))
    if (!parsedState.success) return rejectCapabilityInput(`Unsupported display format: ${parsedState.error.message}`)
    const state = parsedState.data
    if (state.composition.plantId !== payload.plantId) return rejectCapabilityInput(`Display state targets ${state.composition.plantId}, not ${payload.plantId}`)
    const display = compiledOrRejected(system, state.composition, 'view')
    return {
      plantId: display.plantId,
      // The asset label distinguishes identical units; null when the Plant has no projected asset.
      plantLabel: config.objects.get(display.plantId as ObjectId)?.label ?? null,
      issuedAt: state.issuedAt,
      simulationTime,
      modelChanged: state.modelDigest !== display.modelDigest,
      display,
    }
  }

  const payload = displaySampleQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  const protection = payload.alarms ? system.protection?.snapshot() : undefined
  if (payload.alarms && protection === undefined) return rejectCapabilityTarget(`Process Plant ${payload.plantId} has no configured alarms`)
  return {
    plantId: payload.plantId,
    simulationTime,
    plantElapsedMs: system.runtime.elapsedMs(),
    ...(protection === undefined ? {} : {
      alarms: [...protection.alarms, ...protection.trips]
        .filter(lifecycle => lifecycle.active)
        .map(lifecycle => ({
          id: lifecycle.id,
          ruleId: lifecycle.ruleId,
          kind: lifecycle.kind,
          title: lifecycle.title,
          severity: lifecycle.severity,
          acknowledged: lifecycle.acknowledged,
          firstOut: lifecycle.firstOut,
          ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }),
        })),
    }),
    values: payload.paths.map(path => {
      if (!system.plant.graph.signalBindingByPath.has(path)) return rejectCapabilityTarget(`Process Plant signal path not found: ${path}`)
      const variable = system.runtime.readVariableSnapshot(path)
      const quality = processPlantSignalQuality(variable)
      return { path, value: variable.value, quality: quality.status }
    }),
  }
}
