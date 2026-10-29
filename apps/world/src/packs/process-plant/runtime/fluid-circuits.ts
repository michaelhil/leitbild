import type { CompiledComponent, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'

/** Service labels do not join separate fluid circuits inside one component. */
export const sameComponentFluidCircuit = (component: CompiledComponent, firstPort: string, secondPort: string): boolean =>
  component.ports[firstPort]?.circuit === component.ports[secondPort]?.circuit

/** An upstream reading that belongs to the fluid leaving this exact port. */
export const isIncomingFluidForOutlet = (system: CompiledProcessPlant, outlet: CompiledProcessLink, candidate: CompiledProcessLink): boolean => {
  const component = system.graph.components[outlet.fromComponentIndex]
  return component !== undefined && candidate.kind === 'fluidFlow' && candidate.service === outlet.service
    && sameComponentFluidCircuit(component, String(outlet.fromPortName), String(candidate.toPortName))
}
