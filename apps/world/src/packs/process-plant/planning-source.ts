import { z } from 'zod'
import type { PlanningSourceFact, PlanningSourceSubject } from '@leitbild/contracts'
import { planningProjectionCapability, planningProjectionInputSchema } from '../../simulation/planning-source.ts'
import { unavailableQueryReadScope, type QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import type { IsoTimestamp } from '../../core/model/time.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { variablePathSchema } from './graph/model.ts'
import { isInjectedFault, processPlantSignalQuality } from './signals.ts'

export const processPlantPlanningCapability = planningProjectionCapability('world.process-plant.planning-basis')
const locator = (plantId: string, componentId: string): string => `process-plant/${encodeURIComponent(plantId)}/${encodeURIComponent(componentId)}`
const pumpParametersSchema = z.object({
  nominalFlowKgPerS: z.number().finite().positive(),
  runUpTimeS: z.number().finite().positive().optional(),
  coastdownTimeConstantS: z.number().finite().positive().optional(),
})
const fact = (id: string, label: string, semantic: PlanningSourceFact['semantic'], value: PlanningSourceFact['value'], unit?: string, basis: PlanningSourceFact['basis'] = 'observation'): PlanningSourceFact => ({ id, label, semantic, value, ...(unit === undefined ? {} : { unit }), basis })

export const readProcessPlantPlanningSource = (config: {
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly policy: QueryReadPolicy
  readonly input: unknown
  readonly simulationTime?: IsoTimestamp
}) => {
  const input = planningProjectionInputSchema.parse(config.input)
  const choices = new Map<string, { plantId: string; componentId: string; system: ProcessPlantRuntimeInstance }>()
  for (const [plantId, system] of config.plants) {
    if (!config.policy.canInspect(plantId)) unavailableQueryReadScope('Plant planning source is unavailable to the shared research audience')
    for (const component of system.plant.graph.components) if (component.kind === 'centrifugalPump') {
      choices.set(locator(plantId, component.id), { plantId, componentId: component.id, system })
    }
  }
  const selected = input.subjectIds ?? [...choices.keys()]
  if (!selected.length || selected.length > 32 || new Set(selected).size !== selected.length || selected.some(id => !choices.has(id))) unavailableQueryReadScope('The selected pump source set is unavailable or exceeds 32 subjects; select exact returned locators')
  if (input.purpose === 'qualify') return { allowed: true }
  if (config.simulationTime === undefined) throw new Error('Plant planning source requires a simulation-time frame')
  const subjects: PlanningSourceSubject[] = selected.map(id => {
    const { plantId, componentId, system } = choices.get(id)!
    const component = system.plant.graph.components.find(item => item.id === componentId)!
    const parameters = pumpParametersSchema.parse(component.parameters)
    const prefix = `${plantId}/${componentId}`
    const facts: PlanningSourceFact[] = [
      fact(`${prefix}/model-digest`, 'Plant model revision', 'state', system.plant.modelDigest),
      fact(`${prefix}/nominal-flow`, 'Nominal pump flow', 'capacity', parameters.nominalFlowKgPerS, 'kg/s', 'owner-estimate'),
    ]
    if (parameters.runUpTimeS !== undefined) facts.push(fact(`${prefix}/runup-seconds`, 'Modeled run-up duration', 'duration', parameters.runUpTimeS, 's', 'owner-estimate'))
    if (parameters.coastdownTimeConstantS !== undefined) facts.push(fact(`${prefix}/coastdown-seconds`, 'Modeled coastdown half-time', 'duration', parameters.coastdownTimeConstantS, 's', 'owner-estimate'))
    // Only these public operational readings are projected. Neither writable
    // fault controls nor simulator-only/injected truth becomes planning data.
    for (const local of ['runningState', 'speedRpm', 'flowKgPerS'] as const) {
      const path = variablePathSchema.parse(`${componentId}.${local}`)
      const binding = system.plant.graph.signalBindingByPath.get(path)
      if (binding === undefined || !binding.published || isInjectedFault(binding) || binding.simulatorOnly || binding.capabilities?.aiVisible === false) continue
      const value = system.runtime.readVariableSnapshot(path)
      const quality = processPlantSignalQuality(value, { system: system.plant, runtime: system.runtime })
      if (quality.status !== 'good') facts.push(fact(`${prefix}/${local}/quality`, `${binding.label} quality`, 'state', quality.status))
      else facts.push(fact(`${prefix}/${local}`, binding.label, typeof value.value === 'boolean' ? 'state' : 'quantity', value.value, binding.unit))
    }
    return { locator: id, label: component.label, kind: 'pump', facts }
  })
  return { simulationAt: config.simulationTime, subjects }
}
