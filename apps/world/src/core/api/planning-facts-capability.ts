import { z } from 'zod'
import { moduleIdSchema, planningFactsInputSchema, planningFactsOutputSchema, type ModuleCapabilityInvocation } from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { isPlanningFactsRefusal } from '../simulation-runs/planning-facts.ts'
import { simulationRunIdSchema } from '../model/ids.ts'
import { apiError, json } from './responses.ts'

const runId = (invocation: ModuleCapabilityInvocation) => {
  if (invocation.resource?.type !== 'world.simulation-run') throw new Error('Planning facts are read from a World Simulation Run')
  return simulationRunIdSchema.parse(invocation.resource.id)
}

export const planningFactsCapability: CapabilityRegistration<SimulationRunRegistry, Response> = {
  descriptor: {
    id: 'world.simulation-run.planning-facts', moduleId: moduleIdSchema.parse('world'),
    kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
    title: 'Find equipment, crews and vehicles for a plan',
    description: 'Find the equipment, crews, vehicles and other items a simulation holds, with their current values, to use in a plan. Search by words or kind for a short list with live state, then ask for exact items, up to 32 read together, for all their values. Each value carries its unit, how it is known (design, configured, observed or the owner\'s estimate) and the simulation time it describes. Reading never pauses or changes the simulation. Simulations with roles are not read.',
    searchTerms: ['equipment', 'pump', 'crew', 'vehicle', 'truck', 'asset', 'find', 'availability', 'estimate', 'planning', 'state'],
    risk: 'read', idempotent: true,
    inputSchema: z.toJSONSchema(planningFactsInputSchema, { io: 'input' }), outputSchema: z.toJSONSchema(planningFactsOutputSchema),
  },
  invoke: async (registry, invocation) => {
    // A Run loads only when someone asks for its facts.
    const runtime = await registry.load(runId(invocation))
    try {
      return json({ result: await runtime.planningFacts.read(invocation.resource!, invocation.input) })
    } catch (error) {
      if (isPlanningFactsRefusal(error)) return apiError(error.status, error.code, error.message, error.details)
      throw error
    }
  },
}
