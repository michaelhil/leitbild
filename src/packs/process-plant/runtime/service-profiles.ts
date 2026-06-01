import type { CompiledComponent, CompiledProcessLink, ConnectionService } from '../graph/index.ts'

const service = (value: string): ConnectionService => value as ConnectionService

export const processPlantServices = {
  auxFeedwater: service('auxFeedwater'),
  charging: service('charging'),
  condensate: service('condensate'),
  containmentSpray: service('containmentSpray'),
  coolingWater: service('coolingWater'),
  exhaustSteam: service('exhaustSteam'),
  feedwater: service('feedwater'),
  letdown: service('letdown'),
  mainSteam: service('mainSteam'),
  primaryCoolant: service('primaryCoolant'),
  primaryInjection: service('primaryInjection'),
  primaryRelease: service('primaryRelease'),
  primaryRelief: service('primaryRelief'),
  safetyInjection: service('safetyInjection'),
} as const

const downstreamDemandServices: ReadonlySet<ConnectionService> = new Set([
  processPlantServices.auxFeedwater,
  processPlantServices.condensate,
  processPlantServices.feedwater,
])

const demandTerminalByService: ReadonlyMap<ConnectionService, ReadonlySet<string>> = new Map([
  [processPlantServices.auxFeedwater, new Set(['steamGenerator'])],
  [processPlantServices.condensate, new Set(['processTank'])],
  [processPlantServices.feedwater, new Set(['steamGenerator'])],
])

export const serviceMatches = (
  link: CompiledProcessLink,
  candidate: CompiledProcessLink['service'],
): boolean => candidate !== undefined && link.service === candidate

export const serviceUsesDownstreamDemand = (
  candidate: CompiledProcessLink['service'],
): boolean => candidate !== undefined && downstreamDemandServices.has(candidate)

export const isServiceDemandTerminal = (
  component: CompiledComponent | undefined,
  candidate: CompiledProcessLink['service'],
): boolean => {
  if (!component || candidate === undefined) return false
  return demandTerminalByService.get(candidate)?.has(String(component.kind)) ?? false
}

export const isMainSteamService = (link: CompiledProcessLink): boolean =>
  link.kind === 'fluidFlow' && serviceMatches(link, processPlantServices.mainSteam)
