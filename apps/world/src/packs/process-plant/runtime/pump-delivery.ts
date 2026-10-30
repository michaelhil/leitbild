import type { CompiledComponent } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { componentVariablePath } from './behavior-contract.ts'
import { clamp, type ComponentNumericReadContext } from './component-helpers.ts'
import { primarySystemPressurizer } from './system-topology.ts'
import { downstreamPumpSuctionDemandOpen } from './directed-fluid-delivery.ts'

/** The fraction of runout a pump can deliver against actual RCS pressure. */
export const reactorCoolantDeliveryFraction = (system: CompiledProcessPlant, component: CompiledComponent, context: ComponentNumericReadContext & { readonly readBoolean: (path: ReturnType<typeof componentVariablePath>) => boolean }, speed: number): number => {
  const shutoffPressure = (component.parameters as Readonly<Record<string, unknown>>).reactorCoolantShutoffPressureMPa
  if (typeof shutoffPressure !== 'number') return 1
  if (downstreamPumpSuctionDemandOpen(system, component, context)) return 1
  const pressurizer = primarySystemPressurizer(system)
  if (pressurizer === null) throw new Error(`pump ${component.id} injects into the reactor coolant system, which has no pressurizer to read its pressure from`)
  const pressure = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
  return Math.sqrt(clamp(1 - pressure / Math.max(1e-6, shutoffPressure * speed * speed), 0, 1))
}
