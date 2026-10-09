import type { ProcessSignalBinding, VariablePath } from '../../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../../runtime-instance.ts'
import { icAlarmRuleIdsForComponent, icAlarmRuleIdsForPaths, icThresholdsForSignal } from '../ic-thresholds.ts'
import { thresholdName } from '../display-text.ts'
import {
  MIMIC_WIDTH,
  type CompiledMimic,
  type ComposedMimicView,
  type MimicNode,
  type MimicPipe,
  type MimicState,
} from './mimic-model.ts'
import { loopedMimicViews, pwrReferenceMimicViews, type MimicStateSpec } from './pwr-reference-views.ts'

// Mimic views exist per Plant model; a model without reviewed views has none.
const viewsByModel = { 'process-plant.pwr.reference': pwrReferenceMimicViews } as const

// Below these flows a pipe is drawn without flow ("≈0"). Per service, because
// most links declare no nominal flow.
const noFlowBelowByService: Readonly<Record<string, number>> = {
  feedwater: 2,
  auxFeedwater: 0.5,
  mainSteam: 2,
  primaryCoolant: 20,
  primaryRelief: 0.2,
}

export type MimicCompileResult =
  | { readonly ok: true; readonly mimic: CompiledMimic }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> }

/** Loops of the Plant, in order, from its steam generators. */
export const plantLoops = (system: ProcessPlantRuntimeInstance): ReadonlyArray<string> =>
  system.plant.graph.components
    .filter(component => component.metadata?.equipmentClass === 'steam-generator' && component.metadata.loopId !== undefined)
    .map(component => component.metadata!.loopId!)
    .sort()

export const compileMimic = (
  system: ProcessPlantRuntimeInstance,
  request: { readonly view: ComposedMimicView; readonly loops?: ReadonlyArray<string> },
): MimicCompileResult => {
  const views = (viewsByModel as Readonly<Record<string, typeof pwrReferenceMimicViews | undefined>>)[system.plant.modelRef]
  if (views === undefined) return { ok: false, issues: [`mimic panels are not available for Plant model ${system.plant.modelRef}`] }
  const available = plantLoops(system)
  if (request.loops !== undefined && !loopedMimicViews.has(request.view)) return { ok: false, issues: [`view ${request.view} is not drawn per loop; remove loops`] }
  const loops = request.loops ?? available
  const unknown = loops.filter(loop => !available.includes(loop))
  if (unknown.length > 0) return { ok: false, issues: [`loops ${unknown.join(', ')} do not exist in ${system.plant.id}; it has loops ${available.join(', ')}`] }
  if (new Set(loops).size !== loops.length) return { ok: false, issues: ['list each loop once'] }
  const ordered = available.filter(loop => loops.includes(loop))
  const spec = views[request.view](ordered)

  const graph = system.plant.graph
  const issues: string[] = []
  // State comes from measured or derived variables only; a writable path
  // here would draw a command as if it were the equipment's state.
  const readPath = (path: string, purpose: 'state' | 'annotation'): VariablePath => {
    const binding: ProcessSignalBinding | undefined = graph.signalBindingByPath.get(path as VariablePath)
    if (binding === undefined) issues.push(`view ${request.view} reads ${path}, which ${system.plant.id} does not have`)
    else if (purpose === 'state' && binding.writable) issues.push(`view ${request.view} would draw the writable command ${path} as equipment state`)
    return path as VariablePath
  }
  const stateFor = (state: MimicStateSpec): MimicState => {
    if (state.kind === 'pump') return { kind: 'pump', speedPath: readPath(`${state.component}.speedRpm`, 'state'), commandPath: readPath(`${state.component}.running`, 'annotation') }
    if (state.kind === 'valve') return { kind: 'valve', positionPath: readPath(`${state.component}.effectivePositionFraction`, 'state'), commandPath: readPath(`${state.component}.positionFraction`, 'annotation') }
    if (state.kind === 'level') return { kind: 'level', levelPath: readPath(state.path, 'state'), unit: state.unit }
    if (state.kind === 'header') {
      const services = state.links.map(linkId => graph.links.find(candidate => String(candidate.id) === linkId)?.service ?? 'unknown')
      return { kind: 'header', flowPaths: state.links.map(linkId => readPath(`${linkId}.flowKgPerS`, 'state')), noFlowBelow: noFlowBelowByService[services[0]!] ?? 1 }
    }
    if (state.kind === 'relief') return { kind: 'relief', flowPath: readPath(state.flow, 'state'), commandPath: readPath(state.command, 'annotation'), noFlowBelow: noFlowBelowByService.primaryRelief! }
    return { kind: 'none' }
  }

  const nodes: MimicNode[] = spec.nodes.map(node => {
    if (!graph.componentIndexById.has(node.componentId as never)) issues.push(`view ${request.view} draws ${node.componentId}, which ${system.plant.id} does not have`)
    return {
      id: node.id,
      componentId: node.componentId,
      symbol: node.symbol,
      label: node.label,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      orientation: node.orientation,
      state: stateFor(node.state),
      values: node.values.map(value => ({ path: readPath(value.path, 'state'), unit: value.unit, side: value.side, ...(value.name === undefined ? {} : { name: value.name }) })),
      ruleIds: node.alarmPaths === undefined
        ? icAlarmRuleIdsForComponent(system.plant, node.componentId)
        : icAlarmRuleIdsForPaths(system.plant, node.alarmPaths.map(path => readPath(path, 'annotation'))),
      limits: node.limitsOf === undefined ? [] : icThresholdsForSignal(system.plant, readPath(node.limitsOf, 'state')).thresholds
        .filter((threshold): threshold is typeof threshold & { kind: 'alarm' | 'trip' } => threshold.kind !== 'control')
        .map(threshold => ({ value: threshold.value, kind: threshold.kind, name: thresholdName(threshold, 'percent') })),
    }
  })
  const pipes: MimicPipe[] = spec.pipes.map(pipe => {
    const link = graph.links.find(candidate => String(candidate.id) === pipe.linkId)
    if (link === undefined) issues.push(`view ${request.view} draws link ${pipe.linkId}, which ${system.plant.id} does not have`)
    const service = link?.service ?? 'unknown'
    return {
      id: pipe.id,
      linkId: pipe.linkId,
      service,
      points: pipe.points,
      flowPath: readPath(`${pipe.linkId}.flowKgPerS`, 'state'),
      noFlowBelow: noFlowBelowByService[service] ?? 1,
      unverified: pipe.unverified === true,
    }
  })
  if (issues.length > 0) return { ok: false, issues }

  const paths = [...new Set([
    ...nodes.flatMap(node => [
      ...(node.state.kind === 'pump' ? [node.state.speedPath, node.state.commandPath] : []),
      ...(node.state.kind === 'valve' ? [node.state.positionPath, node.state.commandPath] : []),
      ...(node.state.kind === 'level' ? [node.state.levelPath] : []),
      ...(node.state.kind === 'relief' ? [node.state.flowPath, node.state.commandPath] : []),
      ...(node.state.kind === 'header' ? node.state.flowPaths : []),
      ...node.values.map(value => value.path),
    ]),
    ...pipes.map(pipe => pipe.flowPath),
  ])]
  return { ok: true, mimic: { view: request.view, loops: ordered, width: MIMIC_WIDTH, height: spec.height, nodes, pipes, paths } }
}
