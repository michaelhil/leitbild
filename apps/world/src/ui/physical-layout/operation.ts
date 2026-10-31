import { numberText, unitSymbol, type Observation } from '../../core/observation/model.ts'
import type { TopologyBinding } from '../../core/observation/topology.ts'
import type { LayoutIncidentConnection, LayoutOperationalSubject, LayoutSubjectTopology } from '../../features/displays/layout/operation.ts'
import type { VignetteValue } from '../../features/displays/compose/model.ts'
import { activeState } from '../displays/active-state.ts'

// A validated sample is immutable and shared by all bound occurrences. Do not
// rescan the owner's full observation population separately for every subject.
const sampleIndices = new WeakMap<ReadonlyArray<Observation>, ReadonlyMap<string, Observation>>()
const declarationIndices = new WeakMap<LayoutSubjectTopology, ReadonlyMap<string, VignetteValue>>()

type Quality = Observation['quality'] | 'not-observed'
interface Reading {
  readonly ref: string
  readonly label: string
  readonly quality: Quality
  readonly reason: string | null
  readonly value: Observation['value']
  readonly unit: string
  readonly word: string | null
}
export interface PhysicalFlowOperation extends Reading {
  readonly state: 'flowing' | 'stopped' | 'unknown'
  /** Relative to the declared connection's from/to; never guessed on equipment. */
  readonly direction: 'forward' | 'reverse' | 'stopped' | 'unknown'
  readonly value: number | null
}
export interface PhysicalStateOperation extends Reading { readonly active: boolean | null }
export interface PhysicalPositionOperation extends Reading { readonly fraction: number | null; readonly group?: string | undefined }
export interface PhysicalSubjectOperation {
  readonly subjectId: string
  readonly label: string
  /** Exact incident owner links; these describe the component, not internal physical branches. */
  readonly componentConnections: ReadonlyArray<LayoutIncidentConnection> | null
  readonly connection: Extract<LayoutSubjectTopology, { kind: 'connection' }> | null
  /** One unambiguous owner flow; multiple independent readings are not merged. */
  readonly flow: PhysicalFlowOperation | null
  readonly flows: ReadonlyArray<PhysicalFlowOperation>
  readonly equipment: {
    readonly class: Extract<LayoutSubjectTopology, { kind: 'node' }>['class']
    readonly kind: string
    readonly running: PhysicalStateOperation | null
    readonly conducting: PhysicalStateOperation | null
    readonly positions: ReadonlyArray<PhysicalPositionOperation>
  } | null
  readonly conducting: PhysicalStateOperation | null
}

/** Resolve only declared roles against actual acquired observations. A bad,
 * missing, uncertain or frozen sample cannot become a stopped pump/empty pipe. */
export const resolvePhysicalSubjectOperation = (subject: LayoutOperationalSubject, observations: ReadonlyArray<Observation>, stale: boolean): PhysicalSubjectOperation => {
  const topology = subject.topology
  const empty: PhysicalSubjectOperation = { subjectId: subject.elementId, label: subject.label, componentConnections: null, connection: null, flow: null, flows: [], equipment: null, conducting: null }
  if (!topology) return empty
  let declared = declarationIndices.get(topology), observed = sampleIndices.get(observations)
  if (!declared) { declared = new Map(topology.values.map(value => [value.ref, value])); declarationIndices.set(topology, declared) }
  if (!observed) { observed = new Map(observations.map(value => [value.ref, value])); sampleIndices.set(observations, observed) }
  const read = (binding: TopologyBinding): { reading: Reading; declaration: VignetteValue | undefined } => {
    const declaration = declared.get(binding.ref), observation = observed.get(binding.ref)
    let quality: Quality = stale ? 'stale' : observation?.quality ?? 'not-observed', reason: string | null = null
    if (!declaration) { if (!stale) quality = 'not-observed'; reason = 'No acquired owner declaration' }
    if (binding.while !== undefined && !stale) {
      const guard = observed.get(binding.while)
      if (!guard || guard.quality !== 'good' || typeof guard.value !== 'boolean') { quality = 'not-observed'; reason = 'Binding condition is not known' }
      else if (!guard.value) { quality = 'not-applicable'; reason = 'Binding condition is not active' }
    }
    const value = quality === 'good' && declaration ? observation?.value ?? null : null
    const word = typeof value === 'boolean' || typeof value === 'string' ? declaration?.states?.find(state => state.value === String(value))?.label ?? (typeof value === 'string' ? value : null) : null
    return { declaration, reading: { ref: binding.ref, label: declaration?.label ?? binding.role, quality, reason: reason ?? (stale ? 'Not live' : observation?.why ?? (quality === 'good' ? null : quality)), value, unit: declaration?.unit ?? '', word } }
  }
  // Conditional alternates apply to the preceding reading of the same role.
  // An unknown guard prevents a falsely definite fallback to that reading.
  const bindingsFor = (role: TopologyBinding['role']): TopologyBinding[] => {
    const selected: TopologyBinding[] = []
    for (const binding of topology.bindings.filter(binding => binding.role === role)) {
      if (!binding.while) { selected.push(binding); continue }
      const guard = observed.get(binding.while)
      if (guard?.quality === 'good' && guard.value === false) continue
      let previous = -1
      for (let index = selected.length - 1; index >= 0; index--) if (selected[index]!.group === binding.group) { previous = index; break }
      if (previous < 0) selected.push(binding); else selected[previous] = binding
    }
    return selected
  }
  const states = (role: 'running' | 'conducting'): PhysicalStateOperation | null => {
    const bindings = bindingsFor(role)
    if (bindings.length !== 1) return null
    const { reading, declaration } = read(bindings[0]!)
    const knownState = typeof reading.value !== 'string' || declaration?.states?.some(state => state.value === reading.value)
    return { ...reading, active: reading.quality === 'good' && knownState ? activeState(reading.value, declaration?.states) : null }
  }
  const flows: PhysicalFlowOperation[] = bindingsFor('flow').map(binding => {
    const { reading, declaration } = read(binding)
    const value = reading.quality === 'good' && typeof reading.value === 'number' && Number.isFinite(reading.value) ? reading.value : null
    const state = value === null ? 'unknown' : value === 0 ? 'stopped' : 'flowing'
    // This is exact sign/zero on the owner's declared flow, with no UI epsilon
    // or inferred pump state. Energized is not numerical electrical power.
    const direction = value === null ? 'unknown' : value === 0 ? 'stopped' : topology.kind === 'connection' && topology.directed ? value > 0 ? 'forward' : 'reverse' : 'unknown'
    return { ...reading, value, state, direction, word: value === null ? null : `${numberText(value, reading.unit, declaration?.quantity, declaration?.decades)}${unitSymbol(reading.unit) ? ` ${unitSymbol(reading.unit)}` : ''}` }
  })
  const positions: PhysicalPositionOperation[] = bindingsFor('position').map(binding => {
    const { reading, declaration } = read(binding), value = typeof reading.value === 'number' && Number.isFinite(reading.value) ? reading.value : null
    const share = value === null ? null : reading.unit === '%' ? value / 100 : reading.unit === '1' ? value : null
    const fraction = share !== null && share >= 0 && share <= 1 ? share : null, travel = declaration?.travel
    const word = value === null ? null : travel && value < travel.below ? travel.low : travel && value > travel.above ? travel.high : `${numberText(value, reading.unit, declaration?.quantity, declaration?.decades)}${unitSymbol(reading.unit) ? ` ${unitSymbol(reading.unit)}` : ''}`
    return { ...reading, word, fraction, ...(binding.group ? { group: binding.group } : {}) }
  })
  const conducting = states('conducting')
  return { ...empty, componentConnections: topology.kind === 'node' ? topology.connections ?? null : null, connection: topology.kind === 'connection' ? topology : null, flows, flow: flows.length === 1 ? flows[0]! : null, conducting,
    equipment: topology.kind === 'node' ? { class: topology.class, kind: topology.equipmentKind, running: states('running'), conducting, positions } : null }
}
