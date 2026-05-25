import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from './behavior-contract.ts'
import { clamp } from './component-helpers.ts'
import {
  componentValveCapacityForInboundLink,
  componentValveFactorForInboundLink,
  hasProcessLinkVariable,
  linkValveFactor,
} from './link-flow-helpers.ts'
import { processLinkFlowSourceFor } from './link-flow-source-strategy.ts'
import { pressureDrivenLeakFlowKgPerS } from './physics.ts'
import { physicalFlowCapacityKgPerS, physicalNumber } from './process-link-physical.ts'

export const processLinkFlowBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-fluid-flow',
    phase: 'solveFluidFlowLinks',
    reads: ['valve.positionFraction?', 'leak.areaFraction?', 'source component flow demand'],
    writes: ['flowKgPerS'],
    appliesTo: (link): boolean => link.kind === 'fluidFlow' && hasProcessLinkVariable(link, 'flowKgPerS'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      const currentLinkValveFactor = linkValveFactor(link, context)
      const currentComponentValveFactor = componentValveFactorForInboundLink(system, link, context)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const source = processLinkFlowSourceFor({ system, link, context })
      let flowSource = source.flowKgPerS
      if (!source.bypassTargetPumpLimit && toComponent.kind === 'centrifugalPump') {
        flowSource = Math.min(flowSource, context.readNumber(componentVariablePath(toComponent, 'flowKgPerS')))
      }
      const capacity = physicalFlowCapacityKgPerS(link)
      const componentValveCapacity = componentValveCapacityForInboundLink(system, link, context)
      const effectiveValveFactor = source.alreadyIncludesLinkValveFactor
        ? 1
        : currentLinkValveFactor * (source.alreadyIncludesTargetValveDemand ? 1 : currentComponentValveFactor)
      context.write(processLinkVariablePath(link, 'flowKgPerS'), Math.min(flowSource, capacity, componentValveCapacity) * effectiveValveFactor * (1 - leakFraction))
    },
  },
  {
    id: 'process-link-pressure-driven-leak',
    phase: 'solveFluidFlowLinks',
    reads: ['pressureMPa', 'leak.areaFraction?', 'physical.leakCoefficientKgPerSPerSqrtMPa'],
    writes: ['leakFlowKgPerS'],
    appliesTo: (link): boolean =>
      link.kind === 'fluidFlow'
      && hasProcessLinkVariable(link, 'pressureMPa')
      && hasProcessLinkVariable(link, 'leakFlowKgPerS'),
    update: ({ link, context }): void => {
      const pressure = context.readNumber(processLinkVariablePath(link, 'pressureMPa'))
      const leakArea = context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0)
      context.write(processLinkVariablePath(link, 'leakFlowKgPerS'), pressureDrivenLeakFlowKgPerS({
        areaFraction: leakArea,
        pressureDeltaMPa: pressure - 0.101325,
        coefficientKgPerSPerSqrtMPa: physicalNumber(link, 'leakCoefficientKgPerSPerSqrtMPa', 0),
      }))
    },
  },
]
