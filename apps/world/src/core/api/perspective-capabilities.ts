import { z } from 'zod'
import {
  moduleIdSchema, moduleResourceDescriptorSchema, perspectiveAdmissionSchema, perspectiveDiscoverySchema,
  perspectivePrepareInputSchema, perspectiveReadInputSchema, perspectiveBindInputSchema, perspectiveRevokeInputSchema,
  perspectivePresentationVerificationSchema, worldPerspectiveReferenceSchema, publishedContextSchema,
  type ModuleCapabilityDescriptor, type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry, type CapabilityRegistration } from '@leitbild/module-runtime'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { objectIdSchema, operationalObjectSchema, simulationRunIdSchema, observableRefSchema, refObjectId } from '../model/index.ts'
import { observationSchema } from '../observation/model.ts'
import { perspectiveFailure } from '../perspectives/model.ts'
import type { AdmittedPerspective } from '../perspectives/service.ts'
import { presentationInputs, runPresentationOperation, type PresentationOperationScope } from '../guides/operations.ts'
import { presentationOutputs } from '../guides/wire.ts'
import { observablesSearchInputSchema, observablesSearchOutputSchema, searchObservables } from '../../features/displays/observation/search.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { json } from './responses.ts'

const moduleId = moduleIdSchema.parse('world')
const empty = z.object({}).strict()
const heldRoles = perspectivePrepareInputSchema.shape.roleIds
const listInput = z.object({ text: z.string().max(200).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict()
const listOutput = z.object({ total: z.number().int().nonnegative(), objects: z.array(operationalObjectSchema.pick({ id: true, packId: true, kind: true, label: true, operational: true })), nextOffset: z.number().int().optional() }).strict()
const readInput = z.object({ objectId: objectIdSchema }).strict()
const observationInput = z.object({ refs: z.array(observableRefSchema).min(1).max(256) }).strict()
const observationOutput = z.object({ observations: z.array(observationSchema), unknown: z.array(z.string()), refused: z.array(z.object({ objectId: objectIdSchema, refused: z.object({ code: z.string(), message: z.string() }).strict() }).strict()), leads: z.array(z.array(z.string())) }).strict()
const actions = new Set(['focus', 'reveal', 'highlight', 'explain', 'clear'])
const attentionAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus'), zoom: z.number().finite().min(0).max(24).optional() }).strict(),
  z.object({ kind: z.literal('reveal') }).strict(), z.object({ kind: z.literal('highlight') }).strict(),
  z.object({ kind: z.literal('explain'), title: z.string().min(1).max(120), text: z.string().min(1).max(2_000) }).strict(),
])
export const perspectivePresentationInputs = {
  register: presentationInputs.register.extend({ roleIds: heldRoles }),
  poll: presentationInputs.poll.extend({ roleIds: heldRoles }),
  receipt: presentationInputs.receipt.extend({ roleIds: heldRoles }),
  unregister: presentationInputs.unregister.extend({ roleIds: heldRoles }),
  targets: presentationInputs.targets,
  request: presentationInputs.request.extend({ action: attentionAction }),
  result: presentationInputs.result,
  cancel: presentationInputs.cancel,
  verify: presentationInputs.poll,
} as const

const serviceOf = (registry: SimulationRunRegistry) => registry.perspectives ?? (() => { throw perspectiveFailure('perspective_pilot_disabled', 'Perspective construction is not enabled in this World instance', 404) })()
const perspectiveId = (invocation: ModuleCapabilityInvocation): string => worldPerspectiveReferenceSchema.parse(invocation.resource).id
const inspectable = (context: AdmittedPerspective, objectIds: ReadonlyArray<string>): void => {
  const policy = context.runtime.inspectionPolicy(context.actor)
  if (objectIds.some(id => !policy.canInspect(id))) throw perspectiveFailure('perspective_target_unavailable', 'The requested target is not available in this Perspective')
}
const scopeOf = (context: AdmittedPerspective): PresentationOperationScope => {
  const origin = context.access.perspectiveOrigin, binding = context.record.admission.binding
  return { subject: context.record.admission.resource, actions, current: context.current,
    ...(origin?.kind !== 'execution' || binding === undefined ? {} : { source: {
      kind: 'agent' as const, id: binding.actualAgentId, label: context.actor.displayName ?? context.actor.label,
      executionId: origin.turnId, initiatingRoom: binding.room,
    } }),
  }
}

const registrations: Array<CapabilityRegistration<SimulationRunRegistry, Response>> = []
const add = (operation: string, input: z.ZodType, output: z.ZodType, title: string, description: string,
  invoke: CapabilityRegistration<SimulationRunRegistry, Response>['invoke'], options: { kind?: 'query' | 'command'; run?: boolean; presentation?: boolean; recipient?: boolean; context?: boolean } = {}) => {
  const kind = options.kind ?? 'query'
  registrations.push({ descriptor: {
    id: `world.perspective.${operation}`, moduleId, kind,
    scope: { kind: 'resource', resourceType: options.run ? 'world.simulation-run' : 'world.perspective' },
    title, description, risk: kind === 'query' ? 'read' : 'write', idempotent: kind === 'query',
    ...(options.presentation ? { publishes: ['presentation' as const] } : options.context ? { publishes: ['context' as const] } : {}),
    ...(options.recipient ? { acceptsPresentationRecipient: true as const } : {}),
    inputSchema: capabilityJsonSchema(input), outputSchema: capabilityJsonSchema(output),
  }, invoke: async (registry, invocation) => { input.parse(invocation.input); return invoke(registry, invocation) } })
}
add('prepare', perspectivePrepareInputSchema, perspectiveAdmissionSchema, 'Prepare a held-role Perspective', 'A human prepares one pending, non-callable admission from the screen’s held roles. The causal request identity supports read-back; it creates neither a Room nor an execution grant.', async (registry, invocation) => {
  if (invocation.resource?.type !== 'world.simulation-run') throw perspectiveFailure('perspective_run_required', 'Prepare requires the exact Run Resource', 400)
  return json({ result: await serviceOf(registry).prepare(simulationRunIdSchema.parse(invocation.resource.id), perspectivePrepareInputSchema.parse(invocation.input), invocation.access) })
}, { kind: 'command', run: true })
add('read', perspectiveReadInputSchema, perspectiveAdmissionSchema, 'Read a private Perspective admission', 'Held-role human management or narrow owner verification only. Returns current World lifecycle without enumerating private Rooms. This operation is not model discovery.', async (registry, invocation) => json({ result: await serviceOf(registry).read(perspectiveId(invocation), invocation.access, perspectiveReadInputSchema.parse(invocation.input).roleIds) }))
add('bind', perspectiveBindInputSchema, perspectiveAdmissionSchema, 'Bind the verified scoped runtime', 'Internal Host bootstrap verifies the actual prepared Agents Room/runtime outside the World write lock, then CAS-activates one immutable relationship. Neither half alone is callable.', async (registry, invocation) => json({ result: await serviceOf(registry).bind(perspectiveId(invocation), perspectiveBindInputSchema.parse(invocation.input), invocation.access) }), { kind: 'command' })
add('revoke', perspectiveRevokeInputSchema, perspectiveAdmissionSchema, 'End a Perspective admission', 'Held-role human or narrow owner revocation ends this admission and its owned attention. It never rebinds a context, changes physics or rolls back accepted operations.', async (registry, invocation) => {
  const input = perspectiveRevokeInputSchema.parse(invocation.input)
  return json({ result: await serviceOf(registry).revoke(perspectiveId(invocation), { expectedRevision: input.expectedRevision, reason: input.reason, ...(input.roleIds === undefined ? {} : { roleIds: input.roleIds }) }, invocation.access) })
}, { kind: 'command' })

const modelOperations = new Set(['discovery.read', 'context.read', 'objects.list', 'objects.read', 'observations.search', 'observations.read', 'presentation.targets', 'presentation.request', 'presentation.result', 'presentation.cancel'])
export const perspectiveReadCapabilityDescriptors = (): ReadonlyArray<ModuleCapabilityDescriptor> => perspectiveCapabilityRegistry.descriptors.filter(descriptor => modelOperations.has(descriptor.id.slice('world.perspective.'.length)))

add('discovery.read', empty, perspectiveDiscoverySchema, 'Discover this exact private Perspective', 'Returns only this known Perspective and its narrow read/attention operations to its actual bound execution. No global Resource, Definition, private Room directory or canonical Run subject is returned.', async (registry, invocation) => json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
  const capabilities = perspectiveReadCapabilityDescriptors()
  const resource = moduleResourceDescriptorSchema.parse({ ref: context.record.admission.resource, title: 'Scoped World perspective', description: 'One owner-admitted held-role read and attention compartment.', links: [], capabilityIds: capabilities.map(descriptor => descriptor.id), observedAt: new Date().toISOString() })
  return { resource, capabilities }
}) }))
add('context.read', empty, publishedContextSchema, 'Read permitted current situation context', 'Bounded current object summaries from this exact held-role picture. It includes no future Scenario/Guide source, canonical Run link or another compartment’s evidence.', async (registry, invocation) => json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
  const snapshot = context.runtime.snapshot(), policy = context.runtime.inspectionPolicy(context.actor)
  if (snapshot.clock === undefined) throw perspectiveFailure('perspective_state_unavailable', 'The current simulation clock is unavailable', 409)
  const visible = snapshot.objects.filter(object => policy.canInspect(object.id))
  const text = [`Current permitted picture: ${visible.length} objects.`, ...visible.slice(0, 40).map(object => `${object.id} · ${object.label} · ${object.operational.status}`), ...(visible.length > 40 ? ['Use objects.list for the remaining permitted objects.'] : [])].join('\n').slice(0, 8_000)
  return { context: { text, at: snapshot.clock.currentTime, clock: 'simulation' } }
}) }), { context: true })
add('objects.list', listInput, listOutput, 'List permitted object summaries', 'Filter before matching, totals and pagination. Retrieves compact current summaries without Pack-private source or generated displays.', async (registry, invocation) => {
  const input = listInput.parse(invocation.input)
  return json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
    const policy = context.runtime.inspectionPolicy(context.actor)
    const found = context.runtime.snapshot().objects.filter(object => policy.canInspect(object.id) && (input.text === undefined || `${object.id} ${object.label}`.toLowerCase().includes(input.text.toLowerCase())))
    return { total: found.length, objects: found.slice(input.offset, input.offset + input.limit).map(({ id, packId, kind, label, operational }) => ({ id, packId, kind, label, operational })), ...(found.length > input.offset + input.limit ? { nextOffset: input.offset + input.limit } : {}) }
  }) })
})
add('objects.read', readInput, operationalObjectSchema, 'Read one permitted current object', 'Read an exact owner object only when its audience and declared reference closure permit it. Unknown and inaccessible targets receive the same bounded refusal.', async (registry, invocation) => {
  const input = readInput.parse(invocation.input)
  return json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
    inspectable(context, [input.objectId])
    return context.runtime.snapshot().objects.find(object => object.id === input.objectId) ?? (() => { throw perspectiveFailure('perspective_target_unavailable', 'The requested target is not available in this Perspective') })()
  }) })
})
add('observations.search', observablesSearchInputSchema, observablesSearchOutputSchema, 'Discover permitted observable identities', 'Search the current permitted owners through their declared observation port. No arbitrary runtime operation proxy or hidden-owner completion hints.', async (registry, invocation) => {
  const input = observablesSearchInputSchema.parse(invocation.input)
  return json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
    inspectable(context, input.queries.flatMap(query => query.objectId === undefined ? [] : [query.objectId]))
    const policy = context.runtime.inspectionPolicy(context.actor)
    const objects = context.runtime.snapshot().objects.filter(object => policy.canInspect(object.id))
    return { results: await searchObservables({ objects, denied: new Set(), packs: context.runtime.packs(), port: context.runtime.observations(context.actor) }, input.queries) }
  }) })
})
add('observations.read', observationInput, observationOutput, 'Read exact permitted observations', 'Read exact discovered refs with their actual time, quality and units. Mixed inaccessible targets refuse before acquisition; suspended work rechecks the admission and current picture.', async (registry, invocation) => {
  const input = observationInput.parse(invocation.input)
  return json({ result: await serviceOf(registry).withExecution(perspectiveId(invocation), invocation.access, async context => {
    inspectable(context, input.refs.map(refObjectId))
    return context.runtime.observations(context.actor).read({ refs: input.refs })
  }) })
})

for (const kind of Object.keys(perspectivePresentationInputs) as Array<keyof typeof perspectivePresentationInputs>) {
  const inputSchema = perspectivePresentationInputs[kind], outputSchema = kind === 'verify' ? perspectivePresentationVerificationSchema : presentationOutputs[kind]
  const human = ['register', 'poll', 'receipt', 'unregister'].includes(kind)
  const query = ['targets', 'result', 'verify'].includes(kind)
  add(`presentation.${kind}`, inputSchema, outputSchema, `Perspective attention: ${kind}`, kind === 'verify'
    ? 'Narrow Host owner port: verifies exact current Perspective/document lease, held roles and fresh actual Agents binding. It returns no authority from a plain Resource ID.'
    : 'Use the shared World attention delivery with this exact Perspective subject. Human receiver operations require held roles. Agent requests are attributed suggestions; drafts and World commands are unsupported.', async (registry, invocation) => {
    const service = serviceOf(registry), id = perspectiveId(invocation), input = inputSchema.parse(invocation.input)
    const work = async (context: AdmittedPerspective) => {
      if (kind === 'verify') {
        const recipient = registry.presentation.current(perspectivePresentationInputs.verify.parse(input).recipient)
        if (JSON.stringify(recipient.subject) !== JSON.stringify(context.record.admission.resource)
          || JSON.stringify([...registry.presentation.roleIds(recipient)].sort()) !== JSON.stringify([...context.record.roleIds].sort())) throw perspectiveFailure('perspective_receiver_mismatch', 'The current browser lease does not belong to this admitted picture')
        return { admission: context.record.admission, binding: context.record.admission.binding!, recipient }
      }
      const { roleIds: _roles, ...body } = input as Record<string, unknown>
      return runPresentationOperation(kind, body, { registry, runId: context.record.runId, actor: context.actor }, scopeOf(context))
    }
    const result = kind === 'verify' ? await service.withOwner(id, invocation.access, work)
      : human ? await service.withHuman(id, heldRoles.parse((input as { roleIds?: unknown }).roleIds), invocation.access, work)
      : await service.withExecution(id, invocation.access, work)
    return json({ result: outputSchema.parse(result) })
  }, { kind: query ? 'query' : 'command', ...(kind === 'request' ? { presentation: true } : {}), ...(['request', 'result', 'cancel'].includes(kind) ? { recipient: true } : {}) })
}

export const perspectiveCapabilityRegistry = createModuleCapabilityRegistry(moduleId, registrations)
export const perspectiveCapabilityDescriptors = (registry: SimulationRunRegistry): ReadonlyArray<ModuleCapabilityDescriptor> => registry.perspectives === undefined ? [] : perspectiveCapabilityRegistry.descriptors
