import { describe, expect, test } from 'bun:test'
import { ABOUT_RELATION, embeddedViewListingSchema, moduleResourceDescriptorSchema, newWorkspaceId, workspaceResourceReferenceSchema, type EmbeddedViewListing, type ModuleResourceDescriptor, type WorkspaceResourceReference } from '@leitbild/contracts'
import { createViewRelay, PENDING_VIEW_OPEN_MS, type WorldPane } from '../src/ui/view-relay.ts'

const workspaceId = newWorkspaceId()
const runRef = (id: string, inWorkspace: string = workspaceId) => ({ workspaceId: inWorkspace, moduleId: 'world', type: 'world.simulation-run', id })
const listing = (key: string, runId = 'run-1', inWorkspace: string = workspaceId) => ({
  key,
  envelope: {
    moduleId: 'world',
    viewType: 'process-plant.display',
    subject: runRef(runId, inWorkspace),
    title: `Display ${key}`,
    height: 300,
    state: '{"composition":{}}',
  },
  caption: 'Answer 14:02:31',
})
const views = (...listings: ReadonlyArray<ReturnType<typeof listing>>) => ({ type: 'leitbild:views', views: listings })
const open = <T>(view: T) => ({ type: 'leitbild:view-open', view })
const calculation = (inWorkspace: string = workspaceId) => embeddedViewListingSchema.parse({
  key: 'calculation-result',
  envelope: {
    moduleId: 'agents',
    viewType: 'engineering.result',
    subject: { workspaceId: inWorkspace, moduleId: 'agents', type: 'agents.room', id: 'research-room' },
    title: 'Thermal investigation',
    height: 650,
    state: JSON.stringify({ roomId: 'research-room', turnId: 'retained-turn', toolCallId: 'retained-call' }),
  },
  caption: 'Answer 14:02:31',
})
// A view of another Module whose subject, a plan, the catalogue may link as about a Run.
const planRef = (id = 'plan-1') => ({ workspaceId, moduleId: 'planning', type: 'planning.plan', id })
const schedule = (planId = 'plan-1') => embeddedViewListingSchema.parse({
  key: 'schedule',
  envelope: {
    moduleId: 'planning',
    viewType: 'planning.schedule',
    subject: planRef(planId),
    title: 'Finish by 20:00',
    height: 650,
    state: JSON.stringify({ plan: planId, option: 'deadline-20' }),
  },
  caption: 'Answer 14:02:31',
})
const listed = (ref: ReturnType<typeof runRef>, links: ReadonlyArray<{ readonly rel: string; readonly ref: ReturnType<typeof runRef> }> = []) =>
  moduleResourceDescriptorSchema.parse({ ref, title: `Resource ${ref.id}`, links, capabilityIds: [], observedAt: '2026-11-18T07:00:00.000Z' })
const about = (runId: string) => ({ rel: ABOUT_RELATION, ref: runRef(runId) })
const roomRef = { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'research-room' }
const ready = { type: 'leitbild:view-window-ready' }

// Lets the relay's asynchronous Run check settle.
const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn += 1) await Promise.resolve() }

const harness = (options: { pane?: WorldPane; runs?: ReadonlyArray<string>; refusal?: string; shownRun?: string | null; resources?: ReadonlyArray<ModuleResourceDescriptor> } = {}) => {
  const state = {
    pane: options.pane ?? 'shown' as WorldPane,
    world: [] as Array<{ readonly type: string; readonly views?: ReadonlyArray<{ readonly key: string }>; readonly view?: { readonly key: string } }>,
    agents: [] as Array<{ readonly type: string }>,
    errors: [] as string[],
    openedRuns: [] as string[],
    shownWorld: 0,
    maximised: [] as boolean[],
    timers: [] as Array<{ readonly ms: number; readonly expire: () => void; cancelled: boolean }>,
    runChecks: 0,
    owned: null as EmbeddedViewListing | null,
    // The catalogue the Host holds, which lists the calculation's Room as a Workspace lists every Room; a test's re-read replaces it.
    resources: options.resources ?? [listed(roomRef)],
    // Re-reads of the catalogue the relay asked for, each settled by its test.
    rereads: [] as Array<{ readonly done: () => void; readonly fail: (error: Error) => void }>,
  }
  const runs = new Set(options.runs ?? [])
  const relay = createViewRelay({
    workspaceId: () => workspaceId,
    worldPane: () => state.pane,
    // The composer names its Run whatever the pane's state; the relay judges the pane itself.
    shownRun: () => options.shownRun === null ? null : workspaceResourceReferenceSchema.parse(runRef(options.shownRun ?? 'run-1')),
    resources: () => state.resources,
    refreshResources: () => new Promise<void>((done, fail) => { state.rereads.push({ done, fail }) }),
    runRefusal: async (run: WorkspaceResourceReference) => {
      state.runChecks += 1
      if (options.refusal !== undefined) return options.refusal
      return run.workspaceId === workspaceId && run.type === 'world.simulation-run' && runs.has(run.id) ? null : 'The display\'s Run is not in this Workspace'
    },
    postToWorld: message => { state.world.push(message) },
    postToAgents: message => { state.agents.push(message) },
    showWorld: () => { state.shownWorld += 1; state.pane = 'shown' },
    maximiseWorld: maximised => { state.maximised.push(maximised) },
    openRun: runId => { state.openedRuns.push(runId); state.pane = 'shown' },
    openOwnedView: view => { state.owned = view },
    reportError: message => { state.errors.push(message) },
    startTimer: (ms, expire) => {
      const timer = { ms, expire, cancelled: false }
      state.timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const liveTimers = () => state.timers.filter(timer => !timer.cancelled)
  return { relay, state, liveTimers }
}

describe('process display relay', () => {
  test.each(['absent', 'behind-plans', 'collapsed', 'shown'] as const)('a Room-owned calculation opens its owner view with the World pane %s, without selecting a Run', pane => {
    const { relay, state, liveTimers } = harness({ pane })
    const received = calculation()
    relay.fromAgents(open(received))
    expect(state.owned).toEqual(received)
    expect(state.owned).not.toBe(received)
    expect(state.owned?.envelope.state).toBe(received.envelope.state)
    expect(state.runChecks).toBe(0)
    expect(state.openedRuns).toEqual([])
    expect(state.pane).toBe(pane)
    expect(state.shownWorld).toBe(0)
    expect(state.world).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('owner-view opening preserves opaque state and refuses foreign or malformed envelopes before framing them', () => {
    const { relay, state } = harness({ pane: 'absent' })
    const received = calculation()
    received.envelope.state = 'owner-defined state, not Host JSON'
    relay.fromAgents(open(received))
    expect(state.owned?.envelope.state).toBe(received.envelope.state)
    relay.fromAgents(open(calculation(newWorkspaceId())))
    relay.fromAgents(open({ ...received, envelope: { ...received.envelope, moduleId: 'world' } }))
    expect(state.owned).toEqual(received)
    expect(state.errors).toEqual([
      'Display could not be opened: it belongs to another Workspace',
      expect.stringContaining('An embedded view subject must belong to the publishing Module'),
    ])
    expect(state.runChecks).toBe(0)
  })

  test('opening an owner view supersedes both a pending World delivery and an asynchronous Run admission', async () => {
    const waiting = harness()
    waiting.relay.fromAgents(open(listing('old')))
    expect(waiting.liveTimers()).toHaveLength(1)
    waiting.relay.fromAgents(open(calculation()))
    expect(waiting.liveTimers()).toEqual([])
    waiting.relay.fromWorld(ready)
    expect(waiting.state.world).toEqual([views()])
    expect(waiting.state.owned).toEqual(calculation())

    const checking = harness({ pane: 'absent', runs: ['run-2'] })
    checking.relay.fromAgents(open(listing('old', 'run-2')))
    checking.relay.fromAgents(open(calculation()))
    await settle()
    expect(checking.state.openedRuns).toEqual([])
    expect(checking.state.owned).toEqual(calculation())
    expect(checking.liveTimers()).toEqual([])

    const refusing = harness({ pane: 'absent', refusal: 'Old Run is outside this Room' })
    refusing.relay.fromAgents(open(listing('old', 'run-2')))
    refusing.relay.fromAgents(open(calculation()))
    await settle()
    expect(refusing.state.errors).toEqual([])
    expect(refusing.state.owned).toEqual(calculation())
  })

  test('a later World open closes the owner view and follows the existing Run admission and ready handshake', async () => {
    const { relay, state } = harness({ pane: 'absent', runs: ['run-2'] })
    relay.fromAgents(open(calculation()))
    relay.fromAgents(open(listing('world', 'run-2')))
    await settle()
    expect(state.owned).toBeNull()
    expect(state.openedRuns).toEqual(['run-2'])
    expect(state.runChecks).toBe(1)
    relay.fromWorld(ready)
    expect(state.world.at(-1)).toEqual(open(listing('world', 'run-2')))
  })

  test.each(['shown', 'collapsed'] as const)('a view whose subject is about the Run in the %s World pane opens in that Run\'s window, not in a Host frame', pane => {
    const { relay, state, liveTimers } = harness({ pane, resources: [listed(runRef('run-1')), listed(planRef(), [about('run-1')])] })
    relay.fromWorld(ready)
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.world.at(-1)).toEqual(open(received))
    expect(state.world.at(-1)?.view).not.toBe(received)
    expect(state.owned).toBeNull()
    expect(state.shownWorld).toBe(pane === 'collapsed' ? 1 : 0)
    expect(state.pane).toBe('shown')
    expect(state.runChecks).toBe(0)
    expect(state.openedRuns).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('a view about the shown Run closes an open Host frame, waits for a World page that does not listen yet, and reports one that never answers', () => {
    const { relay, state, liveTimers } = harness({ resources: [listed(roomRef), listed(planRef(), [about('run-1')])] })
    relay.fromAgents(open(calculation()))
    expect(state.owned).toEqual(calculation())
    relay.fromAgents(open(schedule()))
    expect(state.owned).toBeNull()
    expect(state.world).toEqual([])
    expect(liveTimers()).toHaveLength(1)
    relay.fromWorld(ready)
    expect(state.world).toEqual([views(), open(schedule())])
    expect(liveTimers()).toEqual([])

    relay.worldFrameUnloaded()
    relay.fromAgents(open(schedule()))
    liveTimers()[0]?.expire()
    expect(state.errors).toEqual(['Display could not be opened: the World page did not answer within 30 s'])
    expect(state.owned).toBeNull()
    expect(state.rereads).toEqual([])
  })

  test('a view about a Run opens its owner view in a Host frame when the World pane is absent', () => {
    const { relay, state, liveTimers } = harness({ pane: 'absent', runs: ['run-1'], resources: [listed(runRef('run-1')), listed(planRef(), [about('run-1')])] })
    relay.fromWorld(ready)
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.owned).toEqual(received)
    expect(state.world).toEqual([views()])
    expect(state.runChecks).toBe(0)
    expect(state.openedRuns).toEqual([])
    expect(state.pane).toBe('absent')
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
    expect(state.rereads).toEqual([])
  })

  test('while the Run\'s plans show, a view about its plan opens in a Host frame over them and the simulation stays behind', () => {
    const { relay, state, liveTimers } = harness({ pane: 'behind-plans', runs: ['run-1'], resources: [listed(runRef('run-1')), listed(planRef(), [about('run-1')])] })
    relay.fromWorld(ready)
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.owned).toEqual(received)
    expect(state.world).toEqual([views()])
    expect(state.pane).toBe('behind-plans')
    expect(state.shownWorld).toBe(0)
    expect(state.runChecks).toBe(0)
    expect(state.openedRuns).toEqual([])
    expect(state.rereads).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('while the Run\'s plans show, a view of the Run brings its simulation back and opens in the window already loaded', () => {
    const { relay, state, liveTimers } = harness({ pane: 'behind-plans', runs: ['run-1'] })
    relay.fromWorld(ready)
    relay.fromAgents(open(calculation()))
    expect(state.owned).toEqual(calculation())
    relay.fromAgents(open(listing('a')))
    expect(state.shownWorld).toBe(1)
    expect(state.pane).toBe('shown')
    expect(state.owned).toBeNull()
    expect(state.world).toEqual([views(), open(listing('a'))])
    expect(state.runChecks).toBe(0)
    expect(state.openedRuns).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('while the Run\'s plans show, a subject\'s default display brings the simulation back too', () => {
    const { relay, state } = harness({ pane: 'behind-plans', runs: ['run-1'] })
    relay.fromWorld(ready)
    const received = { type: 'leitbild:view-subject-open', resource: runRef('run-1'), subject: 'plant:halden-2#auxFeedwaterValveA', title: 'Review: THROTTLE to 40 % AFW-A-CV' }
    relay.fromAgents(received)
    expect(state.shownWorld).toBe(1)
    expect(state.world.at(-1)).toEqual(received)
    expect(state.openedRuns).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('a World page loaded behind the plans that does not listen yet gets the Run\'s view once it says so', () => {
    const { relay, state, liveTimers } = harness({ pane: 'behind-plans', runs: ['run-1'] })
    relay.fromAgents(open(listing('a')))
    expect(state.shownWorld).toBe(1)
    expect(state.world).toEqual([])
    expect(liveTimers()).toHaveLength(1)
    relay.fromWorld(ready)
    expect(state.world).toEqual([views(), open(listing('a'))])
    expect(liveTimers()).toEqual([])
    expect(state.openedRuns).toEqual([])
  })

  test('a view whose subject the catalogue does not list never has it read again without a World pane and its Run', () => {
    for (const options of [{ pane: 'absent' as const, runs: ['run-1'] }, { pane: 'behind-plans' as const }, { shownRun: null }]) {
      const { relay, state, liveTimers } = harness({ ...options, resources: [] })
      const received = schedule()
      relay.fromAgents(open(received))
      expect(state.owned).toEqual(received)
      expect(state.rereads).toEqual([])
      expect(state.runChecks).toBe(0)
      expect(liveTimers()).toEqual([])
      expect(state.errors).toEqual([])
    }
  })

  test.each(['shown', 'collapsed'] as const)('a subject the catalogue does not list is read again once, and opens in the window of the Run in the %s World pane it is then about', async pane => {
    const { relay, state, liveTimers } = harness({ pane, resources: [listed(runRef('run-1'))] })
    relay.fromWorld(ready)
    relay.fromAgents(open(calculation()))
    expect(state.rereads).toHaveLength(1)
    state.rereads[0]?.done()
    await settle()
    expect(state.owned).toEqual(calculation())

    // The Assistant created the plan during the chat; the Host has not read the catalogue since.
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.rereads).toHaveLength(2)
    expect(state.owned).toEqual(calculation())
    expect(state.world).toEqual([views()])
    expect(liveTimers().map(timer => timer.ms)).toEqual([PENDING_VIEW_OPEN_MS])

    state.resources = [listed(runRef('run-1')), listed(planRef(), [about('run-1')])]
    state.rereads[1]?.done()
    await settle()
    expect(state.world).toEqual([views(), open(received)])
    expect(state.world.at(-1)?.view).not.toBe(received)
    expect(state.owned).toBeNull()
    expect(state.shownWorld).toBe(pane === 'collapsed' ? 1 : 0)
    expect(state.rereads).toHaveLength(2)
    expect(state.runChecks).toBe(0)
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])

    // Now listed: no further read.
    relay.fromAgents(open(received))
    expect(state.rereads).toHaveLength(2)
    expect(state.world).toHaveLength(3)
  })

  test.each([
    ['still does not list it', []],
    ['lists it about another Run', [listed(planRef(), [about('run-2')])]],
    ['lists it with no link to the shown Run', [listed(planRef(), [{ rel: 'copy-of', ref: runRef('run-1') }])]],
  ] as const)('a subject the catalogue does not list opens its owner view in a Host frame when the catalogue read again %s', async (_case, reread) => {
    const { relay, state, liveTimers } = harness({ resources: [] })
    relay.fromWorld(ready)
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.owned).toBeNull()
    state.resources = [...reread]
    state.rereads[0]?.done()
    await settle()
    expect(state.owned).toEqual(received)
    expect(state.world).toEqual([views()])
    expect(state.rereads).toHaveLength(1)
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('a catalogue that cannot be read again, or is not within 30 s, is reported and the view opens in a Host frame', async () => {
    const failing = harness({ resources: [] })
    const received = schedule()
    failing.relay.fromAgents(open(received))
    failing.state.rereads[0]?.fail(new Error('World answered HTTP 502'))
    await settle()
    expect(failing.state.errors).toEqual(['Display opened in its own frame, not in the Run\'s window: the Workspace\'s resources could not be read again: World answered HTTP 502'])
    expect(failing.state.owned).toEqual(received)
    expect(failing.state.world).toEqual([])
    expect(failing.liveTimers()).toEqual([])

    const silent = harness({ resources: [] })
    silent.relay.fromAgents(open(received))
    silent.liveTimers()[0]?.expire()
    expect(silent.state.errors).toEqual(['Display opened in its own frame, not in the Run\'s window: the Workspace\'s resources were not read again within 30 s'])
    expect(silent.state.owned).toEqual(received)
    // Its late answer opens nothing a second time.
    silent.state.resources = [listed(planRef(), [about('run-1')])]
    silent.state.rereads[0]?.done()
    await settle()
    expect(silent.state.world).toEqual([])
    expect(silent.state.owned).toEqual(received)
    expect(silent.state.errors).toHaveLength(1)
  })

  test('opens that arrive while the catalogue is read again wait behind it, are handled in arrival order, each once, and start no second read', async () => {
    const { relay, state, liveTimers } = harness({ runs: ['run-1'], resources: [listed(roomRef)] })
    relay.fromWorld(ready)
    const first = schedule('plan-1'), second = { ...schedule('plan-2'), key: 'schedule-2' }
    relay.fromAgents(open(first))
    relay.fromAgents(open(second))
    relay.fromAgents(open(listing('own', 'run-1')))
    relay.fromAgents(open(calculation()))
    expect(state.rereads).toHaveLength(1)
    expect(state.world).toEqual([views()])
    expect(state.owned).toBeNull()

    state.resources = [listed(roomRef), listed(planRef('plan-1'), [about('run-1')]), listed(planRef('plan-2'), [about('run-1')])]
    state.rereads[0]?.done()
    await settle()
    expect(state.world).toEqual([views(), open(first), open(second), open(listing('own', 'run-1'))])
    expect(state.owned).toEqual(calculation())
    expect(state.rereads).toHaveLength(1)
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('an open behind a running read whose subject that read does not list opens in a Host frame without a second read', async () => {
    const { relay, state } = harness({ resources: [] })
    relay.fromWorld(ready)
    const first = schedule('plan-1'), second = { ...schedule('plan-2'), key: 'schedule-2' }
    relay.fromAgents(open(first))
    relay.fromAgents(open(second))
    state.resources = [listed(planRef('plan-1'), [about('run-1')])]
    state.rereads[0]?.done()
    await settle()
    expect(state.world).toEqual([views(), open(first)])
    expect(state.owned).toEqual(embeddedViewListingSchema.parse(second))
    expect(state.rereads).toHaveLength(1)
    expect(state.errors).toEqual([])
  })

  test.each(['agentsFrameUnloaded', 'agentsFrameLoaded', 'dispose'] as const)('%s drops the opens that wait for the catalogue, so its late answer opens nothing', async lifecycle => {
    const { relay, state, liveTimers } = harness({ resources: [] })
    relay.fromWorld(ready)
    relay.fromAgents(open(schedule()))
    expect(liveTimers()).toHaveLength(1)
    relay[lifecycle]()
    expect(liveTimers()).toEqual([])
    state.resources = [listed(planRef(), [about('run-1')])]
    state.rereads[0]?.done()
    await settle()
    expect(state.world.filter(message => message.type === 'leitbild:view-open')).toEqual([])
    expect(state.owned).toBeNull()
    expect(state.errors).toEqual([])
  })

  test.each([
    ['is about another Run', [listed(planRef(), [about('run-2')])], 'run-1'],
    ['is about a Run while the pane names none', [listed(planRef(), [about('run-1')])], null],
    ['is linked to the shown Run by another relation', [listed(planRef(), [{ rel: 'copy-of', ref: runRef('run-1') }])], 'run-1'],
    ['has no links', [listed(planRef())], 'run-1'],
  ] as const)('a view whose listed subject %s opens its owner view in a Host frame beside the shown World pane, with no read of the catalogue', (_case, resources, shownRun) => {
    const { relay, state, liveTimers } = harness({ resources: [...resources], shownRun })
    relay.fromWorld(ready)
    const received = schedule()
    relay.fromAgents(open(received))
    expect(state.owned).toEqual(received)
    expect(state.world).toEqual([views()])
    expect(state.shownWorld).toBe(0)
    expect(state.rereads).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual([])
  })

  test.each(['collapsed', 'shown'] as const)('an engineering result of a Room still opens in a Host frame with the World pane %s, whatever else is about its Run', pane => {
    const { relay, state } = harness({ pane, resources: [
      listed(planRef(), [about('run-1')]),
      listed(roomRef, [{ rel: 'scope-resource', ref: runRef('run-1') }]),
    ] })
    relay.fromWorld(ready)
    relay.fromAgents(open(schedule()))
    expect(state.world.at(-1)).toEqual(open(schedule()))
    relay.fromAgents(open(calculation()))
    expect(state.owned).toEqual(calculation())
    expect(state.world).toHaveLength(2)
    expect(state.shownWorld).toBe(pane === 'collapsed' ? 1 : 0)
    expect(state.errors).toEqual([])
  })

  test.each(['agentsFrameUnloaded', 'agentsFrameLoaded', 'dispose'] as const)('%s closes an owner view and prevents an older Run check from reopening its old context', async lifecycle => {
    const { relay, state, liveTimers } = harness({ pane: 'absent', runs: ['run-2'] })
    relay.fromAgents(open(calculation()))
    relay[lifecycle]()
    expect(state.owned).toBeNull()
    relay.fromAgents(open(listing('old', 'run-2')))
    relay[lifecycle]()
    await settle()
    expect(state.openedRuns).toEqual([])
    expect(liveTimers()).toEqual([])

    const waiting = harness()
    waiting.relay.fromAgents(open(listing('old')))
    expect(waiting.liveTimers()).toHaveLength(1)
    waiting.relay[lifecycle]()
    expect(waiting.liveTimers()).toEqual([])
    waiting.relay.fromWorld(ready)
    expect(waiting.state.world).toEqual([views()])
  })

  test('keeps the latest Agents list and relays it once World listens, and again on every ready', () => {
    const { relay, state } = harness()
    relay.fromAgents(views(listing('a')))
    relay.fromAgents(views(listing('a'), listing('b')))
    expect(state.world).toEqual([])

    relay.fromWorld(ready)
    expect(state.world).toEqual([{ type: 'leitbild:views', views: [listing('a'), listing('b')] }])

    relay.fromAgents(views(listing('b')))
    expect(state.world.at(-1)).toEqual({ type: 'leitbild:views', views: [listing('b')] })

    relay.worldFrameUnloaded()
    relay.fromAgents(views(listing('c')))
    expect(state.world).toHaveLength(2)
    relay.fromWorld(ready)
    expect(state.world.at(-1)).toEqual({ type: 'leitbild:views', views: [listing('c')] })
    expect(state.errors).toEqual([])
  })

  test('posts freshly parsed plain messages, never the received objects', () => {
    const { relay, state } = harness()
    relay.fromWorld(ready)
    const received = open(listing('a'))
    relay.fromAgents(received)
    const posted = state.world.at(-1)
    expect(posted).toEqual(received)
    expect(posted?.view).not.toBe(received.view)
    expect(structuredClone(posted)).toEqual(received)
  })

  test('relays an open at once to a listening World and keeps it pending otherwise', () => {
    const { relay, state, liveTimers } = harness()
    relay.fromWorld(ready)
    relay.fromAgents(open(listing('a')))
    expect(state.world.at(-1)).toEqual(open(listing('a')))
    expect(liveTimers()).toEqual([])

    relay.worldFrameUnloaded()
    relay.fromAgents(views(listing('a'), listing('b')))
    relay.fromAgents(open(listing('b')))
    expect(state.world).toHaveLength(2)
    expect(liveTimers()).toHaveLength(1)
    expect(liveTimers()[0]?.ms).toBe(PENDING_VIEW_OPEN_MS)

    relay.fromWorld(ready)
    expect(state.world.slice(2)).toEqual([views(listing('a'), listing('b')), open(listing('b'))])
    expect(liveTimers()).toEqual([])
    relay.fromWorld(ready)
    expect(state.world.slice(4)).toEqual([views(listing('a'), listing('b'))])
  })

  test('keeps only the latest pending open', () => {
    const { relay, state, liveTimers } = harness()
    relay.fromAgents(open(listing('a')))
    relay.fromAgents(open(listing('b')))
    expect(state.timers.map(timer => timer.cancelled)).toEqual([true, false])
    relay.fromWorld(ready)
    expect(state.world).toEqual([views(), open(listing('b'))])
    expect(liveTimers()).toEqual([])
  })

  test('reports a pending open that World did not take within 30 s, and then forgets it', () => {
    const { relay, state, liveTimers } = harness()
    relay.fromAgents(open(listing('a')))
    liveTimers()[0]?.expire()
    expect(state.errors).toEqual(['Display could not be opened: the World page did not answer within 30 s'])
    relay.fromWorld(ready)
    expect(state.world).toEqual([views()])
  })

  test('brings a collapsed World pane back before showing the display', () => {
    const { relay, state } = harness({ pane: 'collapsed' })
    relay.fromWorld(ready)
    relay.fromAgents(open(listing('a')))
    expect(state.shownWorld).toBe(1)
    expect(state.world.at(-1)).toEqual(open(listing('a')))
  })

  test('shows a display of another Run in the shown World pane without switching Runs', () => {
    const { relay, state } = harness({ runs: ['run-1', 'run-2'] })
    relay.fromWorld(ready)
    relay.fromAgents(open(listing('a', 'run-2')))
    expect(state.openedRuns).toEqual([])
    expect(state.world.at(-1)).toEqual(open(listing('a', 'run-2')))
  })

  test('without a World pane opens the display\'s Run beside the chat and shows the display once World listens', async () => {
    const { relay, state, liveTimers } = harness({ pane: 'absent', runs: ['run-2'] })
    relay.fromAgents(views(listing('a', 'run-2')))
    relay.fromAgents(open(listing('a', 'run-2')))
    await settle()
    expect(state.openedRuns).toEqual(['run-2'])
    expect(liveTimers()).toHaveLength(1)

    relay.worldFrameUnloaded()
    relay.fromWorld(ready)
    expect(state.world).toEqual([views(listing('a', 'run-2')), open(listing('a', 'run-2'))])
    expect(state.errors).toEqual([])
  })

  test('never opens a Run this Workspace does not list', async () => {
    const { relay, state, liveTimers } = harness({ pane: 'absent', runs: ['run-1'] })
    relay.fromAgents(open(listing('a', 'missing')))
    await settle()
    expect(state.openedRuns).toEqual([])
    expect(liveTimers()).toEqual([])
    expect(state.errors).toEqual(['The display\'s Run is not in this Workspace'])
  })

  test('says why a Run may not be opened beside the chat instead of closing the chat', async () => {
    const { relay, state } = harness({ pane: 'absent', refusal: 'The display\'s Run is outside this room\'s scope' })
    relay.fromAgents(open(listing('a', 'run-2')))
    await settle()
    expect(state.openedRuns).toEqual([])
    expect(state.errors).toEqual(['The display\'s Run is outside this room\'s scope'])
  })

  test('only the latest open acts once its Run check settles, and a pane opened meanwhile takes it', async () => {
    const { relay, state } = harness({ pane: 'absent', runs: ['run-2', 'run-3'] })
    relay.fromAgents(open(listing('a', 'run-2')))
    relay.fromAgents(open(listing('b', 'run-3')))
    await settle()
    expect(state.openedRuns).toEqual(['run-3'])
    expect(state.runChecks).toBe(2)

    const other = harness({ pane: 'absent', runs: ['run-2'] })
    other.relay.fromWorld(ready)
    other.relay.fromAgents(open(listing('a', 'run-2')))
    other.state.pane = 'shown'
    await settle()
    expect(other.state.openedRuns).toEqual([])
    expect(other.state.world.at(-1)).toEqual(open(listing('a', 'run-2')))
  })

  // Q23: a subject's default display (a proposal's element) is relayed exactly as an open.
  const subjectOpen = (runId = 'run-1', inWorkspace: string = workspaceId, subject = 'plant:halden-2#auxFeedwaterValveA') =>
    ({ type: 'leitbild:view-subject-open', resource: runRef(runId, inWorkspace), subject, title: 'Review: THROTTLE to 40 % AFW-A-CV' })

  test('relays a subject open to a listening World as freshly parsed plain data, and keeps it pending otherwise', () => {
    const { relay, state, liveTimers } = harness()
    relay.fromWorld(ready)
    const received = subjectOpen()
    relay.fromAgents(received)
    expect(state.world.at(-1)).toEqual(received)
    expect(state.world.at(-1)).not.toBe(received)
    relay.worldFrameUnloaded()
    relay.fromAgents(subjectOpen())
    expect(liveTimers()).toHaveLength(1)
    relay.fromWorld(ready)
    expect(state.world.slice(-2)).toEqual([views(), subjectOpen()])
    expect(state.errors).toEqual([])
  })

  test('refuses a subject open about another Workspace, or with no item named, and says why', () => {
    const { relay, state } = harness()
    relay.fromWorld(ready)
    relay.fromAgents(subjectOpen('run-1', newWorkspaceId()))
    relay.fromAgents(subjectOpen('run-1', workspaceId, 'plant:halden-2'))
    expect(state.world).toEqual([views()])
    expect(state.errors).toEqual(['Display could not be opened: it belongs to another Workspace', 'Display could not be opened: subject: A subject is <objectId>#<item>'])
  })

  test('without a World pane opens the subject\'s Run beside the chat, and never one this Workspace does not list', async () => {
    const opened = harness({ pane: 'absent', runs: ['run-2'] })
    opened.relay.fromAgents(subjectOpen('run-2'))
    await settle()
    expect(opened.state.openedRuns).toEqual(['run-2'])
    opened.relay.fromWorld(ready)
    expect(opened.state.world.at(-1)).toEqual(subjectOpen('run-2'))

    const refused = harness({ pane: 'absent', runs: ['run-1'] })
    refused.relay.fromAgents(subjectOpen('missing'))
    await settle()
    expect(refused.state.openedRuns).toEqual([])
    expect(refused.state.errors).toEqual(['The display\'s Run is not in this Workspace'])
  })

  test('refuses invalid or foreign messages visibly and keeps the previous list', () => {
    const { relay, state } = harness({ runs: ['run-1'] })
    relay.fromWorld(ready)
    relay.fromAgents(views(listing('a')))
    const posted = state.world.length

    relay.fromAgents(views(listing('b'), listing('b')))
    relay.fromAgents({ type: 'leitbild:view-open', view: { ...listing('d'), caption: '' } })
    relay.fromAgents(open(listing('e', 'run-1', newWorkspaceId())))
    relay.fromAgents({ ...open(listing('f')), extra: true })
    relay.fromAgents(ready)
    relay.fromWorld(views(listing('g')))
    relay.fromWorld({ type: 'leitbild:view-window-maximise', maximised: 'yes' })

    expect(state.errors).toEqual([
      'Display list refused: views.1.key: Listed view keys must be unique',
      expect.stringMatching(/^Display could not be opened: view\.caption: /),
      'Display could not be opened: it belongs to another Workspace',
      expect.stringMatching(/^Display could not be opened: /),
      'Display message refused: the Agents page does not send leitbild:view-window-ready',
      'Display message refused: the World page does not send leitbild:views',
      expect.stringMatching(/^Display window message refused: maximised: /),
    ])
    expect(state.world).toHaveLength(posted)
    relay.fromWorld(ready)
    expect(state.world.at(-2)).toEqual(views(listing('a')))
  })

  test('leaves a display about another Workspace out on its own and relays the rest of the list', () => {
    const { relay, state } = harness({ runs: ['run-1'] })
    relay.fromWorld(ready)
    relay.fromAgents(views(listing('a'), listing('c', 'run-1', newWorkspaceId()), listing('d')))
    expect(state.errors).toEqual(['Display list: a display belongs to another Workspace and was left out'])
    expect(state.world.at(-1)).toEqual(views(listing('a'), listing('d')))
  })

  test('leaves messages outside the window protocol to others', () => {
    const { relay, state } = harness()
    relay.fromAgents({ type: 'leitbild:subject-focus', subjects: [] })
    relay.fromAgents('ping')
    relay.fromWorld(null)
    relay.fromWorld({ type: 'leitbild:scenario-dirty', dirty: true })
    expect(state.errors).toEqual([])
    expect(state.world).toEqual([])
  })

  test('announces the Host to each Agents document and clears the list when it goes', () => {
    const { relay, state } = harness()
    relay.fromWorld(ready)
    relay.agentsFrameLoaded()
    expect(state.agents).toEqual([{ type: 'leitbild:view-host' }])
    expect(state.world).toEqual([views()])

    relay.fromAgents(views(listing('a')))
    relay.agentsFrameLoaded()
    expect(state.world.slice(1)).toEqual([views(listing('a')), views()])
    expect(state.agents).toHaveLength(2)

    relay.fromAgents(views(listing('b')))
    relay.agentsFrameUnloaded()
    relay.agentsFrameUnloaded()
    expect(state.world.slice(3)).toEqual([views(listing('b')), views()])
  })

  test('passes the window\'s maximise requests on and restores the split when its World document goes', () => {
    const { relay, state } = harness()
    relay.fromWorld({ type: 'leitbild:view-window-maximise', maximised: true })
    relay.fromWorld({ type: 'leitbild:view-window-maximise', maximised: false })
    relay.worldFrameUnloaded()
    expect(state.maximised).toEqual([true, false, false])
  })

  test('a pending open outlives a World document change and is cancelled on dispose', () => {
    const { relay, state, liveTimers } = harness()
    relay.fromAgents(open(listing('a')))
    relay.worldFrameUnloaded()
    expect(liveTimers()).toHaveLength(1)
    relay.dispose()
    expect(liveTimers()).toEqual([])
    relay.fromWorld(ready)
    expect(state.world).toEqual([views()])
  })
})
