import type { CompiledComponent, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { processLinkVariablePath } from './behavior-contract.ts'
import type { ComponentNumericReadContext } from './component-helpers.ts'

/** A declared RCS liquid withdrawal is a finite inventory boundary, not a
 * second infinite tank. The dedicated port keeps unrelated primary loops and
 * letdown outside the directed auxiliary-delivery network. */
export const isShutdownCoolingSource = (component: CompiledComponent, port: string): boolean =>
  component.kind === 'reactorVessel' && port === 'shutdownCoolingOutlet'

const withdrawalLinks = new WeakMap<CompiledProcessPlant, readonly CompiledProcessLink[]>()

export const shutdownCoolingWithdrawalLinks = (system: CompiledProcessPlant): readonly CompiledProcessLink[] => {
  const cached = withdrawalLinks.get(system)
  if (cached !== undefined) return cached
  const links = system.graph.links.filter(link => link.kind === 'fluidFlow'
    && isShutdownCoolingSource(system.graph.components[link.fromComponentIndex]!, String(link.fromPortName)))
  withdrawalLinks.set(system, links)
  return links
}

export const shutdownCoolingWithdrawalFlowKgPerS = (system: CompiledProcessPlant, context: ComponentNumericReadContext): number =>
  shutdownCoolingWithdrawalLinks(system).reduce((sum, link) => sum + context.readNumber(processLinkVariablePath(link, 'flowKgPerS')), 0)

export const shutdownCoolingWithdrawalThermalRateKgCPerS = (system: CompiledProcessPlant, context: ComponentNumericReadContext): number =>
  shutdownCoolingWithdrawalLinks(system).reduce((sum, link) => sum
    + context.readNumber(processLinkVariablePath(link, 'flowKgPerS')) * context.readNumber(processLinkVariablePath(link, 'temperatureC')), 0)
