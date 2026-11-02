import { z } from 'zod'
import type { PackWorkspaceCapability } from '../../simulation/protocol.ts'
import { rejectCapabilityInput } from '../../simulation/capability-rejection.ts'
import { processPlantDefinitionCatalog } from './plant-definitions.ts'

const input = z.object({ modelRef: z.string().min(1).optional() }).strict()
const definition = z.object({ id: z.string(), title: z.string(), description: z.string() }).strict()
const compatible = definition.extend({ compatibleModelRefs: z.array(z.string()) }).strict()
const output = z.object({
  models: z.array(definition.extend({ parameters: z.record(z.string(), z.unknown()) }).strict()),
  operatingPoints: z.array(compatible), automations: z.array(compatible),
  application: z.literal('new-scenario-revision'), liveModelReplacement: z.literal(false),
}).strict()

export const processPlantWorkspaceCapabilities: ReadonlyArray<PackWorkspaceCapability> = [{
  id: 'world.process-plant.models.describe', title: 'Describe Process Plant model choices',
  description: 'Pre-run model parameters, units, required values and compatible operating points/automation. Optional modelRef selects one exact supported model. Reads owning definitions only; starts no Run or solver. Author selections in the plant item, not Pack configuration. Model/topology replacement requires a new Scenario Revision and Run; runtime control actions are separate capabilities.',
  kind: 'query', risk: 'read', idempotent: true, input, output,
  invoke: async raw => {
    const { modelRef } = input.parse(raw), catalog = processPlantDefinitionCatalog()
    if (modelRef !== undefined && !catalog.models.some(model => model.id === modelRef)) return rejectCapabilityInput('Unknown Process Plant model: ' + modelRef)
    return { models: catalog.models.filter(model => modelRef === undefined || model.id === modelRef),
      operatingPoints: catalog.operatingPoints.filter(point => modelRef === undefined || point.compatibleModelRefs.includes(modelRef)),
      automations: catalog.automations.filter(automation => modelRef === undefined || automation.compatibleModelRefs.includes(modelRef)),
      application: 'new-scenario-revision', liveModelReplacement: false }
  },
}]
