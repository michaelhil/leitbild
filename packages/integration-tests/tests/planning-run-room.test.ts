// A Run's plan from the Assistant Room beside that Run, with no model: the real Host, World, Agents and
// Planning Modules, and the Agents workspace tools called as an Assistant's turn calls them. Each Room here has
// the Scope the Host gives the ordinary Ask beside a Run (App.svelte openRunAssistantRoom): the Run's family
// with every member, or one member selected in the Room's scope controls (RunRoomControls.svelte).
//
// The cases share one stack and one Workspace and run in file order; the maintenance cases continue on the
// Run and plan the first one makes. Every search and call is made one at a time.
import { afterAll, expect, test } from 'bun:test'
import {
  ABOUT_RELATION, workspaceResourceCatalogSchema, workspaceRoomScopeSchema,
  type WorkspaceResourceReference, type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from '../../../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { runFamilyFor } from '../../../apps/leitbild/src/ui/run-room-scope.ts'
import { inputsDigest } from '../../../apps/planning/src/plan/store.ts'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack({ realAgents: true })
afterAll(() => stack.close())
const { workspaceId } = stack
const TIMEOUT_MS = 120_000

type Target = { readonly kind: 'resource' | 'definition'; readonly ref: { readonly workspaceId: string; readonly moduleId: string; readonly type: string; readonly id: string; readonly revisionId?: string } }
interface Listed { readonly target: Target; readonly links?: ReadonlyArray<{ readonly rel: string; readonly ref: unknown }> }
interface Listing { readonly scope: WorkspaceRoomScope; readonly definitions: ReadonlyArray<Listed>; readonly resources: ReadonlyArray<Listed>; readonly unavailableOperationIds?: ReadonlyArray<string> }
interface CallResult { readonly success: boolean; readonly data?: any; readonly error?: string; readonly details?: { readonly code?: string }; readonly embeddedView?: unknown; readonly viewRef?: string }

const scopes = new Map<string, WorkspaceRoomScope>()
const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: stack.hostUrl, getRoomScope: roomId => scopes.get(roomId) })
const tool = (name: string) => tools.find(entry => entry.name === name)!

/** A Room with this Scope, and the two workspace tools as its Assistant calls them. */
const roomWith = (roomId: string, scope: WorkspaceRoomScope) => {
  scopes.set(roomId, workspaceRoomScopeSchema.parse(scope))
  const context = { callerId: `assistant-${roomId}`, callerName: 'Assistant', roomId, executionCallId: 'call_1_1' }
  const explore = async (params: Record<string, unknown>): Promise<Listing> => {
    const answer = await tool('workspace_explore').execute(params, context)
    if (!answer.success) throw new Error(`workspace_explore failed: ${answer.error}`)
    return answer.data as Listing
  }
  return {
    scope,
    /** Every Definition and Resource the Room's Scope holds. */
    listed: () => explore({ view: 'scope' }),
    /** Which of these exact operations the Room cannot reach. */
    unavailable: async (operationIds: ReadonlyArray<string>) => (await explore({ view: 'operations', operationIds })).unavailableOperationIds ?? [],
    /** One workspace_call; without a target the tool resolves the only eligible one, as it does for a model. */
    call: async (operationId: string, input: unknown, extra: { readonly target?: Target; readonly expectedRevision?: number } = {}): Promise<CallResult> => {
      const answer = await tool('workspace_call').execute({ calls: [{ key: 'c', operationId, input, ...extra }] }, context)
      if (!answer.success) throw new Error(`workspace_call failed: ${answer.error}`)
      return (answer.data as { results: CallResult[] }).results[0]!
    },
  }
}
type Room = ReturnType<typeof roomWith>

const runReference = (id: string) => ({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id }) as WorkspaceResourceReference
const planTarget = (id: string): Target => ({ kind: 'resource', ref: { workspaceId, moduleId: 'planning', type: 'planning.plan', id } })

/** The family World publishes for a Run, read from the Host's Resource catalogue as the Host UI reads it. */
const familyOf = async (runId: string): Promise<WorkspaceResourceReference> => {
  const catalogue = workspaceResourceCatalogSchema.parse(await (await fetch(`${stack.hostUrl}/api/workspaces/${workspaceId}/resources`)).json())
  const run = catalogue.resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === runId)
  const family = run === undefined ? undefined : runFamilyFor(run)
  if (family === undefined) throw new Error(`World publishes no family for Run ${runId}`)
  return family
}
/** The Room the Host opens for Ask beside a Run: the Run's family, every member. */
const familyRoom = async (roomId: string, runId: string): Promise<Room> =>
  roomWith(roomId, { kind: 'collection', collection: await familyOf(runId), members: { mode: 'all', except: [] } })

const planDefinitions = (listing: Listing) => listing.definitions.filter(definition => definition.target.ref.type === 'planning.plan-definition')
const plans = (listing: Listing) => listing.resources.filter(resource => resource.target.ref.type === 'planning.plan')
/** Each listed plan with the Run it is about. */
const byPlan = <Entry extends { readonly target: Target }>(entries: ReadonlyArray<Entry>) => entries.toSorted((left, right) => left.target.ref.id.localeCompare(right.target.ref.id))
const plansAbout = (listing: Listing) => byPlan(plans(listing).map(plan => ({ target: plan.target, links: plan.links })))
const aboutRun = (planId: string, runId: string) => ({ target: planTarget(planId), links: [{ rel: ABOUT_RELATION, ref: runReference(runId) }] })

/** A person's own action on a Run through Host, outside any Room. */
const invokeOnRun = async (operationId: string, runId: string, input: unknown): Promise<any> => {
  const response = await fetch(`${stack.hostUrl}/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: runReference(runId), input }),
  })
  if (!response.ok) throw new Error(`${operationId} returned ${response.status}: ${await response.text()}`)
  return (await response.json() as { result: unknown }).result
}

const dueBy = (label: string, key: string, finishBy: string, words: string) => ({
  label, buy: ['extra-maintenance-crew'], also: [{ kind: 'due', key, job: 'restore', finishBy, words, source: { by: 'assumption' } }],
})

// What the maintenance cases share: set by the first, used by the ones after it.
let runId = ''
let room: Room
let planId = ''
let revision = 0
// The what-if copy, the Room scoped to it alone and its plan: set by the copy case, used by the one after it.
let copyId = ''
let copyRoom: Room
let copyPlanId = ''

test('beside a fresh maintenance Run the guided plan Definition is in scope, and creating through the tools returns that Run\'s plan', async () => {
  runId = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  room = await familyRoom('room-maintenance', runId)

  const before = await room.listed()
  expect(before.scope).toEqual(room.scope)
  // The Run's own Scenario, and the one plan Definition that is about it: no other plan Definition.
  expect(before.definitions.map(definition => `${definition.target.ref.type}/${definition.target.ref.id}`).toSorted()).toEqual([
    'planning.plan-definition/nuclear-maintenance-planning', 'world.scenario/nuclear-maintenance-planning',
  ])
  const definition = planDefinitions(before)[0]!
  expect(definition.links).toEqual([{ rel: ABOUT_RELATION, ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'nuclear-maintenance-planning' } }])
  expect(before.resources.map(resource => resource.target.ref.type).toSorted()).toEqual(['world.run-family', 'world.simulation-run'])
  expect(await room.unavailable(['planning.plan.create'])).toEqual([])

  const created = await room.call('planning.plan.create', { demoRun: runId }, { target: definition.target })
  expect(created.error).toBeUndefined()
  expect(created.success).toBe(true)
  planId = created.data.plan.id
  revision = created.data.plan.revision
  expect(created.data.target).toEqual(planTarget(planId))
  expect(created.data.changed).toEqual(['Opened the linked plan with its World values'])
  expect((await stack.store.read(workspaceId, planId)).inputs.settings.run?.id).toBe(runId)

  // The plan now belongs with its Run in the Room.
  expect(plansAbout(await room.listed())).toEqual([aboutRun(planId, runId)])
}, TIMEOUT_MS)

test('in that Room the plan is read, a deadline what-if generated, explained and displayed as a view about the plan', async () => {
  const plan = planTarget(planId)
  const read = await room.call('planning.plan.read', {}, { target: plan })
  expect(read.error).toBeUndefined()
  const summary = read.data.sections[0].data
  expect(summary.plan).toMatchObject({ id: planId, revision })
  expect(summary.settings.run).toMatchObject({ id: runId })
  expect(summary.refreshedAt).not.toBeNull()

  const generated = await room.call('planning.plan.generate', { keep: true, variants: [
    dueBy('Contractor by Wed20', 'by-wed20', '2026-11-18T19:00:00Z', 'Requested by Wednesday 20:00'),
    dueBy('Contractor by Wed19', 'by-wed19', '2026-11-18T18:00:00Z', 'Requested by Wednesday 19:00'),
  ] }, { target: plan, expectedRevision: revision })
  expect(generated.error).toBeUndefined()
  const options: Array<{ key: string; label: string; status: { word: string } }> = generated.data.options
  expect(options.map(option => [option.label, option.status.word])).toEqual([
    ['Contractor by Wed20', 'validated feasible'], ['Contractor by Wed19', 'proven infeasible'],
  ])
  const wed20 = options[0]!, wed19 = options[1]!

  const finish = await room.call('planning.plan.explain', { ask: 'finish', option: wed20.key }, { target: plan })
  expect(finish.error).toBeUndefined()
  expect(finish.data.items.length).toBeGreaterThan(0)
  const refusal = await room.call('planning.plan.explain', { ask: 'refusal', option: wed19.key }, { target: plan })
  expect(refusal.error).toBeUndefined()
  expect(refusal.data.lines.join(' ')).toContain('Not possible')

  for (const [option, finishBy] of [[wed20, '2026-11-18T19:00:00Z'], [wed19, '2026-11-18T18:00:00Z']] as const) {
    const display = await room.call('planning.plan.display', { option: option.key }, { target: plan })
    expect(display.error).toBeUndefined()
    expect(display.data.schedule.deadline).toEqual({ job: 'restore', finishBy })
    expect(display.data.schedule.option).toMatchObject({ key: option.key, fresh: true, status: { word: option.status.word } })
    // The view the Assistant presents by reference: Planning's schedule view, its subject the plan itself.
    expect(display.embeddedView).toMatchObject({ viewType: 'planning.schedule', moduleId: 'planning', subject: plan.ref })
    expect(JSON.parse(display.data.view.state)).toMatchObject({ plan: planId, option: option.key })
    expect(display.viewRef).toBe('call_1_1/c')
    if (option === wed20) expect(display.data.schedule.option.finish).toBe(new Date(finishBy).toISOString())
  }
  // A what-if changes no authored input.
  expect((await stack.store.read(workspaceId, planId)).revision).toBe(revision)
}, TIMEOUT_MS)

test('opening the same Run again returns the same plan at the same revision, recording only the open', async () => {
  const before = await stack.store.read(workspaceId, planId)
  // No target: the one plan Definition in scope is the only eligible one, although the plan exists now.
  const reopened = await room.call('planning.plan.create', { demoRun: runId })
  expect(reopened.error).toBeUndefined()
  expect(reopened.data.plan).toMatchObject({ id: planId, revision })
  expect(reopened.data.target).toEqual(planTarget(planId))

  // The maintenance plan reads World again on every open (operations.ts openGuidedDemo): unchanged values keep
  // the revision and the generated options, and the open itself is one history entry with a new updatedAt.
  const after = await stack.store.read(workspaceId, planId)
  expect(after.revision).toBe(before.revision)
  expect(inputsDigest(after.inputs)).toBe(inputsDigest(before.inputs))
  expect(after.options).toEqual(before.options)
  expect(after.changes).toHaveLength(before.changes.length + 1)
  expect(after.changes.slice(0, -1)).toEqual(before.changes)
  expect(after.changes.at(-1)).toMatchObject({ revision: before.revision, summary: 'Read World values when reopening the maintenance plan', kinds: ['refresh'], by: { kind: 'agent' }, at: after.updatedAt })
  expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt))
  expect(plansAbout(await room.listed())).toEqual([aboutRun(planId, runId)])
}, TIMEOUT_MS)

test('planning.sources.refresh is not offered beside a Run and is refused there as out of scope', async () => {
  const before = await stack.store.read(workspaceId, planId)
  expect(await room.unavailable(['planning.sources.refresh'])).toEqual(['planning.sources.refresh'])
  const refused = await room.call('planning.sources.refresh', { plan: planId }, { expectedRevision: revision })
  expect(refused.success).toBe(false)
  expect(refused.details?.code).toBe('workspace_operation_out_of_scope')
  expect(refused.error).toStartWith('workspace_operation_out_of_scope: ')
  expect(await stack.store.read(workspaceId, planId)).toEqual(before)
}, TIMEOUT_MS)

test('a what-if copy gets its own plan, and a Room scoped to the copy alone neither lists nor reaches the original Run\'s plan', async () => {
  copyId = (await invokeOnRun('world.simulation-run.copy', runId, { name: 'Maintenance · what-if' }) as { id: string }).id
  expect(await familyOf(copyId)).toEqual(await familyOf(runId))
  // One member selected, as the Room's scope controls build it.
  copyRoom = roomWith('room-copy', { kind: 'collection', collection: await familyOf(copyId), members: { mode: 'selected', only: [runReference(copyId)] } })

  const before = await copyRoom.listed()
  expect(planDefinitions(before).map(definition => definition.target.ref.id)).toEqual(['nuclear-maintenance-planning'])
  expect(plans(before)).toEqual([])

  const created = await copyRoom.call('planning.plan.create', { demoRun: copyId })
  expect(created.error).toBeUndefined()
  copyPlanId = created.data.plan.id
  expect(copyPlanId).not.toBe(planId)
  expect(created.data.target).toEqual(planTarget(copyPlanId))
  expect((await stack.store.read(workspaceId, copyPlanId)).inputs.settings.run?.id).toBe(copyId)

  // Beside the copy alone: the copy's plan, not the original's.
  const after = await copyRoom.listed()
  expect(plansAbout(after)).toEqual([aboutRun(copyPlanId, copyId)])
  expect(after.resources.filter(resource => resource.target.ref.type === 'world.simulation-run').map(resource => resource.target.ref.id)).toEqual([copyId])
  for (const operationId of ['planning.plan.read', 'planning.plan.generate']) {
    const refused = await copyRoom.call(operationId, {}, { target: planTarget(planId) })
    expect(refused.success).toBe(false)
    expect(refused.details?.code).toBe('target_out_of_scope')
    expect(refused.error).toStartWith('target_out_of_scope: ')
  }
  expect((await copyRoom.call('planning.plan.read', {})).data.sections[0].data.plan.id).toBe(copyPlanId)

  // The family Room holds both Runs and so both plans, each about its own Run: there a plan call names its plan.
  expect(plansAbout(await room.listed())).toEqual(byPlan([aboutRun(planId, runId), aboutRun(copyPlanId, copyId)]))
  expect((await room.call('planning.plan.read', {})).details?.code).toBe('target_required')
  expect((await room.call('planning.plan.read', {}, { target: planTarget(planId) })).data.sections[0].data.plan.id).toBe(planId)
}, TIMEOUT_MS)

test('a Room scoped to the copy alone cannot name another Run in a call\'s input: neither to open its plan nor to link a plan to it', async () => {
  // A maintenance Run of another family, with no plan yet.
  const strangerId = await stack.start('world.scenario', 'nuclear-maintenance-planning', 'world.scenario.start')
  expect(await familyOf(strangerId)).not.toEqual(await familyOf(copyId))
  const definition = planDefinitions(await copyRoom.listed())[0]!.target
  const stored = async () => ({
    ids: (await stack.store.list(workspaceId)).plans.map(plan => plan.id).toSorted(),
    original: await stack.store.read(workspaceId, planId), copy: await stack.store.read(workspaceId, copyPlanId),
  })
  const before = await stored()
  const refusedAt = (place: string, refused: CallResult) => {
    expect(refused.success).toBe(false)
    expect(refused.details?.code).toBe('input_out_of_scope')
    expect(refused.error).toBe(`input_out_of_scope: Input ${place} names a Resource outside the current Room Scope`)
    expect(refused.data).toBeUndefined()
  }

  // Opening: the plan Definition is in scope, the Run named in the input is not.
  for (const outside of [runId, strangerId]) {
    refusedAt('demoRun', await copyRoom.call('planning.plan.create', { demoRun: outside }, { target: definition }))
    refusedAt('demoRun', await copyRoom.call('planning.plan.create', { demoRun: outside }))
  }
  // Linking: the copy's plan is in scope, the Run it would be linked to is not.
  const copyPlan = planTarget(copyPlanId)
  for (const outside of [runId, strangerId]) {
    refusedAt('edits[0].run', await copyRoom.call('planning.plan.edit', { edits: [{ edit: 'plan', run: outside }] }, { target: copyPlan, expectedRevision: before.copy.revision }))
    refusedAt('edits[1].run', await copyRoom.call('planning.plan.edit', { preview: true, edits: [{ edit: 'plan', title: 'What-if' }, { edit: 'plan', run: outside }] }, { target: copyPlan, expectedRevision: before.copy.revision }))
  }
  expect(await stored()).toEqual(before)

  // What the Scope allows is the Module's to decide. Shown as previews, which save nothing: the Run the Room
  // is beside, no Run at all, and, from the family Room, the other Run of the family.
  for (const [from, run] of [[copyRoom, copyId], [copyRoom, null], [room, runId], [room, null]] as const) {
    const preview = await from.call('planning.plan.edit', { preview: true, edits: [{ edit: 'plan', run }] }, { target: copyPlan, expectedRevision: before.copy.revision })
    expect(preview.details?.code).not.toBe('input_out_of_scope')
    expect(preview.error).toBeUndefined()
    expect(preview.data.preview.saved).toBe(false)
  }
  // The family Room holds the original Run, so it may open that Run's plan; the stranger stays outside it too.
  refusedAt('demoRun', await room.call('planning.plan.create', { demoRun: strangerId }))
  expect(await stored()).toEqual(before)

  // The legitimate open beside the copy still returns the copy's plan.
  const reopened = await copyRoom.call('planning.plan.create', { demoRun: copyId })
  expect(reopened.error).toBeUndefined()
  expect(reopened.data.plan).toMatchObject({ id: copyPlanId, revision: before.copy.revision })
  expect((await stored()).ids).toEqual(before.ids)
  expect(await stack.store.read(workspaceId, planId)).toEqual(before.original)
}, TIMEOUT_MS)

test('an open refused for a stopped backup pump returns the refusal and leaves the plan exactly as it was', async () => {
  await invokeOnRun('world.process-plant.control.write', runId, { plantId: 'plant:maintenance', path: 'componentCoolingWaterPumpB.running', value: false })
  await invokeOnRun('world.simulation-run.execution.advance', runId, { minutes: 1 / 60, onComplete: 'pause' })
  // World's step lands a moment after the advance is accepted: wait until its own facts say the pump stopped.
  for (let attempt = 0; ; attempt++) {
    const facts = await invokeOnRun('world.simulation-run.planning-facts', runId, { subjects: ['process-plant/plant%3Amaintenance/componentCoolingWaterPumpB'] }) as { items: Array<{ facts: Array<{ id: string; value: unknown }> }> }
    if (facts.items[0]!.facts.find(fact => fact.id.endsWith('/runningState'))!.value === false) break
    if (attempt === 200) throw new Error('World never reported the stopped pump')
    await Bun.sleep(20)
  }
  const before = await stack.store.read(workspaceId, planId)

  const refused = await room.call('planning.plan.create', { demoRun: runId })
  expect(refused.success).toBe(false)
  expect(refused.details?.code).toBe('demo_world_values_missing')
  expect(refused.error).toStartWith('demo_world_values_missing: ')
  expect(refused.data).toBeUndefined()
  expect(await stack.store.read(workspaceId, planId)).toEqual(before)
}, TIMEOUT_MS)

test('beside a delivery demo Run its guided plan Definition is in scope and creating returns that Run\'s plan', async () => {
  const deliveryRun = await stack.start('world.scenario', 'halden-delivery-planning', 'world.scenario.start')
  const deliveryRoom = await familyRoom('room-delivery', deliveryRun)
  const before = await deliveryRoom.listed()
  expect(planDefinitions(before).map(definition => [definition.target.ref.id, definition.links])).toEqual([
    ['halden-delivery-planning', [{ rel: ABOUT_RELATION, ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'halden-delivery-planning' } }]],
  ])
  expect(plans(before)).toEqual([])

  const created = await deliveryRoom.call('planning.plan.create', { demoRun: deliveryRun })
  expect(created.error).toBeUndefined()
  const deliveryPlanId: string = created.data.plan.id
  expect(created.data.target).toEqual(planTarget(deliveryPlanId))
  expect(plansAbout(await deliveryRoom.listed())).toEqual([aboutRun(deliveryPlanId, deliveryRun)])

  // The delivery plan is returned as stored when opened again (openGuidedDemo): nothing is read or written.
  const stored = await stack.store.read(workspaceId, deliveryPlanId)
  const reopened = await deliveryRoom.call('planning.plan.create', { demoRun: deliveryRun })
  expect(reopened.data.plan).toMatchObject({ id: deliveryPlanId, revision: stored.revision })
  expect(await stack.store.read(workspaceId, deliveryPlanId)).toEqual(stored)
}, TIMEOUT_MS)

test('beside a Train A Run no plan Definition is in scope and planning.plan.create cannot be called', async () => {
  const trainRun = await stack.start('world.scenario', 'train-a-work-week', 'world.scenario.start')
  const trainRoom = await familyRoom('room-train-a', trainRun)
  const listing = await trainRoom.listed()
  expect(listing.definitions.map(definition => `${definition.target.ref.type}/${definition.target.ref.id}`)).toEqual(['world.scenario/train-a-work-week'])
  expect(plans(listing)).toEqual([])
  expect(await trainRoom.unavailable(['planning.plan.create'])).toEqual(['planning.plan.create'])

  const stored = (await stack.store.list(workspaceId)).plans.map(plan => plan.id)
  const untargeted = await trainRoom.call('planning.plan.create', {})
  expect(untargeted.success).toBe(false)
  expect(untargeted.details?.code).toBe('target_required')
  // Naming a plan Definition the Workspace does publish does not help: it is not about this Run's Scenario.
  const everywhere = await stack.room('room-workspace').explore({ view: 'scope', moduleId: 'planning' }) as { data: Listing }
  for (const id of ['train-a-work-week', 'nuclear-maintenance-planning']) {
    const target = everywhere.data.definitions.find(definition => definition.target.ref.id === id)!.target
    const refused = await trainRoom.call('planning.plan.create', id === 'train-a-work-week' ? {} : { demoRun: trainRun }, { target })
    expect(refused.success).toBe(false)
    expect(refused.details?.code).toBe('target_out_of_scope')
  }
  expect((await stack.store.list(workspaceId)).plans.map(plan => plan.id)).toEqual(stored)
}, TIMEOUT_MS)
