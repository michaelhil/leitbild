import { z } from 'zod'
import { embeddedViewPublicationSchema, engineeringCaptureInputSchema, engineeringContinuationCancelSchema, engineeringContinuationCancellationSchema, engineeringContinuationInspectSchema, engineeringContinuationReceiptSchema, engineeringContinuationSubmitSchema, engineeringInputBasisSchema, engineeringQualificationResultSchema, engineeringQualifyInputSchema, moduleIdSchema, type ModuleCapabilityInvocation } from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { simulationRunIdSchema } from '../model/ids.ts'
import { apiError, json } from './responses.ts'

const readRunId = (invocation: ModuleCapabilityInvocation) => {
  if (invocation.resource?.type !== 'world.simulation-run') throw new Error('Engineering requires a World Simulation Run')
  return simulationRunIdSchema.parse(invocation.resource.id)
}
const receiptWithView = engineeringContinuationReceiptSchema.extend({ view: embeddedViewPublicationSchema }).strict()
const view = (jobId: string) => ({ viewType: 'engineering.continuation', title: 'Engineering comparison', height: 650, state: JSON.stringify({ jobId }) })
const operations = [
  { name: 'inputs.capture', title: 'Capture engineering inputs', input: engineeringCaptureInputSchema, output: engineeringInputBasisSchema, command: false,
    description: 'Read finite typed quantities and their original model frame from a named open engineering research Run. Restricted, role-based, native and unqualified sources are refused. Preserve this result as the source of calculation inputs.' },
  { name: 'inputs.qualify', title: 'Check engineering input qualification', input: engineeringQualifyInputSchema, output: engineeringQualificationResultSchema, command: false,
    description: 'Recheck the original source epoch, profile and restrictions without acquiring new readings. Qualification does not refresh the original values or timestamp.' },
  { name: 'continuation.submit', title: 'Compare conditional plant continuations', input: engineeringContinuationSubmitSchema, output: receiptWithView, command: true,
    description: 'Capture the entire qualified research Run into a private bounded worker and compare an unchanged baseline with one timed owner-control alternative. Requires a submission key. New key with replayJobId reruns the pinned origin; without it captures current state. No action is applied to the source. Research-only; inspect reached time and refused commands.' },
  { name: 'continuation.inspect', title: 'Inspect engineering comparison', input: engineeringContinuationInspectSchema, output: receiptWithView, command: false,
    description: 'Read retained comparison status and a bounded per-case sample page. Rechecks the original source qualification. Poll this read-only capability; do not resubmit to check progress.' },
  { name: 'continuation.cancel', title: 'Cancel engineering comparison', input: engineeringContinuationCancelSchema, output: z.union([receiptWithView, engineeringContinuationCancellationSchema]), command: true,
    description: 'Stop the private worker, remove its scratch runtime, and retain bounded evidence already observed. Cancellation never changes the source Run.' },
] as const

export const engineeringCapabilities: ReadonlyArray<CapabilityRegistration<SimulationRunRegistry, Response>> = operations.map(operation => ({
  descriptor: {
    id: `world.engineering.${operation.name}`, moduleId: moduleIdSchema.parse('world'),
    scope: { kind: 'resource', resourceType: 'world.simulation-run' }, kind: operation.command ? 'command' : 'query',
    title: operation.title, description: operation.description, risk: operation.command ? 'write' : 'read',
    idempotent: operation.name !== 'continuation.submit',
    ...(operation.name === 'continuation.submit' ? { acceptsIdempotencyKey: true } : {}),
    ...(operation.name.startsWith('continuation.') ? { publishes: ['embedded-view' as const] } : {}),
    inputSchema: z.toJSONSchema(operation.input), outputSchema: z.toJSONSchema(operation.output),
  },
  invoke: async (registry, invocation) => {
    try {
      const id = readRunId(invocation), input = operation.input.parse(invocation.input)
      if (operation.name === 'inputs.capture') return json({ result: await registry.engineering.capture(id, input) })
      if (operation.name === 'inputs.qualify') return json({ result: await registry.engineering.qualify(id, input) })
      const receipt = operation.name === 'continuation.submit'
        ? await registry.engineering.submit(id, `${invocation.access.actor.kind}:${invocation.access.actor.id ?? 'shared'}`, invocation.idempotencyKey, input)
        : operation.name === 'continuation.inspect' ? await registry.engineering.inspect(id, input) : await registry.engineering.cancel(id, input)
      return json({ result: 'evidenceAvailable' in receipt ? engineeringContinuationCancellationSchema.parse(receipt) : receiptWithView.parse({ ...receipt, view: view(receipt.jobId) }) })
    } catch (error) {
      if (error instanceof Error && 'status' in error && 'code' in error && typeof error.status === 'number' && typeof error.code === 'string') return apiError(error.status, error.code, error.message)
      throw error
    }
  },
}))
