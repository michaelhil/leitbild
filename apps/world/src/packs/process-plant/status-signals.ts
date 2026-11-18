import type { VariablePath } from './graph/index.ts'
import { findProcessPlantSignalBinding, processPlantSignalQuality, processPlantSignalView } from './signals.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'

// Read-only readings procedures name that the graph tags nowhere: I&C rule state, which is no variable,
// and cold-leg delivery, a variable with no tag. A table rather than graph tags, because a graph tag
// moves the model digest. Nothing here enters the graph or the I&C definition. Each row reads existing
// state and nothing else. Design record: wiki world/packs/process-plant/status-signals.md.
type StatusSignal = { readonly label: string; readonly rules: ReadonlyArray<string> } | { readonly path: string }
const statusSignals: Readonly<Record<string, StatusSignal>> = {
  'SI-ACTUATED': { label: 'Safety injection actuated', rules: ['safety-injection-low-pzr-pressure', 'safety-injection-containment-pressure-high-1', 'safety-injection-manual'] },
  'SI-CL-A-FLOW': { path: 'safety-injection-header-to-cold-leg-a.flowKgPerS' },
  'SI-CL-B-FLOW': { path: 'safety-injection-header-to-cold-leg-b.flowKgPerS' },
  'SI-CL-C-FLOW': { path: 'safety-injection-header-to-cold-leg-c.flowKgPerS' },
  'SI-CL-D-FLOW': { path: 'safety-injection-header-to-cold-leg-d.flowKgPerS' },
}

export interface ProcessPlantStatusReading {
  readonly signal: Record<string, unknown> & { readonly unit: string; readonly quantity: string }
  readonly read: () => { readonly variable: Record<string, unknown> & { readonly value: number | boolean }; readonly quality: { readonly status: string; readonly reason?: string } }
}

/** A table row on this Plant, or undefined: the tag is not in the table, or this Plant's model lacks what it reads. */
export const processPlantStatusReading = (system: ProcessPlantRuntimeInstance, tagId: string | undefined): ProcessPlantStatusReading | undefined => {
  const row = tagId === undefined ? undefined : statusSignals[tagId]
  if (row === undefined) return undefined
  if ('path' in row) {
    const binding = findProcessPlantSignalBinding(system.plant.graph, { path: row.path as VariablePath })
    if (binding === undefined) return undefined
    return { signal: { ...processPlantSignalView(binding), tagId }, read: () => {
      const variable = system.runtime.readVariableSnapshot(binding.path)
      return { variable: { ...variable }, quality: processPlantSignalQuality(variable, { system: system.plant, runtime: system.runtime }) }
    } }
  }
  if (!row.rules.every(ruleId => system.plant.automation.rules.some(rule => rule.id === ruleId))) return undefined
  return { signal: { tagId, label: row.label, unit: 'boolean', quantity: 'boolean', writable: false }, read: () => {
    const snapshot = system.protection?.snapshot()
    const failure = snapshot?.failures.find(item => row.rules.includes(item.ruleId))
    const value = snapshot?.rules.some(rule => row.rules.includes(rule.ruleId) && (rule.active || rule.latched)) === true
    return { variable: { value, unit: 'boolean', writable: false },
      quality: snapshot === undefined ? { status: 'unavailable', reason: 'I&C state is unavailable.' } : failure !== undefined ? { status: 'unavailable', reason: `I&C rule evidence is unavailable: ${failure.message}` } : { status: 'good' } }
  } }
}
