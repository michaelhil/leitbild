import type { ObjectId } from '../../../core/model/index.ts'
import type { ElementTable } from '../../../core/observation/capabilities.ts'
import type { ComparisonOperator, CriterionCheck, Observable, Observation } from '../../../core/observation/model.ts'
import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import { primaryLoopIdForPump, primaryLoopPumps } from '../graph/primary-loop.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcSafetyFunction, ProcessPlantIcSafetyFunctionCondition } from '../runtime/index.ts'
import type { SafetyFunctionEvaluation } from '../safety-functions.ts'
import { findProcessPlantSignalBinding } from '../signals.ts'

// What an operator verifies on an energy end's detail beside its values (plan v5 W1.4, D-E): each critical safety
// function's further checks as one criterion (E-0's trip verification, ES-0.1's natural circulation, the heat sink's
// total feed), counted met per sample from the function's tree evaluation; and a reactor core's loops as one table.
// Both are static declarations; the criterion's checks are judged where its function is, in safety-functions.ts.

/** A criterion's path: beside its function's status, never a signal of the Plant. */
const criterionPath = (safetyFunction: string): string => `csf.${safetyFunction}.checks`

/** The equipment whose detail an operator verifies each function's checks on: the trip and natural circulation on the core, the heat sink's feed on every steam generator. */
const JUDGED_ON: Readonly<Record<string, string>> = { subcriticality: 'reactorCore', 'core-cooling': 'reactorCore', 'heat-sink': 'steamGenerator' }

/** What the checks' labels share before their colon ("Natural circulation"), else the function's label with "checks". */
const criterionLabel = (safetyFunction: ProcessPlantIcSafetyFunction): string => {
  const heads = [...new Set(safetyFunction.checks.map(check => (check.label.includes(':') ? check.label.slice(0, check.label.indexOf(':')).trim() : '')))]
  return heads.length === 1 && heads[0] !== '' ? heads[0]! : `${safetyFunction.label} checks`
}

/** The one number a check compares, where it compares one reading or a total of several with a limit. */
const comparedValue = (condition: ProcessPlantIcSafetyFunctionCondition): { readonly signal: Parameters<typeof findProcessPlantSignalBinding>[1]; readonly operator: ComparisonOperator; readonly value: number } | undefined => {
  if ((condition.type !== 'comparison' && condition.type !== 'total') || typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=') return undefined
  return { signal: condition.type === 'comparison' ? condition.signal : condition.signals[0]!, operator: condition.operator, value: condition.value }
}

interface Criterion {
  readonly safetyFunction: string
  readonly observable: (objectId: ObjectId) => Observable
}

const byPlant = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, Criterion>>()

/** Each function that declares checks and an end to judge them on, as a criterion, by its path. */
const criteriaOf = (plant: CompiledProcessPlant, unitOf: (binding: ProcessSignalBinding) => Pick<Observable, 'quantity' | 'unit'>): ReadonlyMap<string, Criterion> => byPlant.get(plant) ?? (() => {
  const found = new Map(plant.automation.safetyFunctions.filter(safetyFunction => safetyFunction.checks.length > 0 && JUDGED_ON[safetyFunction.id] !== undefined).map(safetyFunction => {
    const path = criterionPath(safetyFunction.id)
    if (plant.graph.signalBindingByPath.has(path as VariablePath)) throw new Error(`${path} is a signal of the Plant and a safety function's criterion`)
    const checks = safetyFunction.checks.map((check): CriterionCheck => {
      const compared = comparedValue(check.condition)
      const binding = compared === undefined ? undefined : findProcessPlantSignalBinding(plant.graph, compared.signal)
      return {
        label: check.label.slice(0, 120), ...(check.shortLabel === undefined ? {} : { shortLabel: check.shortLabel }),
        ...(compared === undefined || binding === undefined ? {} : { compares: { operator: compared.operator, value: compared.value, ...unitOf(binding) } }),
      }
    })
    const label = criterionLabel(safetyFunction)
    return [path, { safetyFunction: safetyFunction.id, observable: (objectId: ObjectId): Observable => ({
      ref: `${objectId}#${path}`, label, quantity: 'count', unit: '1', valueType: 'criterion', thresholds: [], series: null, checks,
    }) }] as const
  }))
  byPlant.set(plant, found)
  return found
})()

/** The Plant's criteria, declared as observables of the unit. */
export const criterionObservables = (objectId: ObjectId, plant: CompiledProcessPlant, unitOf: (binding: ProcessSignalBinding) => Pick<Observable, 'quantity' | 'unit'>): ReadonlyArray<Observable> =>
  [...criteriaOf(plant, unitOf).values()].map(criterion => criterion.observable(objectId))

/** Each component's criteria, by component id: those of the functions judged on its kind, in the functions' order. */
export const elementCriteria = (objectId: ObjectId, plant: CompiledProcessPlant, unitOf: (binding: ProcessSignalBinding) => Pick<Observable, 'quantity' | 'unit'>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const criteria = [...criteriaOf(plant, unitOf)]
  return new Map(plant.graph.components.flatMap(component => {
    const refs = criteria.filter(([, criterion]) => JUDGED_ON[criterion.safetyFunction] === component.kind).map(([path]) => `${objectId}#${path}`)
    return refs.length === 0 ? [] : [[String(component.id), refs] as const]
  }))
}

/**
 * A criterion now, from its function's evaluation: how many of its checks that apply are met, each check by its place
 * with what a comparing one measured; not applicable while none applies. Null for a path that is no criterion.
 */
export const readCriterion = (plant: CompiledProcessPlant, path: string, safetyFunctions: () => ReadonlyArray<SafetyFunctionEvaluation>): Pick<Observation, 'value' | 'quality' | 'priority' | 'why' | 'checks'> | null => {
  const declared = plant.automation.safetyFunctions.find(safetyFunction => criterionPath(safetyFunction.id) === path)
  if (declared === undefined || declared.checks.length === 0 || JUDGED_ON[declared.id] === undefined) return null
  const evaluation = safetyFunctions().find(candidate => candidate.id === declared.id)!
  const applying = evaluation.checks.map(check => {
    const at = declared.checks.findIndex(entry => entry.label === check.label)
    const compared = comparedValue(declared.checks[at]!.condition)
    const comparison = check.comparisons[0]
    const measured = compared === undefined || comparison === undefined ? undefined : comparison.measured ?? (typeof comparison.reads[0]?.value === 'number' ? comparison.reads[0].value : undefined)
    return { check: at, met: check.met, ...(measured === undefined || !Number.isFinite(measured) ? {} : { measured }), notMet: check.notMet }
  })
  if (applying.length === 0) return { value: null, quality: 'not-applicable', priority: 'none', why: 'none of its checks applies now' }
  const why = applying.flatMap(entry => (entry.notMet === undefined ? [] : [entry.notMet])).join(' ').slice(0, 300)
  return {
    value: applying.filter(entry => entry.met === 'yes').length, quality: 'good', priority: 'none',
    checks: applying.map(({ notMet: _notMet, ...entry }) => entry), ...(why === '' ? {} : { why }),
  }
}

/**
 * A reactor core's loops as one table, by the core's id: a line per primary loop, by its loop name; the loop's hot and
 * cold leg temperatures where its lines leave the core for its steam generator and enter its pump (Thot, Tcold, their tagged readings), its
 * delta-T channel's delta-T and its pump's measured loop flow. Only declared values; a column none has is left out.
 */
export const elementTables = (objectId: ObjectId, plant: CompiledProcessPlant, declared: (path: string) => boolean): ReadonlyMap<string, ElementTable> => {
  const graph = plant.graph
  const tagged = (owner: (binding: ProcessSignalBinding) => boolean, quantity: ProcessSignalBinding['quantity']): string | null =>
    graph.signalBindings.find(binding => owner(binding) && binding.quantity === quantity && binding.tagId !== undefined && declared(String(binding.path)))?.path ?? null
  const onLink = (index: number | undefined) => (binding: ProcessSignalBinding) => binding.owner.type === 'link' && binding.owner.linkIndex === index
  const onComponent = (index: number | undefined) => (binding: ProcessSignalBinding) => binding.owner.type === 'component' && binding.owner.componentIndex === index
  return new Map(graph.components.filter(component => component.kind === 'reactorCore').flatMap(core => {
    const lines = primaryLoopPumps(graph).map(pump => {
      const loop = primaryLoopIdForPump(pump)!
      const hot = graph.links.find(link => link.fromComponentIndex === core.index && String(link.fromPortName) === `hotLeg${loop}` && graph.components[link.toComponentIndex]?.kind === 'steamGenerator')
      const cold = graph.links.find(link => link.toComponentIndex === pump.index && link.service === 'primaryCoolant')
      const channel = graph.components.find(component => component.kind === 'deltaTProtectionChannel' && component.metadata?.loopId === (pump.metadata?.loopId ?? loop))
      const deltaT = channel === undefined ? null : [`${channel.id}.deltaTC`].find(path => declared(path)) ?? null
      return { label: pump.metadata?.loopId ?? loop, paths: [tagged(onLink(hot?.index), 'temperature'), tagged(onLink(cold?.index), 'temperature'), deltaT, tagged(onComponent(pump.index), 'flowRate')] }
    })
    const columns = ['Thot', 'Tcold', 'ΔT', 'Flow'].map((label, at) => ({ label, at })).filter(column => lines.some(line => line.paths[column.at] !== null))
    if (lines.length < 2 || columns.length === 0) return []
    return [[String(core.id), {
      columns: columns.map(column => column.label),
      lines: lines.map(line => ({ label: line.label, refs: columns.map(column => (line.paths[column.at] === null ? null : `${objectId}#${line.paths[column.at]}`)) })),
    }] as const]
  }))
}
