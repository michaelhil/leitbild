import type { CompiledComponent, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath } from './behavior-contract.ts'
import type { ComponentNumericReadContext } from './component-helpers.ts'
import { liquidEnthalpyKjPerKg } from './water-properties.ts'

const liquidBoundaryServices = new Set(['charging', 'primaryInjection', 'safetyInjection', 'residualHeatRemoval', 'letdown'])
const boundaryCache = new WeakMap<CompiledProcessPlant, ReadonlyArray<{ readonly link: CompiledProcessLink; readonly incoming: boolean }>>()
const boundaryFor = (system: CompiledProcessPlant) => {
  const cached = boundaryCache.get(system)
  if (cached !== undefined) return cached
  const primary = new Set(system.graph.components.filter(component => ['reactorCore', 'reactorVessel', 'pressurizer'].includes(component.kind)).map(component => component.index))
  const boundary = system.graph.links.flatMap(link => {
    if (link.kind !== 'fluidFlow' || link.service === undefined || !liquidBoundaryServices.has(link.service)) return []
    const from = primary.has(link.fromComponentIndex)
    const to = primary.has(link.toComponentIndex)
    return from === to ? [] : [{ link, incoming: to }]
  })
  boundaryCache.set(system, boundary)
  return boundary
}

/** Instantaneous liquid transport cooling, relative to hot-primary enthalpy.
 * With equal withdrawal/return this is exactly m*(h_withdrawal-h_return).
 * With external makeup it is its sensible cooling effect on hot water, not
 * a claim that added mass, steam relief, pressure work or thermal storage
 * closes a complete RCS energy balance. Exchangers downstream of this boundary
 * are never added again: their effect is already in the actual return water. */
export const primaryLiquidBoundaryCoolingMw = (
  system: CompiledProcessPlant,
  core: CompiledComponent,
  context: ComponentNumericReadContext,
  pressureMPa: number,
): number => {
  const referenceEnthalpy = liquidEnthalpyKjPerKg(context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC')), pressureMPa)
  let cooling = 0
  for (const { link, incoming } of boundaryFor(system)) {
    const flow = Math.max(0, context.readNumber(processLinkVariablePath(link, 'flowKgPerS')))
    if (flow === 0) continue
    const enthalpy = liquidEnthalpyKjPerKg(context.readNumber(processLinkVariablePath(link, 'temperatureC')), pressureMPa)
    cooling += flow * (incoming ? referenceEnthalpy - enthalpy : enthalpy - referenceEnthalpy) / 1_000
  }
  return cooling
}
