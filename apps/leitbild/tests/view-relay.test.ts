import { describe, expect, test } from 'bun:test'
import { embeddedViewListingSchema, newWorkspaceId, type EmbeddedViewListing, type WorkspaceResourceReference } from '@leitbild/contracts'
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
const ready = { type: 'leitbild:view-window-ready' }

// Lets the relay's asynchronous Run check settle.
const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn += 1) await Promise.resolve() }

const harness = (options: { pane?: WorldPane; runs?: ReadonlyArray<string>; refusal?: string } = {}) => {
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
  }
  const runs = new Set(options.runs ?? [])
  const relay = createViewRelay({
    workspaceId: () => workspaceId,
    worldPane: () => state.pane,
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
  test.each(['absent', 'collapsed', 'shown'] as const)('a Room-owned calculation opens its owner view with the World pane %s, without selecting a Run', pane => {
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
