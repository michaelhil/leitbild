import { moduleIdSchema, type ModuleCapabilityInvocation } from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { simulationRunIdSchema } from '../model/ids.ts'
import { guideInputs, presentationInputs, runGuideOperation, runPresentationOperation, type GuidanceCall } from '../guides/operations.ts'
import { guideReadingSchema, presentationOutputs } from '../guides/wire.ts'
import { buildSimulationRunActorForAccess } from './simulation-run-routes.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { json } from './responses.ts'

const moduleId = moduleIdSchema.parse('world')

const presentationDescriptions: Record<keyof typeof presentationInputs, { title: string; description: string; kind: 'query' | 'command' }> = {
  register: { title: 'Open browser presentation receiver', description: 'A person registers this exact Run document. Returns a short-lived delivery address, not a Resource grant or Agent configuration.', kind: 'command' },
  poll: { title: 'Read pending browser presentation', description: 'The registered person renews its document lease and reads independent pending actions. Another perspective or expired document is refused.', kind: 'command' },
  unregister: { title: 'Close browser presentation receiver', description: 'The registered person closes its own document delivery. No World state or accepted physical command is undone.', kind: 'command' },
  targets: { title: 'Discover presentation targets', description: 'Find exact inspectable objects, declared panels and controls. Optionally read one object\'s elements; no heavy renderer is started. Availability is resolved again on delivery.', kind: 'query' },
  request: { title: 'Offer attention to a person', description: 'Offer one focus, reveal, highlight, explanation or editable prompt suggestion to the initiating browser. A current recipient is required. Returns admission only; read result for actual delivery. Never sends a human message or changes physics.', kind: 'command' },
  result: { title: 'Read a presentation outcome', description: 'Read the retained actual per-action receipt for this browser offer. Applied is a presentation fact, not comprehension or physical response. Expired receipts are explicitly unavailable.', kind: 'query' },
  cancel: { title: 'Cancel owned attention', description: 'Cancel an agent\'s own request or a person\'s current browser request. Clears only its owned cues/suggestion; a previously opened view or accepted physical action is not rolled back.', kind: 'command' },
  receipt: { title: 'Record browser presentation receipt', description: 'A person\'s current document reports one action applied, declined or unavailable. The owner rechecks target access and preserves the first terminal outcome.', kind: 'command' },
}

const guideDescriptions: Record<keyof typeof guideInputs, { title: string; description: string; kind: 'query' | 'command' }> = {
  read: { title: 'Read current guide step', description: 'Read the guide pinned in this Run, or one opaque participant attempt. Returns only its current eligible step and permitted past evidence, never future script. This read sends no UI effects.', kind: 'query' },
  start: { title: 'Start an independent guide attempt', description: 'A person starts fresh learning progress for this Run\'s pinned guide and current perspective. Checks entry eligibility; never resets or replays the World.', kind: 'command' },
  show: { title: 'Show the current guide step', description: 'A person explicitly resumes/takes over an attempt and requests fresh presentation of its current step. Reissues presentation only, never physical commands or sent prompts.', kind: 'command' },
  advance: { title: 'Advance, skip or pause a guide', description: 'A person changes its current attempt using its expected progress revision. Next checks authored evidence; Skip stays skipped. Pause/Stop affects guidance, never the shared clock.', kind: 'command' },
  receipt: { title: 'Retain a guide delivery result', description: 'The current participant document records one exact current-step presentation receipt. Old step/document receipts cannot complete a new step or establish a World outcome.', kind: 'command' },
  prompt: { title: 'Link an actually submitted guide prompt', description: 'Record an actual human message hint for this step\'s offered prompt. World independently reads Agents\' Room-scoped published evidence; a draft insertion or browser claim cannot establish an Assistant answer.', kind: 'command' },
}

export const guidanceCapabilities = (): ReadonlyArray<CapabilityRegistration<SimulationRunRegistry, Response>> => {
  const registrations: Array<CapabilityRegistration<SimulationRunRegistry, Response>> = []
  const callOf = (registry: SimulationRunRegistry, invocation: ModuleCapabilityInvocation): GuidanceCall => {
    if (invocation.resource?.type !== 'world.simulation-run') throw new Error('Guidance requires a Simulation Run Resource')
    return { registry, runId: simulationRunIdSchema.parse(invocation.resource.id), actor: buildSimulationRunActorForAccess(invocation.access) }
  }
  for (const kind of Object.keys(presentationInputs) as Array<keyof typeof presentationInputs>) {
    const description = presentationDescriptions[kind]
    registrations.push({
      descriptor: {
        id: `world.simulation-run.presentation.${kind}`, moduleId, kind: description.kind,
        scope: { kind: 'resource', resourceType: 'world.simulation-run' }, title: description.title, description: description.description,
        searchTerms: ['attention', 'show location', 'highlight', 'explain', 'presentation'],
        risk: description.kind === 'query' ? 'read' : 'write', idempotent: description.kind === 'query',
        ...(kind === 'request' ? { publishes: ['presentation' as const] } : {}),
        ...(['request', 'result', 'cancel'].includes(kind) ? { acceptsPresentationRecipient: true as const } : {}),
        inputSchema: capabilityJsonSchema(presentationInputs[kind]), outputSchema: capabilityJsonSchema(presentationOutputs[kind]),
      },
      invoke: async (registry, invocation) => json({ result: presentationOutputs[kind].parse(await runPresentationOperation(kind, invocation.input, callOf(registry, invocation))) }),
    })
  }
  for (const kind of Object.keys(guideInputs) as Array<keyof typeof guideInputs>) {
    const description = guideDescriptions[kind]
    registrations.push({
      descriptor: {
        id: `world.simulation-run.guide.${kind}`, moduleId, kind: description.kind,
        scope: { kind: 'resource', resourceType: 'world.simulation-run' }, title: description.title, description: description.description,
        searchTerms: ['tutorial', 'guide', 'learn', 'instruction'], risk: description.kind === 'query' ? 'read' : 'write', idempotent: description.kind === 'query',
        inputSchema: capabilityJsonSchema(guideInputs[kind]), outputSchema: capabilityJsonSchema(guideReadingSchema),
      },
      invoke: async (registry, invocation) => json({ result: guideReadingSchema.parse(await runGuideOperation(kind, invocation.input, callOf(registry, invocation))) }),
    })
  }
  return registrations
}
