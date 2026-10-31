import type { CompiledComponent, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { processLinkVariablePath } from './behavior-contract.ts'
import type { ComponentNumericReadContext } from './component-helpers.ts'
import { primaryLoopLegReversed } from './primary-loop-hydraulics.ts'
import { liquidEnthalpyKjPerKg } from './water-properties.ts'

const inletServices = new Set(['primaryCoolant', 'charging', 'primaryInjection', 'safetyInjection', 'residualHeatRemoval'])
const inletLinks = new WeakMap<CompiledProcessPlant, Map<number, ReadonlyArray<CompiledProcessLink>>>()

const linksFor = (system: CompiledProcessPlant, core: CompiledComponent): ReadonlyArray<CompiledProcessLink> => {
  let byComponent = inletLinks.get(system)
  if (byComponent === undefined) {
    byComponent = new Map()
    inletLinks.set(system, byComponent)
  }
  const cached = byComponent.get(core.index)
  if (cached !== undefined) return cached
  const links = (system.graph.incomingLinksByComponent[core.index] ?? [])
    .map(index => system.graph.links[index]!)
    .filter(link => link.kind === 'fluidFlow' && link.service !== undefined && inletServices.has(link.service))
  byComponent.set(core.index, links)
  return links
}

/** Actual liquid arriving at the core. Injection and a closed RHR return
 * carry heat and mass just as the loop cold legs do. Reverse cold-leg flow
 * leaves the core; it supplies neither inlet enthalpy nor extra throughput.
 * The loop hydraulic calculation and its loop-only flow indication stay separate. */
export const reactorCoreCoolantInlet = (
  system: CompiledProcessPlant,
  core: CompiledComponent,
  context: ComponentNumericReadContext,
  pressureMPa: number,
): {
  readonly forwardFlowKgPerS: number
  readonly reverseFlowKgPerS: number
  readonly netFlowKgPerS: number
  readonly specificEnthalpyKjPerKg: number | null
} => {
  let forwardFlowKgPerS = 0
  let reverseFlowKgPerS = 0
  let enthalpyRateKjPerS = 0
  for (const link of linksFor(system, core)) {
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(flowPath)) continue
    const flow = Math.max(0, context.readNumber(flowPath))
    if (flow === 0) continue
    if (link.service === 'primaryCoolant' && primaryLoopLegReversed(system, link, context)) {
      reverseFlowKgPerS += flow
      continue
    }
    forwardFlowKgPerS += flow
    enthalpyRateKjPerS += flow * liquidEnthalpyKjPerKg(context.readNumber(processLinkVariablePath(link, 'temperatureC')), pressureMPa)
  }
  return {
    forwardFlowKgPerS,
    reverseFlowKgPerS,
    netFlowKgPerS: forwardFlowKgPerS - reverseFlowKgPerS,
    specificEnthalpyKjPerKg: forwardFlowKgPerS > 0 ? enthalpyRateKjPerS / forwardFlowKgPerS : null,
  }
}
