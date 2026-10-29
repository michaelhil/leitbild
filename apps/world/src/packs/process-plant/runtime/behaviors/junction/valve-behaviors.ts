import type { CompiledComponent, CompiledProcessLink } from '../../../graph/index.ts'
import { valvePositionController, operatorControllerBindings } from '../../../graph/valve-controller.ts'
import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition, type ComponentInitialReconciliationDefinition } from '../../behavior-contract.ts'
import {
  firstFluidService,
  fluidLinksForService,
  incomingComponentLinks,
  outgoingComponentLinks,
  sumProcessLinkValue,
} from '../../component-link-helpers.ts'
import { clamp, optionalParameterNumber, optionalParameterString, relaxToward } from '../../component-helpers.ts'
import { balancedBranchPressures } from './header-pressure-balance.ts'

type ValveMode = 'control' | 'isolation' | 'check' | 'relief' | 'safety' | 'throttle' | 'bypass'

const valveModes: ReadonlySet<ValveMode> = new Set(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass'])

const deadbandedError = (error: number, deadband: number): number =>
  Math.abs(error) <= deadband ? 0 : error - Math.sign(error) * deadband

const maxLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.max(value, current)
  }
  return value
}

const minLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.min(value, current)
  }
  return value
}

const updateValveFlowDiagnostics = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { system, component, context } = input
  const incomingLinks = incomingComponentLinks(system, component)
  const outgoingLinks = outgoingComponentLinks(system, component)
  const service = firstFluidService([...incomingLinks, ...outgoingLinks])
  const matchingIncoming = fluidLinksForService(incomingLinks, service)
  const matchingOutgoing = fluidLinksForService(outgoingLinks, service)
  const inletFlow = sumProcessLinkValue(matchingIncoming, 'flowKgPerS', context)
  const outletFlow = sumProcessLinkValue(matchingOutgoing, 'flowKgPerS', context)
  // A valve on a pressure-balanced header's branch drops the header's pressure to its vessel's.
  const balanced = balancedBranchPressures(system, component, context)
  const upstreamPressure = balanced?.upstreamMPa
    ?? maxLinkValue(matchingIncoming, 'pressureMPa', context)
    ?? optionalParameterNumber(component, 'initialPressureMPa', component.kind === 'steamValve' ? 6.9 : 1)
  const downstreamPressure = balanced?.downstreamMPa ?? minLinkValue(matchingOutgoing, 'pressureMPa', context) ?? upstreamPressure
  const pressureDrop = Math.max(0, upstreamPressure - downstreamPressure)
  const effectivePosition = clamp(context.readNumber(componentVariablePath(component, 'effectivePositionFraction')), 0, 1)
  const cv = optionalParameterNumber(component, 'cvKgPerSPerSqrtMPa', Number.POSITIVE_INFINITY)
  const capacityLimitedFlow = Number.isFinite(cv) ? cv * Math.sqrt(pressureDrop) * effectivePosition : outletFlow
  const leakageFraction = optionalParameterNumber(component, 'leakageFractionClosed', 0)
  const leakageFlow = inletFlow * leakageFraction * (1 - effectivePosition)
  const reverseFlowAllowed = optionalParameterString(component, 'valveMode', 'control', valveModes) !== 'check'
    && Boolean((component.parameters as Record<string, unknown>).reverseFlowAllowed ?? true)
  const reverseFlow = reverseFlowAllowed ? Math.max(0, outletFlow - inletFlow) : 0
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'availablePressureDropMPa'), pressureDrop)
  context.write(componentVariablePath(component, 'capacityLimitedFlowKgPerS'), capacityLimitedFlow)
  context.write(componentVariablePath(component, 'leakageFlowKgPerS'), leakageFlow)
  context.write(componentVariablePath(component, 'reverseFlowKgPerS'), reverseFlow)
}

const updateValvePositionController = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { component, context } = input
  const controller = valvePositionController(component)
  if (controller === null) return
  const positionPath = componentVariablePath(component, 'positionFraction')
  const isolated = context.readBoolean(componentVariablePath(component, 'isolationSignal'))
  // Under an isolation signal the controller yields: it demands the valve shut until the signal is released.
  if (isolated) {
    context.write(positionPath, 0)
    return
  }
  // Permissives constrain manual control too; changing ownership cannot open a blocked path.
  if (controller.permissive !== undefined && context.readNumber(controller.permissive.path) < controller.permissive.minimum) {
    context.write(positionPath, controller.minPositionFraction)
    return
  }
  const bindings = operatorControllerBindings(component)
  if (bindings !== null && !context.readBoolean(bindings.automatic)) return
  const measured = context.readNumber(controller.measuredPath)
  const setpoint = bindings === null ? controller.setpoint : context.readNumber(bindings.setpoint)
  const error = deadbandedError(measured - setpoint, controller.deadband)
  const action = controller.direction === 'direct' ? error : -error
  const target = clamp(controller.biasPositionFraction + controller.gainPerUnit * action, controller.minPositionFraction, controller.maxPositionFraction)
  context.write(
    positionPath,
    relaxToward(context.readNumber(positionPath), target, context.dtSeconds, controller.timeConstantS),
  )
}

/** How far a bank of spring safety valves (fullLiftMPa) stands lifted at a pressure; null for any other valve. */
const bankLift = (component: CompiledComponent, mode: ValveMode, setpoint: number, pressure: number): number | null => {
  const fullLift = (component.parameters as Readonly<Record<string, unknown>>).fullLiftMPa
  if (fullLift === undefined) return null
  if (mode !== 'safety' || typeof fullLift !== 'number' || !(fullLift > setpoint)) throw new Error(`component ${component.id} declares a full lift pressure, which only a bank of safety valves with a lower set pressure has`)
  return clamp((pressure - setpoint) / (fullLift - setpoint), 0, 1)
}

const valveControlBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-effective-position`,
  phase: 'solveFluidFlowComponents',
  componentKind,
  reads: ['positionFraction', 'positionFailureActive', 'failedPositionFraction', 'isolationSignal', 'incoming:pressureMPa', 'availablePressureDropMPa', 'autoOpenActive'],
  writes: ['demandPositionFraction', 'effectivePositionFraction', 'autoOpenActive'],
  update: ({ system, component, context }): void => {
    // An isolation signal shuts the valve whatever its demand; a failed actuator or a self-acting relief still decides.
    const manualTarget = context.readBoolean(componentVariablePath(component, 'isolationSignal'))
      ? 0
      : clamp(context.readNumber(componentVariablePath(component, 'positionFraction')), 0, 1)
    const failureActive = context.readBoolean(componentVariablePath(component, 'positionFailureActive'))
    const failedPosition = clamp(context.readNumber(componentVariablePath(component, 'failedPositionFraction')), 0, 1)
    const mode = optionalParameterString(component, 'valveMode', 'control', valveModes)
    const incomingLinks = incomingComponentLinks(system, component)
    const upstreamPressure = maxLinkValue(
      fluidLinksForService(incomingLinks, firstFluidService(incomingLinks)),
      'pressureMPa',
      context,
    )
    const pressureDrop = context.has(componentVariablePath(component, 'availablePressureDropMPa'))
      ? context.readNumber(componentVariablePath(component, 'availablePressureDropMPa'))
      : 0
    const setpoint = optionalParameterNumber(component, 'setpointMPa', Number.POSITIVE_INFINITY)
    const reseat = optionalParameterNumber(component, 'reseatMPa', setpoint * 0.98)
    const wasAutoOpen = context.readBoolean(componentVariablePath(component, 'autoOpenActive'))
    const automaticPressure = upstreamPressure ?? pressureDrop
    // A bank of spring safety valves lifts in proportion from its first valve's set pressure to its last's
    // (fullLiftMPa); a single relief or safety valve pops fully open at its set pressure and reseats below it.
    const lift = bankLift(component, mode, setpoint, automaticPressure)
    const autoOpen = lift !== null ? lift > 0 : (mode === 'relief' || mode === 'safety') && (automaticPressure >= setpoint || (wasAutoOpen && automaticPressure > reseat))
    const target = failureActive ? failedPosition : autoOpen ? lift ?? 1 : manualTarget
    const current = context.readNumber(componentVariablePath(component, 'effectivePositionFraction'))
    const timeConstant = target >= current
      ? optionalParameterNumber(component, 'strokeOpenTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
      : optionalParameterNumber(component, 'strokeCloseTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
    const nextPosition = relaxToward(current, target, context.dtSeconds, timeConstant)
    const minimumPosition = optionalParameterNumber(component, 'leakageFractionClosed', 0)
    context.write(
      componentVariablePath(component, 'effectivePositionFraction'),
      clamp(Math.max(nextPosition, minimumPosition), 0, 1),
    )
    context.write(componentVariablePath(component, 'demandPositionFraction'), target)
    context.write(componentVariablePath(component, 'autoOpenActive'), autoOpen)
  },
})

const valvePositionControllerBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-position-controller`,
  phase: 'updateControlLogic',
  componentKind,
  reads: ['positionFraction', 'isolationSignal', 'controller.measuredPath', 'controller.permissive.path?', 'controllerAutomatic?', 'controllerSetpoint?'],
  writes: ['positionFraction'],
  update: updateValvePositionController,
})

const valveDiagnosticsBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-flow-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'outgoing:flowKgPerS', 'incoming:pressureMPa', 'outgoing:pressureMPa', 'effectivePositionFraction', 'pressure-balanced header branch?'],
  writes: ['inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'availablePressureDropMPa', 'capacityLimitedFlowKgPerS', 'reverseFlowKgPerS', 'leakageFlowKgPerS'],
  update: updateValveFlowDiagnostics,
})

const valveDiagnosticsReconciliation = (componentKind: 'processValve' | 'steamValve'): ComponentInitialReconciliationDefinition => ({
  id: `${componentKind}-initial-flow-diagnostics`,
  componentKind,
  afterLinks: true,
  reads: valveDiagnosticsBehavior(componentKind).reads,
  writes: valveDiagnosticsBehavior(componentKind).writes,
  reconcile: updateValveFlowDiagnostics,
})

export const valveInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  valveDiagnosticsReconciliation('processValve'),
  valveDiagnosticsReconciliation('steamValve'),
]

export const valveBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  valvePositionControllerBehavior('processValve'),
  valvePositionControllerBehavior('steamValve'),
  valveControlBehavior('processValve'),
  valveControlBehavior('steamValve'),
  valveDiagnosticsBehavior('processValve'),
  valveDiagnosticsBehavior('steamValve'),
]
