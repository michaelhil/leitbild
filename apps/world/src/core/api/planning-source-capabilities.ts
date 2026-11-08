import { z } from 'zod'
import {
  moduleIdSchema, planningOwnerBasisInputSchema, planningSourceBasisSchema,
  planningSourceQualificationResultSchema, planningSourceQualifyInputSchema,
  type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { simulationRunIdSchema } from '../model/ids.ts'
import { json } from './responses.ts'

const runId = (invocation: ModuleCapabilityInvocation) => {
  if (invocation.resource?.type !== 'world.simulation-run') throw new Error('Planning source requires a World Simulation Run')
  return simulationRunIdSchema.parse(invocation.resource.id)
}
export const planningSourceCapabilities: ReadonlyArray<CapabilityRegistration<SimulationRunRegistry, Response>> = [
  ...(['einsatz', 'process-plant'] as const).map(profile => ({
    descriptor: {
      id: `world.${profile}.planning-basis`, moduleId: moduleIdSchema.parse('world'),
      kind: 'query' as const, scope: { kind: 'resource' as const, resourceType: 'world.simulation-run' },
      title: `Capture ${profile} planning input`,
      description: 'Read bounded owner facts for a shared human/AI research Study. Open Runs only; rejects private/denied sources. Returned locators are opaque and can be supplied to refresh the same selection.',
      risk: 'read' as const, idempotent: true,
      inputSchema: z.toJSONSchema(planningOwnerBasisInputSchema), outputSchema: z.toJSONSchema(planningSourceBasisSchema),
    },
    invoke: async (registry: SimulationRunRegistry, invocation: ModuleCapabilityInvocation) => {
      const runtime = await registry.load(runId(invocation))
      return json({ result: await runtime.planningSource.capture(invocation.resource!, profile, invocation.input) })
    },
  })),
  {
    descriptor: {
      id: 'world.planning-source.qualify', moduleId: moduleIdSchema.parse('world'),
      kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Check retained planning input qualification',
      description: 'Permission/applicability only for the server-retained captured subject set. Returns no facts or current values; changed restrictions or unavailable subjects deny retained shared-audience presentation.',
      risk: 'read', idempotent: true,
      inputSchema: z.toJSONSchema(planningSourceQualifyInputSchema), outputSchema: z.toJSONSchema(planningSourceQualificationResultSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = registry.get(runId(invocation))
      if (!runtime) return json({ result: { allowed: false, code: 'source_unloaded', reason: 'Open the source Run in World before inspecting retained planning evidence' } })
      return json({ result: await runtime.planningSource.qualify(invocation.input) })
    },
  },
]
