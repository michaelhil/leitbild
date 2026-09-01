import { z } from 'zod'
import type { PackRuntimeConnectionConfig } from '../../../simulation/protocol.ts'
import {
  processPlantTelemetryConfigSchema,
  processPlantProtectionConfigSchema,
  type ProcessPlantProtectionConfig,
} from '../runtime/index.ts'
import { resolveProcessPlantIcConfig, resolveProcessPlantIcConfigForGraph } from '../specs/index.ts'
import { processPlantPackConfigSchema, type CompiledProcessPlantSystem } from '../process-systems.ts'

export const processPlantRuntimeSystemConfigSchema = z.object({
  telemetry: processPlantTelemetryConfigSchema.optional(),
  icRef: z.string().min(1).optional(),
  protection: processPlantProtectionConfigSchema.optional(),
}).strict().superRefine((system, ctx) => {
  if (system.icRef !== undefined && system.protection !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protection'],
      message: 'process plant system config must not define both icRef and inline protection',
    })
  }
})

export const processPlantRuntimeConfigSchema = z.object({
  systems: z.record(z.string(), processPlantRuntimeSystemConfigSchema).default({}),
}).strict()

export type ProcessPlantRuntimeSystemConfig = z.infer<typeof processPlantRuntimeSystemConfigSchema>
export type ProcessPlantRuntimeConfig = z.infer<typeof processPlantRuntimeConfigSchema>

export const processPlantRuntimeConfigFor = (
  config: PackRuntimeConnectionConfig,
): ProcessPlantRuntimeConfig => {
  const packConfig = processPlantPackConfigSchema.parse(config.scenario?.runtimeConfig ?? {})
  return processPlantRuntimeConfigSchema.parse({
    systems: Object.fromEntries(packConfig.systems.map(system => [system.id, system.runtime ?? {}])),
  })
}

export const protectionConfigFor = (
  systemConfig: ProcessPlantRuntimeSystemConfig | undefined,
  system?: CompiledProcessPlantSystem,
): ProcessPlantProtectionConfig | undefined => {
  if (systemConfig?.protection !== undefined) return systemConfig.protection
  if (systemConfig?.icRef !== undefined) {
    return system === undefined
      ? resolveProcessPlantIcConfig(systemConfig.icRef)
      : resolveProcessPlantIcConfigForGraph(systemConfig.icRef, system.graph)
  }
  return undefined
}

export const assertRuntimeConfigMatchesCompiledSystems = (config: {
  readonly runtimeConfig: ProcessPlantRuntimeConfig
  readonly systemIds: ReadonlySet<string>
}): void => {
  for (const configuredSystemId of Object.keys(config.runtimeConfig.systems)) {
    if (!config.systemIds.has(configuredSystemId)) {
      throw new Error(`process plant runtime config references unknown process system: ${configuredSystemId}`)
    }
  }
}
