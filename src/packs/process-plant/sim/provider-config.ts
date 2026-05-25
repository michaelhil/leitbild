import { z } from 'zod'
import type { SimulationConnectionConfig } from '../../../simulation/protocol.ts'
import {
  processPlantScheduleConfigSchema,
  processPlantTelemetryConfigSchema,
  processPlantProtectionConfigSchema,
  type ProcessPlantProtectionConfig,
} from '../runtime/index.ts'
import { resolveProcessPlantIcConfig } from '../specs/index.ts'
import { processPlantSimProviderId } from './constants.ts'

export const processPlantProviderSystemConfigSchema = z.object({
  schedule: processPlantScheduleConfigSchema.optional(),
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

export const processPlantProviderConfigSchema = z.object({
  systems: z.record(processPlantProviderSystemConfigSchema).default({}),
}).strict()

export type ProcessPlantProviderSystemConfig = z.infer<typeof processPlantProviderSystemConfigSchema>
export type ProcessPlantProviderConfig = z.infer<typeof processPlantProviderConfigSchema>

export const processPlantProviderConfigFor = (
  config: SimulationConnectionConfig,
): ProcessPlantProviderConfig => {
  const rawConfig = config.scenario?.providerConfigs?.[processPlantSimProviderId] ?? config.scenario?.providerConfig ?? {}
  return processPlantProviderConfigSchema.parse(rawConfig)
}

export const protectionConfigFor = (
  systemConfig: ProcessPlantProviderSystemConfig | undefined,
): ProcessPlantProtectionConfig | undefined => {
  if (systemConfig?.protection !== undefined) return systemConfig.protection
  if (systemConfig?.icRef !== undefined) return resolveProcessPlantIcConfig(systemConfig.icRef)
  return undefined
}

export const assertProviderConfigMatchesCompiledSystems = (config: {
  readonly providerConfig: ProcessPlantProviderConfig
  readonly systemIds: ReadonlySet<string>
}): void => {
  for (const configuredSystemId of Object.keys(config.providerConfig.systems)) {
    if (!config.systemIds.has(configuredSystemId)) {
      throw new Error(`process plant provider config references unknown process system: ${configuredSystemId}`)
    }
  }
}
